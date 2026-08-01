/**
 * When a meeting happened, how precisely that is known, and where the knowledge
 * came from — modelled as three separate facts rather than one nullable date.
 *
 * The bug this replaces: `confirmed_event_date` was mandatory, so a consultant
 * holding a Teams export with no reliable date had to type one. And the typed
 * value was then ignored — precedence read the immutable, evidence-derived
 * `source_documents.event_date`, which is NULL for a real Teams export, and
 * silently fell back to `created_at`. A source could become precedent purely by
 * being uploaded second.
 *
 * Three rules follow from that and are enforced here rather than at the call
 * sites:
 *
 *   1. Upload time is never meeting precedence. `created_at` appears nowhere in
 *      this module.
 *   2. Unknown is a real answer, not a missing one. It is never silently
 *      replaced by an inferred date.
 *   3. What cannot be ordered is reported as unordered, never guessed. Two
 *      sources whose intervals overlap — including "unknown", which is the
 *      interval covering all time — compare as `unresolved`, and the caller
 *      holds the operation for review.
 *
 * Everything here is a pure function of stored values: no clock, no filesystem,
 * no database, no model.
 */

/** How well the meeting date is known. */
export type ChronologyState = 'confirmed' | 'approximate' | 'unknown';

/** How precisely the value locates the meeting in time. */
export type ChronologyPrecision = 'exact-datetime' | 'date' | 'month' | 'range' | 'none';

/**
 * Where the value came from.
 *
 * Only `human-confirmed` is an assertion by a person. `transcript-header` is
 * evidence from the source itself. The two `*-suggestion` values exist so a
 * prefill can be DISPLAYED as a suggestion and can never be mistaken for a
 * confirmation once stored; nothing in the product may write a suggestion basis
 * without a human accepting it.
 */
export type ChronologyBasis =
  | 'human-confirmed'
  | 'transcript-header'
  | 'filename-suggestion'
  | 'file-timestamp-suggestion'
  | 'absent';

export const CHRONOLOGY_STATES: readonly ChronologyState[] = ['confirmed', 'approximate', 'unknown'];
export const CHRONOLOGY_PRECISIONS: readonly ChronologyPrecision[] = ['exact-datetime', 'date', 'month', 'range', 'none'];
export const CHRONOLOGY_BASES: readonly ChronologyBasis[] = ['human-confirmed', 'transcript-header', 'filename-suggestion', 'file-timestamp-suggestion', 'absent'];

/** A basis that only ever suggests. Storing one as though it were confirmed is refused. */
export const SUGGESTION_BASES: readonly ChronologyBasis[] = ['filename-suggestion', 'file-timestamp-suggestion'];

export interface SourceChronology {
  state: ChronologyState;
  precision: ChronologyPrecision;
  basis: ChronologyBasis;
  /** Point date, `YYYY-MM-DD`. Null when the state is unknown or the value is a range. */
  date: string | null;
  /** `HH:MM`, only meaningful at `exact-datetime` precision. */
  time: string | null;
  timezone: string | null;
  /** Inclusive bounds, `YYYY-MM-DD`, used at `month` and `range` precision. */
  rangeStart: string | null;
  rangeEnd: string | null;
}

export const UNKNOWN_CHRONOLOGY: SourceChronology = {
  state: 'unknown', precision: 'none', basis: 'absent',
  date: null, time: null, timezone: null, rangeStart: null, rangeEnd: null,
};

export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

export function isIsoMonth(value: string): boolean {
  return /^\d{4}-\d{2}$/.test(value) && Number(value.slice(5, 7)) >= 1 && Number(value.slice(5, 7)) <= 12;
}

function isClockTime(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

/** Last calendar day of an ISO month, so a `month` precision expands to a closed interval. */
export function lastDayOfMonth(month: string): string {
  const year = Number(month.slice(0, 4));
  const index = Number(month.slice(5, 7));
  const day = new Date(Date.UTC(year, index, 0)).getUTCDate();
  return `${month}-${String(day).padStart(2, '0')}`;
}

/**
 * The closed interval `[start, end]` in which the meeting certainly occurred,
 * or null when nothing is known.
 *
 * This is the whole ordering model. A point date is the interval covering that
 * day; an exact datetime is the instant; a month is the whole month; a range is
 * itself. Unknown has NO interval — deliberately not "all time as an interval",
 * because a caller must distinguish "overlaps everything" from "we know nothing"
 * when explaining itself to a human.
 */
export function chronologyInterval(chronology: SourceChronology): { start: string; end: string } | null {
  if (chronology.state === 'unknown') return null;
  if (chronology.precision === 'range' || chronology.precision === 'month') {
    if (!chronology.rangeStart || !chronology.rangeEnd) return null;
    return { start: `${chronology.rangeStart}T00:00:00.000Z`, end: `${chronology.rangeEnd}T23:59:59.999Z` };
  }
  if (!chronology.date) return null;
  if (chronology.precision === 'exact-datetime' && chronology.time) {
    const instant = `${chronology.date}T${chronology.time}:00.000Z`;
    return { start: instant, end: instant };
  }
  return { start: `${chronology.date}T00:00:00.000Z`, end: `${chronology.date}T23:59:59.999Z` };
}

export type ChronologyOrder = 'before' | 'after' | 'same' | 'unresolved';

/**
 * Order two sources by when their meetings happened.
 *
 * Strict separation only: `a` is before `b` when a's interval ENDS before b's
 * interval STARTS. Anything else — overlap, identical intervals, either side
 * unknown — is `unresolved` and must be held for human review. This is what
 * stops "3 August" and "some time in August" from being silently ordered, and
 * what stops an unknown-date source from declaring itself later than a dated
 * one.
 */
export function compareChronology(a: SourceChronology, b: SourceChronology): ChronologyOrder {
  const left = chronologyInterval(a);
  const right = chronologyInterval(b);
  if (!left || !right) return 'unresolved';
  if (left.end < right.start) return 'before';
  if (right.end < left.start) return 'after';
  if (left.start === right.start && left.end === right.end) {
    // Identical instants are only genuinely "the same moment" at datetime
    // precision. Two sources sharing a whole day are same-day ambiguity, which
    // the existing reconciliation already treats as a conflict rather than a
    // guessed winner.
    return a.precision === 'exact-datetime' && b.precision === 'exact-datetime' ? 'same' : 'unresolved';
  }
  return 'unresolved';
}

/**
 * The instant after which a HUMAN edit outranks this source.
 *
 * Deliberately different from source-versus-source ordering. A human edit is
 * recorded by a person who has already seen the project, so when a source's own
 * chronology is unknown the conservative answer is that the human wins: this
 * returns the start of time, which every real event postdates. That protects a
 * human correction from being reverted by an undateable transcript without
 * inventing a date for it.
 *
 * The previous implementation returned `created_at` here, which is what leaked
 * upload time into meeting precedence. Upload time is not a meeting time and is
 * never used.
 */
export function humanPrecedenceInstant(chronology: SourceChronology): string {
  const interval = chronologyInterval(chronology);
  return interval ? interval.end : '0000-01-01T00:00:00.000Z';
}

export interface ChronologyInput {
  state: ChronologyState;
  precision?: ChronologyPrecision | null;
  basis?: ChronologyBasis | null;
  date?: string | null;
  time?: string | null;
  timezone?: string | null;
  rangeStart?: string | null;
  rangeEnd?: string | null;
}

/**
 * Validate and normalise a chronology assertion.
 *
 * Throws with a message a consultant can act on rather than storing something
 * incoherent. The rules that matter:
 *
 *  - `unknown` carries no date at all. A caller that sends `unknown` with a date
 *    is refused, so unknown can never be quietly upgraded into a value.
 *  - `confirmed`/`approximate` must carry a value matching their precision.
 *  - a suggestion basis may never be stored as `confirmed`: a filename or a file
 *    timestamp is not a person confirming anything.
 */
export function normaliseChronology(input: ChronologyInput): SourceChronology {
  const state = input.state;
  if (!CHRONOLOGY_STATES.includes(state)) throw new Error(`Unknown chronology state "${state}".`);

  if (state === 'unknown') {
    if (input.date || input.rangeStart || input.rangeEnd) {
      throw new Error('An unknown meeting date cannot also carry a date or range; choose a state that matches what is known.');
    }
    return { ...UNKNOWN_CHRONOLOGY, basis: input.basis && CHRONOLOGY_BASES.includes(input.basis) ? input.basis : 'absent' };
  }

  const basis = input.basis ?? 'human-confirmed';
  if (!CHRONOLOGY_BASES.includes(basis)) throw new Error(`Unknown chronology basis "${basis}".`);
  if (basis === 'absent') throw new Error('A known meeting date must record where it came from.');
  if (state === 'confirmed' && SUGGESTION_BASES.includes(basis)) {
    throw new Error('A filename or file timestamp is only a suggestion; it cannot be recorded as a confirmed meeting date. Confirm the date explicitly or select Unknown.');
  }

  const precision = input.precision ?? 'date';
  if (!CHRONOLOGY_PRECISIONS.includes(precision)) throw new Error(`Unknown chronology precision "${precision}".`);
  if (precision === 'none') throw new Error('A known meeting date must state its precision.');

  if (precision === 'range' || precision === 'month') {
    let start = input.rangeStart ?? null;
    let end = input.rangeEnd ?? null;
    // A month is entered as `YYYY-MM` and expands to the closed interval of that
    // month, so ordering never has to special-case it later.
    if (precision === 'month' && start && isIsoMonth(start)) {
      end = lastDayOfMonth(start);
      start = `${start}-01`;
    }
    if (!start || !end || !isIsoDate(start) || !isIsoDate(end)) {
      throw new Error(`A ${precision} meeting date needs a start and end, as YYYY-MM-DD.`);
    }
    if (start > end) throw new Error('The meeting date range ends before it starts.');
    return { state, precision, basis, date: null, time: null, timezone: input.timezone?.trim() || null, rangeStart: start, rangeEnd: end };
  }

  const date = input.date?.trim() ?? '';
  if (!isIsoDate(date)) throw new Error('Meeting date must be a real date, as YYYY-MM-DD — or select Unknown.');
  const time = input.time?.trim() || null;
  if (precision === 'exact-datetime') {
    if (!time || !isClockTime(time)) throw new Error('An exact meeting time must be given as HH:MM.');
  }
  return {
    state, precision, basis, date,
    time: precision === 'exact-datetime' ? time : time && isClockTime(time) ? time : null,
    timezone: input.timezone?.trim() || null,
    rangeStart: null, rangeEnd: null,
  };
}

/** Read a source row's stored chronology. Tolerates a pre-migration row by reporting it unknown rather than guessing. */
export function chronologyFromRow(row: Record<string, unknown>): SourceChronology {
  const state = String(row.chronology_state ?? 'unknown') as ChronologyState;
  if (!CHRONOLOGY_STATES.includes(state) || state === 'unknown') {
    return { ...UNKNOWN_CHRONOLOGY, basis: CHRONOLOGY_BASES.includes(String(row.chronology_basis ?? 'absent') as ChronologyBasis) ? String(row.chronology_basis) as ChronologyBasis : 'absent' };
  }
  return {
    state,
    precision: String(row.chronology_precision ?? 'date') as ChronologyPrecision,
    basis: String(row.chronology_basis ?? 'human-confirmed') as ChronologyBasis,
    date: row.confirmed_event_date ? String(row.confirmed_event_date) : null,
    time: row.event_time ? String(row.event_time) : null,
    timezone: row.timezone ? String(row.timezone) : null,
    rangeStart: row.chronology_range_start ? String(row.chronology_range_start) : null,
    rangeEnd: row.chronology_range_end ? String(row.chronology_range_end) : null,
  };
}

/** One line a consultant can read, used in the Inbox, the source detail panel and every held-conflict reason. */
export function describeChronology(chronology: SourceChronology): string {
  switch (chronology.state) {
    case 'unknown':
      return 'Meeting date unknown';
    case 'approximate':
      return chronology.precision === 'month' || chronology.precision === 'range'
        ? `Approximately ${chronology.rangeStart} to ${chronology.rangeEnd}`
        : `Approximately ${chronology.date}`;
    default:
      return chronology.precision === 'exact-datetime' && chronology.time
        ? `${chronology.date} ${chronology.time}${chronology.timezone ? ` ${chronology.timezone}` : ''}`
        : chronology.precision === 'month' || chronology.precision === 'range'
          ? `${chronology.rangeStart} to ${chronology.rangeEnd}`
          : String(chronology.date);
  }
}

/** The label shown wherever an operation is held because two sources cannot be ordered. */
export const CHRONOLOGY_UNRESOLVED_LABEL = 'Chronology unresolved';

/**
 * Explain, in one sentence, why these two sources cannot be ordered — used
 * verbatim as a held operation's reason so a reviewer never has to open the
 * database to understand the hold.
 */
export function describeUnresolved(subject: SourceChronology, other: SourceChronology, otherLabel: string): string {
  if (subject.state === 'unknown' && other.state === 'unknown') {
    return `${CHRONOLOGY_UNRESOLVED_LABEL}: neither this source nor ${otherLabel} has a known meeting date, so neither can be treated as later.`;
  }
  if (subject.state === 'unknown') {
    return `${CHRONOLOGY_UNRESOLVED_LABEL}: this source has no known meeting date, so it cannot be treated as later than ${otherLabel} (${describeChronology(other)}).`;
  }
  if (other.state === 'unknown') {
    return `${CHRONOLOGY_UNRESOLVED_LABEL}: ${otherLabel} has no known meeting date, so this source (${describeChronology(subject)}) cannot be treated as later than it.`;
  }
  return `${CHRONOLOGY_UNRESOLVED_LABEL}: this source (${describeChronology(subject)}) and ${otherLabel} (${describeChronology(other)}) overlap in time, so neither can be treated as later.`;
}

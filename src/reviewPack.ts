/**
 * The consultant review pack: deterministic reconciliation and presentation
 * over an already-applied register.
 *
 * This module makes no database and no provider call. It takes a plain input
 * object — records already read out of the applied register — and returns
 * markdown. That is what makes it testable with synthetic fixtures rather than
 * with customer content, and what keeps `providerCalls` structurally zero
 * rather than merely zero by convention.
 *
 * What it exists to fix, in the order the problems bite:
 *
 *   1. A question the register itself already answered must not be put in
 *      front of the consultant as something to ask.
 *   2. A section must mean what its title says. "Customer dependencies" that
 *      silently includes the consultant's own implementation tasks is worse
 *      than no section at all, because it is confidently wrong.
 *   3. One record, one home. Repeating a record in full across four sections
 *      buries the ten things that matter under sixty that do not.
 *   4. Extracted state is a photograph of one meeting, not the present truth.
 *      Anything dated or statused must say so.
 */

/* ------------------------------------------------------------------ inputs */

export interface ReviewPackAnchor {
  segmentSeq: number | null;
  speaker: string | null;
  tMs: number | null;
  quote: string | null;
  /** Whether the quote was mechanically confirmed against the source. */
  verified: boolean;
  /**
   * The anchor quote widened with its adjacent normalised segments, when the
   * source had them. A single segment is often half a sentence; the widened
   * form is what makes the evidence support the whole claim.
   */
  context: string | null;
}

export interface ReviewPackRecord {
  id: string;
  registerName: string;
  title: string;
  summary: string;
  status: string;
  owner: string | null;
  dueDate: string | null;
  overdue: boolean;
  blocking: boolean;
  conflict: boolean;
  severity: string | null;
  band: string;
  score: number;
  themeLabel: string | null;
  relatedIds: string[];
  anchors: ReviewPackAnchor[];
  /** Open-question typed detail, when this record is an Open_Questions row. */
  unblockedBy?: string | null;
  parkedWith?: string | null;
  /** True when the deterministic consultant views selected this record. */
  selected: boolean;
}

export interface ReviewPackInput {
  generatedAt: string;
  changesetId: string;
  isolatedDbPath: string;
  sourceDbPath: string;
  sourceLabel: string;
  sourceEventDate: string | null;
  /**
   * Names that mean "the consultant". Passed in rather than inferred: the
   * project's configured owner is a single short name ("Warwick") while the
   * register carries "Warwick Allan", "Warwick (proposed)" and
   * "Warwick (send); Tony and Ashley (distribute)". Exact-matching that one
   * configured string is what put the consultant's own work under customer
   * dependencies.
   */
  consultantAliases: string[];
  records: ReviewPackRecord[];
  providerCalls: 0;
}

/* -------------------------------------------------------------- ownership */

export type Ownership = 'consultant' | 'customer' | 'shared' | 'unowned';

/** Owner strings that name no one. Not a person, so not a dependency. */
const NON_OWNER = /^(|-|n\/a|na|none|tbc|tbd|unassigned|unknown|unowned|not stated|all|everyone|accepted constraint)$/;

const OWNER_SPLIT = /\s*(?:\/|;|,|\band\b|&|\+)\s*/i;

function normalizeOwnerPart(part: string): string {
  return part
    // Drop role qualifiers: "Warwick (proposed)" and "Warwick" are the same
    // person wearing the same hat as far as who must act is concerned.
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(raised|proposed|expected|target|owner|send|distribute|configure|obtain|endorsed|mechanism|recommendation)\b/gi, ' ')
    .replace(/[^A-Za-z\s'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Split a free-text owner into the people it actually names.
 *
 * Owners in an extracted register are prose, not foreign keys: "Ashley/Tony
 * obtain; Warwick configure" names three people and two responsibilities. A
 * classifier that treats that whole string as one opaque name gets every
 * multi-owner row wrong.
 */
export function ownerParts(owner: string | null): string[] {
  if (owner === null) return [];
  // A leading "Escalated:" style prefix names a route, not a person; keep only
  // what follows the colon.
  const body = owner.includes(':') ? owner.slice(owner.indexOf(':') + 1) : owner;
  return body
    .split(OWNER_SPLIT)
    .map(normalizeOwnerPart)
    .filter((part) => part.length > 0 && !NON_OWNER.test(part));
}

/**
 * Who must act on this record: the consultant, the customer, both, or nobody.
 *
 * A part counts as the consultant when its first name matches a configured
 * alias, so "Warwick", "Warwick Allan" and "Warwick (proposed)" all resolve to
 * the consultant while "Warwick/Tony" resolves to shared.
 */
export function resolveOwnership(owner: string | null, consultantAliases: string[]): Ownership {
  const parts = ownerParts(owner);
  if (parts.length === 0) return 'unowned';
  const aliases = consultantAliases.map((alias) => normalizeOwnerPart(alias)).filter(Boolean);
  const isConsultant = (part: string) => aliases.some((alias) => part === alias || part.startsWith(`${alias} `));
  const consultant = parts.filter(isConsultant).length;
  if (consultant === parts.length) return 'consultant';
  if (consultant === 0) return 'customer';
  return 'shared';
}

/* ------------------------------------------------------------ record state */

/** Statuses that close a record outright. Never shown as outstanding. */
const CLOSED = /\b(closed|done|complete|completed|resolved|cancelled|canceled|withdrawn|superseded)\b/i;

/**
 * Qualifiers that keep a nominally-agreed record open. "Agreed - structure
 * pending" is not agreed; treating it as settled is exactly the kind of
 * false confidence this pack exists to remove.
 */
const PENDING_QUALIFIER = /\b(pending|confirm|tbc|tbd|review|principle|assumption|consideration|parked|retained|proposed|draft)\b/i;

const SETTLED_ROOT = /^\s*(agreed|confirmed|decided|accepted|rejected|approved)\b/i;

export function isClosed(record: ReviewPackRecord): boolean {
  return CLOSED.test(record.status);
}

/** A decision that has genuinely closed its options. */
export function isSettledDecision(record: ReviewPackRecord): boolean {
  if (record.registerName !== 'Decisions') return false;
  if (PENDING_QUALIFIER.test(record.status)) return false;
  return SETTLED_ROOT.test(record.status);
}

/** A decision still carrying an open option, a qualifier or a confirmation. */
export function isUnsettledDecision(record: ReviewPackRecord): boolean {
  return record.registerName === 'Decisions' && !isClosed(record) && !isSettledDecision(record);
}

/* ------------------------------------------------- question reconciliation */

export type QuestionState = 'answered' | 'routed' | 'ask';

export interface QuestionReconciliation {
  state: QuestionState;
  /** The records that answer or route it, for the cross-reference. */
  by: string[];
  reason: string;
}

const ID_PATTERN = /[A-Z][A-Z0-9]*-[A-Z]+-\d+/g;

/** Every register id mentioned anywhere in a free-text field. */
export function referencedIds(value: string | null | undefined): string[] {
  if (!value) return [];
  return [...new Set(value.match(ID_PATTERN) ?? [])];
}

/**
 * Decide, from the applied records alone, whether a question is still worth
 * asking.
 *
 * Three outcomes, deliberately not two:
 *   - `answered`: a settled decision references it, or it references one. The
 *     register itself already closed it.
 *   - `routed`: it is explicitly waiting on a named action, a named person or
 *     a named external response. Real, but it belongs on a chase list, not in
 *     the meeting's question queue.
 *   - `ask`: everything else.
 *
 * Note what this deliberately does NOT do: infer "answered" from the wording
 * of the transcript quote. A question whose anchor reads like an answer is
 * frequently a question the meeting *started* to answer and then drifted off.
 * Dropping it on that basis would silently lose genuinely open work, so the
 * rule stays anchored to record linkage, which is checkable.
 */
export function reconcileQuestion(record: ReviewPackRecord, byId: Map<string, ReviewPackRecord>): QuestionReconciliation {
  const settledDecisionIds = new Set(
    [...byId.values()].filter(isSettledDecision).map((row) => row.id),
  );

  // Either direction of the link counts: the extractor is inconsistent about
  // whether the decision points back at the question or the question forward
  // at the decision, and a rule that only reads one direction misses half.
  const outward = record.relatedIds.filter((id) => settledDecisionIds.has(id));
  const inward = [...byId.values()]
    .filter((row) => isSettledDecision(row) && row.relatedIds.includes(record.id))
    .map((row) => row.id);
  const answeredBy = [...new Set([...outward, ...inward])].sort();
  if (answeredBy.length > 0) {
    return { state: 'answered', by: answeredBy, reason: 'A settled decision in the applied register resolves this.' };
  }

  const unblockedBy = record.unblockedBy?.trim() ?? '';
  if (unblockedBy) {
    const named = referencedIds(unblockedBy).filter((id) => byId.has(id));
    return {
      state: 'routed',
      by: named,
      reason: named.length > 0
        ? `Waiting on ${named.join(', ')}.`
        : `Waiting on: ${unblockedBy}.`,
    };
  }
  return { state: 'ask', by: [], reason: 'No decision resolves it and nothing is recorded as unblocking it.' };
}

/* ------------------------------------------------------ evidence strength */

export type EvidenceStrength = 'anchored' | 'fragmentary' | 'unanchored';

/**
 * How far a record's evidence can be trusted.
 *
 * `fragmentary` matters as its own class: a single unverified half-sentence is
 * not the same as three verified exchanges, and presenting it in the top
 * summary as though it were is the failure mode requirement 6 names.
 */
export function evidenceStrength(record: ReviewPackRecord): EvidenceStrength {
  const withQuote = record.anchors.filter((anchor) => anchor.quote && anchor.quote.trim().length > 0);
  if (withQuote.length === 0) return 'unanchored';
  const verified = withQuote.filter((anchor) => anchor.verified);
  if (verified.length === 0) return 'fragmentary';
  const longest = Math.max(...withQuote.map((anchor) => (anchor.context ?? anchor.quote ?? '').trim().length));
  if (verified.length === 1 && longest < 60) return 'fragmentary';
  return 'anchored';
}

export function evidenceLabel(strength: EvidenceStrength): string {
  if (strength === 'unanchored') return '**requires confirmation** (no source anchor)';
  if (strength === 'fragmentary') return '**requires confirmation** (fragmentary evidence)';
  return '';
}

/* ------------------------------------------------------ primary sectioning */

export type SectionKey =
  | 'safety-and-blockers'
  | 'decisions-to-resolve'
  | 'customer-dependencies'
  | 'warwick-actions'
  | 'questions-to-ask'
  | 'questions-routed'
  | 'questions-answered'
  | 'settled-decisions'
  | 'risks-monitored'
  | 'milestones'
  | 'other';

/**
 * The one section a record belongs in, chosen by first match.
 *
 * The order is the point: a safety-relevant blocker owned by the customer is a
 * blocker first and a dependency second, and repeating it under both is what
 * made the previous pack unreadable. Everything not chosen here becomes a
 * cross-reference instead of a second full copy.
 */
export function primarySection(
  record: ReviewPackRecord,
  ownership: Ownership,
  question: QuestionReconciliation | null,
): SectionKey {
  if (isClosed(record)) return 'other';

  if (record.registerName === 'Open_Questions') {
    if (!question || question.state === 'ask') return 'questions-to-ask';
    return question.state === 'answered' ? 'questions-answered' : 'questions-routed';
  }

  const safety = /\bsafety\b/i.test(record.severity ?? '') || /\bsafety\b/i.test(record.title);
  if (safety || record.blocking) return 'safety-and-blockers';

  if (record.registerName === 'Decisions') {
    return isSettledDecision(record) ? 'settled-decisions' : 'decisions-to-resolve';
  }

  if (record.registerName === 'Actions') {
    // Requirement 2, the load-bearing rule: a dependency is work the CUSTOMER
    // owes. Shared and unowned work is the consultant's to drive, not the
    // customer's to deliver.
    return ownership === 'customer' ? 'customer-dependencies' : 'warwick-actions';
  }

  if (record.registerName === 'Risks_Issues') return 'risks-monitored';
  if (record.registerName === 'Milestones') return 'milestones';
  return 'other';
}

/* -------------------------------------------------------- meeting priority */

export interface PrioritisedRecord {
  record: ReviewPackRecord;
  ownership: Ownership;
  section: SectionKey;
  strength: EvidenceStrength;
  question: QuestionReconciliation | null;
  priority: number;
  /** Why it made the top of the brief, in the consultant's words. */
  headline: string;
}

/**
 * What has to be said in the first minute of the meeting.
 *
 * Weighted, not sorted by the register's own score: the register score ranks
 * "important in the project", and a meeting needs "important in the next
 * hour". Safety outranks everything, then things that block other work, then
 * external commitments that have already slipped.
 */
export function meetingPriority(entry: Omit<PrioritisedRecord, 'priority' | 'headline'>): { priority: number; headline: string } {
  const { record, ownership, section } = entry;
  let priority = 0;
  const reasons: string[] = [];

  if (/\bsafety\b/i.test(record.severity ?? '') || /\bsafety\b/i.test(record.title)) {
    priority += 100;
    reasons.push('safety-relevant');
  }
  if (record.blocking) { priority += 60; reasons.push('blocking other work'); }
  if (record.conflict) { priority += 45; reasons.push('conflicting evidence'); }
  if (record.overdue && ownership === 'customer') {
    priority += 50;
    // Only work the customer actually owes is a "dependency". An overdue
    // customer-owned milestone or risk is overdue and theirs, but calling it a
    // dependency in the headline contradicts the section semantics.
    reasons.push(['Actions', 'Decisions'].includes(record.registerName) ? 'overdue customer dependency' : 'overdue, customer-owned');
  }
  if (record.overdue && ownership !== 'customer') { priority += 35; reasons.push('overdue'); }
  if (section === 'decisions-to-resolve') { priority += 40; reasons.push('decision required'); }
  if (section === 'questions-to-ask') { priority += 20; reasons.push('open question'); }
  if (record.band === 'Now') { priority += 15; }

  // The register's own score only breaks ties. It is a project-level ranking
  // and must not outvote the meeting-level signals above.
  priority += Math.min(10, record.score / 10);
  return { priority, headline: reasons.length > 0 ? reasons.join('; ') : `${record.band} band` };
}

/* ------------------------------------------------------------- the build */

export interface BuiltReviewPack {
  entries: PrioritisedRecord[];
  byId: Map<string, PrioritisedRecord>;
  topTen: PrioritisedRecord[];
  bySection: Map<SectionKey, PrioritisedRecord[]>;
}

export const MAX_MEETING_ITEMS = 10;

export function buildReviewPack(input: ReviewPackInput): BuiltReviewPack {
  const recordsById = new Map(input.records.map((record) => [record.id, record]));

  const entries: PrioritisedRecord[] = input.records.map((record) => {
    const ownership = resolveOwnership(record.owner, input.consultantAliases);
    const question = record.registerName === 'Open_Questions' ? reconcileQuestion(record, recordsById) : null;
    const section = primarySection(record, ownership, question);
    const strength = evidenceStrength(record);
    const partial = { record, ownership, section, strength, question };
    const { priority, headline } = meetingPriority(partial);
    return { ...partial, priority, headline };
  });

  const byId = new Map(entries.map((entry) => [entry.record.id, entry]));

  const bySection = new Map<SectionKey, PrioritisedRecord[]>();
  for (const entry of entries) {
    bySection.set(entry.section, [...(bySection.get(entry.section) ?? []), entry]);
  }
  // Deterministic order everywhere: priority, then id. Never physical order.
  for (const [key, list] of bySection) {
    bySection.set(key, [...list].sort((a, b) => b.priority - a.priority || (a.record.id < b.record.id ? -1 : 1)));
  }

  // The opening brief never includes answered questions, settled decisions or
  // closed records — by construction, not by filtering afterwards.
  const eligible = entries.filter((entry) => !['questions-answered', 'settled-decisions', 'other'].includes(entry.section));
  const topTen = [...eligible]
    .sort((a, b) => b.priority - a.priority || (a.record.id < b.record.id ? -1 : 1))
    .slice(0, MAX_MEETING_ITEMS);

  return { entries, byId, topTen, bySection };
}

/* ---------------------------------------------------------------- render */

function fmtMs(t: number | null): string {
  if (t === null) return '';
  const total = Math.round(t / 1000);
  return `${Math.floor(total / 3600)}:${String(Math.floor((total % 3600) / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function ownerPhrase(entry: PrioritisedRecord): string {
  const { record, ownership } = entry;
  if (ownership === 'unowned') return 'Warwick to assign/resolve ownership';
  if (ownership === 'shared') return `shared: ${record.owner}`;
  return record.owner ?? 'unowned';
}

function datePhrase(record: ReviewPackRecord): string {
  if (!record.dueDate) return '';
  return record.overdue
    ? ` Due ${record.dueDate} — **shown overdue as at the last processed source; confirm current status**.`
    : ` Due ${record.dueDate}.`;
}

/** The cross-references a record earns by being relevant elsewhere. */
function crossReferences(entry: PrioritisedRecord, built: BuiltReviewPack): string {
  const related = entry.record.relatedIds
    .flatMap((raw) => referencedIds(raw))
    .filter((id) => built.byId.has(id) && id !== entry.record.id);
  const unique = [...new Set(related)].sort();
  return unique.length > 0 ? ` _See also ${unique.join(', ')}._` : '';
}

function line(entry: PrioritisedRecord, built: BuiltReviewPack, options: { showOwner?: boolean } = {}): string {
  const { record } = entry;
  const label = evidenceLabel(entry.strength);
  const parts = [
    `- **${record.title}** \`[${record.id}]\``,
    options.showOwner === false ? '' : ` Owner: ${ownerPhrase(entry)}.`,
    ` Status: ${record.status}.`,
    datePhrase(record),
    label ? ` ${label}.` : '',
    crossReferences(entry, built),
  ];
  return parts.join('');
}

function section(
  built: BuiltReviewPack,
  key: SectionKey,
  title: string,
  description: string,
  emptyText: string,
  options: { showOwner?: boolean } = {},
): string[] {
  const entries = built.bySection.get(key) ?? [];
  const lines = [`## ${title}`, '', description, ''];
  if (entries.length === 0) lines.push(`_${emptyText}_`);
  else for (const entry of entries) lines.push(line(entry, built, options));
  lines.push('');
  return lines;
}

export function renderReviewPack(input: ReviewPackInput): string {
  const built = buildReviewPack(input);
  const lines: string[] = [];

  lines.push('# Meeting Review Pack');
  lines.push('');
  lines.push(`**Source:** ${input.sourceLabel}${input.sourceEventDate ? ` (meeting of ${input.sourceEventDate})` : ''}`);
  lines.push(`**Generated:** ${input.generatedAt} — deterministically, with **${input.providerCalls} model or provider calls**.`);
  lines.push(`**From:** applied changeset \`${input.changesetId}\` on an isolated database copy. The live database was not read or written.`);
  lines.push('');
  lines.push('> **How to read this.** Every date and status below reflects the **last processed source** and nothing after it. Items shown overdue or unresolved may already have moved on — they are flagged for confirmation, not asserted as current. Anything marked _requires confirmation_ has no source anchor, or only a fragmentary one, and should be verified before you rely on it.');
  lines.push('');

  /* ---- the ten things that matter */
  lines.push(`## The meeting in ten items`);
  lines.push('');
  lines.push(`Ranked by what matters in the next hour — safety first, then blockers, overdue external dependencies, decisions required and imminent actions. Full detail for every item is in the sections and appendix below.`);
  lines.push('');
  if (built.topTen.length === 0) {
    lines.push('_Nothing outstanding._');
  } else {
    built.topTen.forEach((entry, index) => {
      const label = evidenceLabel(entry.strength);
      lines.push(`${index + 1}. **${entry.record.title}** \`[${entry.record.id}]\` — ${entry.headline}. Owner: ${ownerPhrase(entry)}.${datePhrase(entry.record)}${label ? ` ${label}.` : ''}`);
    });
  }
  lines.push('');

  /* ---- the sections, each record appearing in exactly one */
  lines.push(...section(built, 'safety-and-blockers', 'Safety and blockers',
    'Records that are safety-relevant or are blocking other work. These outrank everything else regardless of who owns them.',
    'No safety-relevant or blocking records outstanding.'));

  lines.push(...section(built, 'decisions-to-resolve', 'Decisions to resolve',
    'Decisions that have not closed their options. A decision carrying "pending", "in principle", "parked" or "confirm" is counted as open here, not as agreed.',
    'No open decisions.'));

  lines.push(...section(built, 'customer-dependencies', 'Customer dependencies',
    'Actions genuinely owed by the customer or another external party. Records the consultant or nobody owns are **not** listed here, nor are risks, questions and milestones that merely relate to the customer.',
    'Nothing is currently owed by the customer.'));

  lines.push(...section(built, 'warwick-actions', "Warwick's next actions",
    'Actions Warwick owns, shares, or must assign. Unowned work is labelled explicitly rather than being silently attributed.',
    'No consultant-owned actions outstanding.'));

  lines.push(...section(built, 'questions-to-ask', 'Questions to ask',
    'Open questions with no settled decision resolving them and nothing recorded as unblocking them. These are the ones worth meeting time.',
    'No questions need asking.'));

  lines.push(...section(built, 'questions-routed', 'Questions already routed — chase, do not re-ask',
    'Questions explicitly waiting on a named action, person or external response. Track these rather than re-opening them in the meeting.',
    'No questions are waiting on something else.'));

  const answered = built.bySection.get('questions-answered') ?? [];
  lines.push('## Questions the register has already answered');
  lines.push('');
  lines.push('Reconciled against the applied records: a settled decision resolves each of these. **Do not raise them as open questions.**');
  lines.push('');
  if (answered.length === 0) lines.push('_No questions were resolved by a settled decision._');
  else for (const entry of answered) {
    lines.push(`- ~~**${entry.record.title}**~~ \`[${entry.record.id}]\` — answered by ${entry.question?.by.join(', ') ?? 'a settled decision'}.`);
  }
  lines.push('');

  lines.push(...section(built, 'risks-monitored', 'Risks and issues to monitor',
    'Open risks and issues that are not currently blocking. Blocking ones appear under Safety and blockers above.',
    'No further open risks or issues.'));

  lines.push(...section(built, 'milestones', 'Milestones',
    'Milestones from the last processed source. Dates are as recorded then and need confirmation against the current plan.',
    'No milestones recorded.'));

  lines.push(...section(built, 'settled-decisions', 'Settled decisions (context only)',
    'Decisions the register records as closed. Listed for context; no action implied.',
    'No settled decisions.', { showOwner: false }));

  /* ---- appendix: full evidence, one entry per record, anchored */
  lines.push('---');
  lines.push('');
  lines.push('# Appendix — full register and source evidence');
  lines.push('');
  lines.push('Every record above in full, with its verbatim source anchors widened to their adjacent normalised segments where the source had them. Records with no anchor are listed as such rather than omitted.');
  lines.push('');

  const ordered = [...built.entries].sort((a, b) => (a.record.id < b.record.id ? -1 : 1));
  for (const entry of ordered) {
    const { record } = entry;
    lines.push(`### ${record.id} — ${record.title}`);
    lines.push('');
    lines.push(`- **Register:** ${record.registerName} · **Status:** ${record.status} · **Band:** ${record.band}${record.severity ? ` · **Severity:** ${record.severity}` : ''}`);
    lines.push(`- **Owner:** ${ownerPhrase(entry)} (${entry.ownership})${record.dueDate ? ` · **Due:** ${record.dueDate}${record.overdue ? ' — overdue as at last processed source' : ''}` : ''}`);
    lines.push(`- **Evidence:** ${entry.strength}${evidenceLabel(entry.strength) ? ` — ${evidenceLabel(entry.strength)}` : ''}`);
    if (record.summary) lines.push(`- **Summary:** ${record.summary}`);
    if (entry.question) lines.push(`- **Question state:** ${entry.question.state} — ${entry.question.reason}`);
    const related = [...new Set(record.relatedIds.flatMap((raw) => referencedIds(raw)))].sort();
    if (related.length > 0) lines.push(`- **Related:** ${related.join(', ')}`);
    lines.push('');
    if (record.anchors.length === 0) {
      lines.push('_No source anchor recorded on this row — it came from a reaffirmation or a live-session change rather than a fresh quote. Requires confirmation._');
    } else {
      for (const anchor of record.anchors) {
        const who = anchor.speaker ?? 'unknown speaker';
        const when = anchor.tMs !== null ? ` @ ${fmtMs(anchor.tMs)}` : '';
        const flag = anchor.verified ? '' : ' _(unverified quote match)_';
        lines.push(`> ${who}${when}: "${(anchor.context ?? anchor.quote ?? '').trim()}"${flag}`);
        lines.push('');
      }
    }
  }

  return `${lines.join('\n').trim()}\n`;
}

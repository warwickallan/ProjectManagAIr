/**
 * The chronology model: what is known, how precisely, and on what basis.
 *
 * Pure-function tests. The central guarantee under test is that nothing here
 * can ever produce an ordering from an unknown date, and that upload time is
 * not reachable from any code path.
 */
import { describe, expect, it } from 'vitest';
import {
  chronologyFromRow,
  chronologyInterval,
  compareChronology,
  describeChronology,
  describeUnresolved,
  humanPrecedenceInstant,
  normaliseChronology,
  UNKNOWN_CHRONOLOGY,
  type SourceChronology,
} from '../src/sourceChronology';

const confirmed = (date: string): SourceChronology => normaliseChronology({ state: 'confirmed', precision: 'date', basis: 'human-confirmed', date });

describe('normalising a chronology assertion', () => {
  it('accepts a confirmed date', () => {
    const value = confirmed('2026-08-05');
    expect(value).toMatchObject({ state: 'confirmed', precision: 'date', basis: 'human-confirmed', date: '2026-08-05' });
  });

  it('accepts explicitly unknown, and refuses to let it also carry a date', () => {
    expect(normaliseChronology({ state: 'unknown' })).toMatchObject({ state: 'unknown', precision: 'none', date: null });
    expect(() => normaliseChronology({ state: 'unknown', date: '2026-08-05' })).toThrow(/cannot also carry a date/i);
  });

  it('expands a month into a closed interval', () => {
    const value = normaliseChronology({ state: 'approximate', precision: 'month', basis: 'human-confirmed', rangeStart: '2026-02' });
    expect(value.rangeStart).toBe('2026-02-01');
    // 2026 is not a leap year, so February ends on the 28th.
    expect(value.rangeEnd).toBe('2026-02-28');
  });

  it('refuses to store a filename or file timestamp as a confirmed meeting date', () => {
    expect(() => normaliseChronology({ state: 'confirmed', precision: 'date', basis: 'filename-suggestion', date: '2026-08-05' })).toThrow(/suggestion/i);
    expect(() => normaliseChronology({ state: 'confirmed', precision: 'date', basis: 'file-timestamp-suggestion', date: '2026-08-05' })).toThrow(/suggestion/i);
    // The same basis IS allowed as an explicitly approximate value, because
    // then the product is not claiming anyone confirmed it.
    expect(normaliseChronology({ state: 'approximate', precision: 'date', basis: 'filename-suggestion', date: '2026-08-05' }).state).toBe('approximate');
  });

  it('rejects an impossible date, a backwards range and a missing precision', () => {
    expect(() => normaliseChronology({ state: 'confirmed', precision: 'date', basis: 'human-confirmed', date: '2026-02-30' })).toThrow(/real date/i);
    expect(() => normaliseChronology({ state: 'approximate', precision: 'range', basis: 'human-confirmed', rangeStart: '2026-08-10', rangeEnd: '2026-08-01' })).toThrow(/ends before it starts/i);
    expect(() => normaliseChronology({ state: 'confirmed', precision: 'none', basis: 'human-confirmed', date: '2026-08-05' })).toThrow(/precision/i);
  });
});

describe('ordering two meetings', () => {
  it('orders two confirmed dates that do not overlap', () => {
    expect(compareChronology(confirmed('2026-08-05'), confirmed('2026-08-01'))).toBe('after');
    expect(compareChronology(confirmed('2026-08-01'), confirmed('2026-08-05'))).toBe('before');
  });

  it('refuses to order two meetings on the SAME day, rather than guessing', () => {
    expect(compareChronology(confirmed('2026-08-05'), confirmed('2026-08-05'))).toBe('unresolved');
  });

  it('orders exact datetimes on the same day', () => {
    const morning = normaliseChronology({ state: 'confirmed', precision: 'exact-datetime', basis: 'human-confirmed', date: '2026-08-05', time: '09:30' });
    const afternoon = normaliseChronology({ state: 'confirmed', precision: 'exact-datetime', basis: 'human-confirmed', date: '2026-08-05', time: '15:00' });
    expect(compareChronology(afternoon, morning)).toBe('after');
    expect(compareChronology(morning, morning)).toBe('same');
  });

  it('NEVER orders an unknown date against anything — in either direction', () => {
    expect(compareChronology(UNKNOWN_CHRONOLOGY, confirmed('2026-08-05'))).toBe('unresolved');
    expect(compareChronology(confirmed('2026-08-05'), UNKNOWN_CHRONOLOGY)).toBe('unresolved');
    expect(compareChronology(UNKNOWN_CHRONOLOGY, UNKNOWN_CHRONOLOGY)).toBe('unresolved');
    expect(chronologyInterval(UNKNOWN_CHRONOLOGY)).toBeNull();
  });

  it('refuses to order a date that falls inside an approximate range', () => {
    const august = normaliseChronology({ state: 'approximate', precision: 'month', basis: 'human-confirmed', rangeStart: '2026-08' });
    expect(compareChronology(confirmed('2026-08-05'), august)).toBe('unresolved');
    // ...but a date outside the range IS orderable, because the intervals are
    // strictly separated.
    expect(compareChronology(confirmed('2026-09-05'), august)).toBe('after');
    expect(compareChronology(confirmed('2026-07-05'), august)).toBe('before');
  });
});

describe('human precedence', () => {
  it('lets any human edit outrank a source with no known meeting date', () => {
    // Start of time: every real human event postdates it, so the human edit
    // always wins. This is the conservative answer, and it is the one place
    // "unknown" resolves to a value rather than to a refusal.
    expect(humanPrecedenceInstant(UNKNOWN_CHRONOLOGY)).toBe('0000-01-01T00:00:00.000Z');
  });

  it('uses the end of the confirmed meeting day for a dated source', () => {
    expect(humanPrecedenceInstant(confirmed('2026-08-05'))).toBe('2026-08-05T23:59:59.999Z');
  });

  it('never returns an upload timestamp', () => {
    // The regression this whole model exists to prevent: the previous
    // implementation returned `created_at` for an undateable source. Nothing
    // reachable here can produce a present-day instant.
    const instants = [UNKNOWN_CHRONOLOGY, confirmed('2026-08-05'), normaliseChronology({ state: 'approximate', precision: 'month', basis: 'human-confirmed', rangeStart: '2026-08' })]
      .map(humanPrecedenceInstant);
    for (const instant of instants) expect(instant.startsWith('20') && instant > '2026-09-01' ? 'leaked' : 'clean').toBe('clean');
  });
});

describe('what a consultant reads', () => {
  it('says "Meeting date unknown" in plain words', () => {
    expect(describeChronology(UNKNOWN_CHRONOLOGY)).toBe('Meeting date unknown');
    expect(describeChronology(confirmed('2026-08-05'))).toBe('2026-08-05');
    expect(describeChronology(normaliseChronology({ state: 'approximate', precision: 'month', basis: 'human-confirmed', rangeStart: '2026-08' }))).toBe('Approximately 2026-08-01 to 2026-08-31');
  });

  it('explains an unresolved comparison naming the other meeting', () => {
    const message = describeUnresolved(UNKNOWN_CHRONOLOGY, confirmed('2026-08-05'), 'PPM Session');
    expect(message).toContain('Chronology unresolved');
    expect(message).toContain('PPM Session');
    expect(message).toContain('no known meeting date');
  });
});

describe('reading a stored row', () => {
  it('reports a pre-migration row as unknown rather than guessing', () => {
    expect(chronologyFromRow({}).state).toBe('unknown');
    expect(chronologyFromRow({ confirmed_event_date: '2026-08-05' }).state).toBe('unknown');
  });

  it('round-trips a stored confirmed row', () => {
    const value = chronologyFromRow({ chronology_state: 'confirmed', chronology_precision: 'date', chronology_basis: 'human-confirmed', confirmed_event_date: '2026-08-05' });
    expect(value).toMatchObject({ state: 'confirmed', date: '2026-08-05' });
  });
});

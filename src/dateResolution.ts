export type DateResolutionConfidence = 'exact' | 'high' | 'medium' | 'low' | 'conditional' | 'none';

export interface DateResolution {
  raw: string;
  date: string | null;
  confidence: DateResolutionConfidence;
  explanation: string;
}

const weekdays = new Map([
  ['sunday', 0], ['monday', 1], ['tuesday', 2], ['wednesday', 3],
  ['thursday', 4], ['friday', 5], ['saturday', 6],
]);

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function utcDate(value: string | null | undefined): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.valueOf()) ? null : date;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function lastWorkingDay(year: number, month: number): Date {
  let date = new Date(Date.UTC(year, month + 1, 0));
  while (date.getUTCDay() === 0 || date.getUTCDay() === 6) date = addDays(date, -1);
  return date;
}

function weekdayRelative(base: Date, target: number, forceNext: boolean): Date {
  let days = (target - base.getUTCDay() + 7) % 7;
  if (forceNext && days === 0) days = 7;
  return addDays(base, days);
}

function parseNamedDate(raw: string, eventDate: Date): Date | null {
  const match = raw.match(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)(?:\s+the)?\s+(\d{1,2})(?:st|nd|rd|th)?\b/i);
  if (!match) return null;
  const day = Number(match[2]);
  for (const monthOffset of [0, 1, -1]) {
    const candidate = new Date(Date.UTC(eventDate.getUTCFullYear(), eventDate.getUTCMonth() + monthOffset, day));
    if (candidate.getUTCDate() === day && candidate.getUTCDay() === weekdays.get(match[1].toLowerCase())) return candidate;
  }
  return null;
}

export function resolveDate(rawValue: unknown, eventDateValue?: string | null): DateResolution {
  const raw = String(rawValue ?? '').trim();
  if (!raw) return { raw, date: null, confidence: 'none', explanation: 'No date wording supplied.' };

  const directIso = raw.match(/\b(\d{4}-\d{2}-\d{2})\b/g) ?? [];
  const lower = raw.toLowerCase().replace(/\s+/g, ' ');
  const hardStop = lower.match(/hard\s*stop[^0-9]*(\d{4}-\d{2}-\d{2})/i);
  if (hardStop) return { raw, date: hardStop[1], confidence: 'conditional', explanation: 'Resolved to the explicit hard-stop date; conditional wording retained.' };
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return { raw, date: raw, confidence: 'exact', explanation: 'Exact ISO date.' };
  if (/^(?:w\/c|wc|week commencing)\b/i.test(raw) && directIso[0]) {
    const date = utcDate(directIso[0]);
    if (date) {
      const monday = addDays(date, -((date.getUTCDay() + 6) % 7));
      return { raw, date: iso(monday), confidence: 'high', explanation: 'Resolved to Monday of the stated week commencing.' };
    }
  }
  if (directIso.length === 1) return { raw, date: directIso[0], confidence: 'high', explanation: 'Resolved from an embedded ISO date.' };
  if (directIso.length > 1) return { raw, date: directIso.at(-1) ?? null, confidence: 'conditional', explanation: 'Multiple dates supplied; retained the final date as the hard boundary.' };

  const eventDate = utcDate(eventDateValue);
  if (!eventDate) return { raw, date: null, confidence: 'none', explanation: 'Relative wording cannot be resolved without a valid source event date.' };

  if (/\b(?:month end|end of (?:the )?month)\b/i.test(raw)) {
    return { raw, date: iso(lastWorkingDay(eventDate.getUTCFullYear(), eventDate.getUTCMonth())), confidence: 'medium', explanation: 'Resolved to the last working day of the source month.' };
  }
  if (/\b(?:end of (?:the )?week|by friday)\b/i.test(raw)) {
    return { raw, date: iso(weekdayRelative(eventDate, 5, false)), confidence: 'medium', explanation: 'Resolved to Friday of the source event week.' };
  }
  if (/\b(?:couple of weeks|two weeks)\b/i.test(raw)) {
    return { raw, date: iso(addDays(eventDate, 14)), confidence: 'low', explanation: 'Approximate two-week wording resolved from the source event date.' };
  }
  if (/\b(?:over the next week|next week|within a week)\b/i.test(raw)) {
    return { raw, date: iso(addDays(eventDate, 7)), confidence: 'low', explanation: 'Approximate one-week wording resolved from the source event date.' };
  }

  const nextWeekday = lower.match(/\bnext\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i);
  if (nextWeekday) {
    return { raw, date: iso(weekdayRelative(eventDate, weekdays.get(nextWeekday[1]) ?? eventDate.getUTCDay(), true)), confidence: 'high', explanation: 'Named weekday resolved after the source event date.' };
  }
  const named = parseNamedDate(raw, eventDate);
  if (named) return { raw, date: iso(named), confidence: 'high', explanation: 'Named weekday and day-of-month resolved against the source event date.' };

  return { raw, date: null, confidence: 'none', explanation: 'Date wording was retained without fabricating a resolved date.' };
}

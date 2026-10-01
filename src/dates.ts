// Dates as intervals at their precision (docs/CONTRACT.md §7).
//
// An entity or fragment date is YYYY, YYYY-MM, or YYYY-MM-DD. "2019" denotes
// the whole of 2019, "2019-03" the month, "2019-03-14" the day. A fragment
// satisfies a bound when its interval intersects the bound's interval; hits
// are ordered in time by interval start. Anything else is "undated" and never
// guessed at.

import type { Entity, Fragment } from './contract.js';

export interface DateInterval {
  /** Inclusive, ms since epoch (UTC). */
  start: number;
  /** Inclusive, ms since epoch (UTC): the last millisecond of the period. */
  end: number;
}

const DATE = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/;

/** Parse a date string into its interval, or null when it is not a date. */
export function parseDateInterval(value: string | undefined): DateInterval | null {
  if (!value) return null;
  const m = DATE.exec(value.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const month = m[2] !== undefined ? Number(m[2]) : undefined;
  const day = m[3] !== undefined ? Number(m[3]) : undefined;
  if (month !== undefined && (month < 1 || month > 12)) return null;
  if (day !== undefined && (day < 1 || day > 31)) return null;
  if (day !== undefined && month !== undefined) {
    const start = Date.UTC(y, month - 1, day);
    if (new Date(start).getUTCDate() !== day) return null; // e.g. 2019-02-30
    return { start, end: Date.UTC(y, month - 1, day + 1) - 1 };
  }
  if (month !== undefined) {
    return { start: Date.UTC(y, month - 1, 1), end: Date.UTC(y, month, 1) - 1 };
  }
  return { start: Date.UTC(y, 0, 1), end: Date.UTC(y + 1, 0, 1) - 1 };
}

/** The effective date string of a fragment: its own, else its entity's. */
export function effectiveDate(fragment: Pick<Fragment, 'date'>, entity: Pick<Entity, 'date'>): string | undefined {
  return fragment.date ?? entity.date;
}

export function intervalsIntersect(a: DateInterval, b: DateInterval): boolean {
  return a.start <= b.end && b.start <= a.end;
}

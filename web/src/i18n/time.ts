// Time spans as numbers + unit, for dictionaries to put into words in their
// own grammar (e.g. Ukrainian cases). Same rounding as before for every language.
export const MIN = 60 * 1000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

export type Unit = 'day' | 'hour' | 'minute';
export interface Span {
  n: number;
  unit: Unit;
}

/** The largest unit that reads well: 14 days, 5 hours, 20 minutes. */
export function spanOf(ms: number): Span {
  if (ms >= 2 * DAY || (ms >= DAY && ms % DAY === 0)) return { n: Math.round(ms / DAY), unit: 'day' };
  if (ms >= 2 * HOUR || (ms >= HOUR && ms % HOUR === 0)) return { n: Math.round(ms / HOUR), unit: 'hour' };
  return { n: Math.max(1, Math.round(ms / MIN)), unit: 'minute' };
}

/** Time left, counting up (2.1 days reads "3 days"); null when none is left. */
export function leftOf(ms: number): Span | null {
  if (ms <= 0) return null;
  if (ms >= 2 * DAY) return { n: Math.ceil(ms / DAY), unit: 'day' };
  if (ms >= 2 * HOUR) return { n: Math.ceil(ms / HOUR), unit: 'hour' };
  return { n: Math.max(1, Math.ceil(ms / MIN)), unit: 'minute' };
}

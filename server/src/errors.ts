// HTTP error with a stable machine code (shared by app.ts and market.ts).

export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;
  constructor(statusCode: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

/**
 * A limit in seconds as plain words for people ("5 minutes", "90 days"):
 * error texts show it instead of raw "300s and 7776000s".
 * Uses the largest unit that divides it exactly.
 */
export function plainDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const units: [number, string][] = [
    [86400, 'day'],
    [3600, 'hour'],
    [60, 'minute'],
  ];
  for (const [size, name] of units) {
    if (s >= size && s % size === 0) {
      const n = s / size;
      return `${n} ${name}${n === 1 ? '' : 's'}`;
    }
  }
  return `${s} second${s === 1 ? '' : 's'}`;
}

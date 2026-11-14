// What every deal screen shows, and how amounts, dates and time spans are
// written. Real deals fill `DealInfo` from the signed terms and the chain
// (real/model.ts); the example deal on the home page uses demoInfo() below.
// Words come from the dictionary of the chosen language (i18n/); dates use Intl
// in that language. Amounts are never localized: "291.50" reads the same everywhere.
import { locale, tr } from './i18n';
import { DAY, HOUR, MIN } from './i18n/time';

export { DAY, HOUR, MIN };

export interface DealInfo {
  title: string;
  /** "The work". */
  task: string;
  /** "You get"; "" when the creator left it empty. */
  deliverable: string;
  /** Agreed rounds of changes; null = not set. */
  revisions: number | null;
  /** Price in USDC base units (6 decimals). */
  amount: bigint;
  feeBps: number;
  /** Work time counted from payment. */
  deliveryMs: number;
  reviewMs: number;
  /** Time to pay after accepting the terms. */
  payWithinMs: number;
  disputeMs: number;
  /** Short codes of the two one-time keys, compared in chat. */
  creatorCode: string;
  clientCode: string | null;
  /** The creator's profile when the deal came from a request; null for a direct deal. */
  /** `profileId`: for the "key / contact changed N days ago" note; absent in the example deal. */
  creator: { nick: string; profileUrl: string; profileId?: string } | null;
}

/** Example deal behind "See an example deal". Nothing here is real; the texts follow the chosen language. */
export function demoInfo(): DealInfo {
  const t = tr().demo;
  return {
    title: t.title,
    task: t.task,
    deliverable: t.deliverable,
    revisions: 2,
    amount: 300_000_000n,
    feeBps: 300,
    deliveryMs: 14 * DAY,
    reviewMs: 3 * DAY,
    payWithinMs: 7 * DAY,
    disputeMs: 7 * DAY,
    creatorCode: '3F9A 7C21 E84B',
    clientCode: '8B2E 41F0 7C9D',
    creator: { nick: 'mila_motion', profileUrl: '#profile' },
  };
}

/** A key fingerprint ("3f9a-7c21-e84b") the way people read it out in chat. */
export function showCode(fingerprint: string): string {
  return fingerprint.replace(/-/g, ' ').toUpperCase();
}

/** USDC base units -> "300", "4.85", "291.50". */
export function usd(units: bigint): string {
  const whole = units / 1_000_000n;
  let frac = (units % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  if (frac.length === 1) frac += '0';
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** What the creator gets from a share after the fee (same rounding as the contract). */
export function afterFee(share: bigint, feeBps: number): bigint {
  return share - (share * BigInt(feeBps)) / 10_000n;
}

/** How a deal amount splits when the creator gets `pct` percent. */
export function splitOf(info: DealInfo, pct: number) {
  const creatorShare = (info.amount * BigInt(Math.round(pct * 100))) / 10_000n;
  return { creatorNet: afterFee(creatorShare, info.feeBps), clientBack: info.amount - creatorShare };
}

/** "November 20" ("20 листопада"); with the time when it is less than two days away. */
export function fmtDate(d: Date, now = Date.now()): string {
  const loc = locale();
  const day = d.toLocaleDateString(loc, { month: 'long', day: 'numeric' });
  if (Math.abs(d.getTime() - now) >= 2 * DAY) return day;
  return `${day}, ${d.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit', hour12: false })}`;
}

/** A time span in the largest unit that reads well: "14 days", "5 hours", "20 minutes". */
export function span(ms: number): string {
  return tr().units.span(ms);
}

export function days(n: number) {
  return tr().units.days(n);
}

/** "3 days left" / "5 hours left" / "no time left". Counts up, so 2.1 days reads "3 days left". */
export function left(to: Date, now = Date.now()): string {
  return tr().units.left(to.getTime() - now);
}

export function revisionsText(n: number | null) {
  const u = tr().units;
  if (n === null) return u.revisionsNotSet;
  if (n === 0) return u.revisionsNone;
  return u.revisions(n);
}

/** Dates as if the client paid at `from`. */
export function dealDates(info: DealInfo, from = new Date()) {
  const deliverBy = new Date(from.getTime() + info.deliveryMs);
  const reviewEnd = new Date(deliverBy.getTime() + info.reviewMs);
  const lockedUntil = new Date(reviewEnd.getTime() + info.disputeMs);
  const payBy = new Date(from.getTime() + info.payWithinMs);
  return { deliverBy, reviewEnd, lockedUntil, payBy };
}

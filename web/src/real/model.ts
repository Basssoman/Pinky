// From a checked deal (signed terms + the chain) to what the screens show.

import { showCode, type DealInfo } from '../deal';
import type { DealState, Ending, StatusDates } from '../DealStatus';
import { nsToMs, type DealView } from '../lib/chain';
import type { LoadedDeal } from '../lib/flows';
import { checkedCreator } from '../lib/market';

/**
 * The creator's nickname + profile link, only when this browser checked,
 * on the request page, that the creator's profile key signed this very deal
 * key. Otherwise null: the page shows the creator code and
 * the "not linked to a profile" notice.
 */
function creatorOf(d: LoadedDeal): DealInfo['creator'] {
  if (d.role === 'creator' || d.role === 'stranger') return null;
  const c = checkedCreator(d.handle, d.offer.creator_pk);
  return c ? { nick: c.nickname, profileUrl: `/creators/${c.profileId}`, profileId: c.profileId } : null;
}

export function dealInfo(d: LoadedDeal): DealInfo {
  return {
    title: d.terms.title,
    task: d.terms.work,
    deliverable: d.terms.gets,
    revisions: d.terms.revisions,
    amount: BigInt(d.terms.amount),
    feeBps: d.terms.feeBps,
    deliveryMs: d.terms.deliveryMs,
    reviewMs: d.terms.reviewMs,
    payWithinMs: nsToMs(d.periods.payByPeriodNs),
    disputeMs: nsToMs(d.periods.disputePeriodNs),
    creatorCode: showCode(d.creatorCode),
    clientCode: d.clientCode ? showCode(d.clientCode) : null,
    creator: creatorOf(d),
  };
}

const date = (ns: string | null | undefined): Date | null => (ns && ns !== '0' ? new Date(nsToMs(ns)) : null);

export function statusDates(deal: DealView): StatusDates {
  return {
    paidAt: date(deal.funded_at_ns),
    deliverBy: date(deal.delivery_deadline_ns),
    deliveredAt: date(deal.delivered_at_ns),
    reviewEnd: date(deal.review_ends_at_ns),
    splitAt: date(deal.dispute_ends_at_ns),
    payBy: date(deal.pay_by_ns),
  };
}

export interface Ended {
  state: DealState;
  ending: Ending;
  /** Creator's share in percent for split outcomes. */
  splitPct: number;
}

/** The screen state for a deal as it is on-chain. Closed deals are read by their outcome, not by `state`. */
export function screenState(deal: DealView, nowMs: number): Ended {
  const plain = (state: DealState, ending: Ending = null): Ended => ({ state, ending, splitPct: 0 });
  switch (deal.state) {
    case 'Created':
      return plain('unpaid');
    case 'Funded':
      return plain(deal.delivery_deadline_ns && nowMs > nsToMs(deal.delivery_deadline_ns) ? 'late' : 'funded');
    case 'Delivered':
      return plain('delivered');
    case 'Disputed':
      return plain('disputed');
  }
  const o = deal.outcome;
  if (o && typeof o === 'object') {
    const [kind, ending] =
      'ArbiterSplit' in o ? [o.ArbiterSplit, 'arbiter' as const] : 'TimeoutSplit' in o ? [o.TimeoutSplit, 'timeout' as const] : [o.Settled, 'agreed' as const];
    const bps = kind.creator_share_bps;
    if (bps >= 10_000) return plain('released', ending);
    if (bps <= 0) return plain('refunded', ending);
    return { state: 'settled', ending, splitPct: bps / 100 };
  }
  switch (o) {
    case 'Accepted':
      return plain('released', 'accepted');
    case 'AutoReleased':
      return plain('released', 'auto');
    case 'RefundedByCreator':
      return plain('refunded', 'by_creator');
    case 'RefundedAfterDeadline':
      return plain('refunded', 'late');
    case 'Cancelled':
      return plain('cancelled');
    case 'ClosedUnpaid':
      return plain('expired');
  }
  return plain(deal.state === 'Refunded' ? 'refunded' : deal.state === 'Cancelled' ? 'cancelled' : deal.state === 'Expired' ? 'expired' : 'released');
}

const sum = (...v: string[]) => v.reduce((n, x) => n + BigInt(x), 0n);

/** What each side got from a closed deal: withdrawable + on its way + already sent. */
export function totals(deal: DealView) {
  return {
    creatorGot: sum(deal.creator_payout, deal.creator_pending, deal.creator_withdrawn),
    clientGot: sum(deal.client_payout, deal.client_pending, deal.client_withdrawn),
  };
}

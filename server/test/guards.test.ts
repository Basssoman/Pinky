import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { DealView } from '../src/chain.ts';
import { actionDeadline, actionHardDeadline, ipPrefix, NO_DEADLINE, precheckAction, precheckSettle, settleTimerEnd } from '../src/guards.ts';

const deal = (over: Partial<DealView> = {}): DealView =>
  ({
    id: 0,
    amount: '5000000',
    funded_amount: '5000000',
    state: 'Released',
    creator_pk: 'x',
    client_pk: 'y',
    delivery_deadline_ns: '1000',
    review_period_ns: '10',
    delivered_at_ns: '500',
    deliverable_hash: 'h',
    terms_hash: 't',
    creator_payout: '5000000',
    client_payout: '0',
    created_at_ns: '0',
    review_ends_at_ns: '510',
    disputed_at_ns: null,
    dispute_ends_at_ns: null,
    creator_pending: '0',
    client_pending: '0',
    creator_withdrawn: '0',
    client_withdrawn: '0',
    settled: false,
    settle_seq: 0,
    creator_fingerprint: '',
    client_fingerprint: '',
    ...over,
  }) as DealView;

test('relayer priority uses only contract deadlines; a withdraw expiry never jumps the queue', () => {
  assert.equal(actionDeadline(deal(), 'withdraw'), NO_DEADLINE);
  assert.equal(actionDeadline(deal(), 'deliver'), 1000n);
  assert.equal(actionDeadline(deal(), 'dispute'), 510n);
  assert.equal(actionDeadline(deal({ review_ends_at_ns: null }), 'accept'), NO_DEADLINE);
  assert.equal(actionDeadline(deal(), 'cancel'), NO_DEADLINE);
  assert.equal(actionHardDeadline(deal(), 'deliver'), 1000n);
  assert.equal(actionHardDeadline(deal(), 'dispute'), 510n);
  assert.equal(actionHardDeadline(deal(), 'accept'), null, 'accept stays valid after the review ends');
  assert.equal(actionHardDeadline(deal(), 'withdraw'), null);
});

test('withdraw pre-check wants exactly the whole payout', () => {
  const p = (amount: string) => ({ destination: 'd'.repeat(64), amount, expires_at_ns: '9999' });
  assert.match(precheckAction(deal(), 'withdraw', p('1'), 'creator', 0n, 'escrow', 'usdc')!, /whole/);
  assert.match(precheckAction(deal(), 'withdraw', p('5000001'), 'creator', 0n, 'escrow', 'usdc')!, /exceeds/);
  assert.equal(precheckAction(deal(), 'withdraw', p('5000000'), 'creator', 0n, 'escrow', 'usdc'), null);
});

test('per-IP caps: IPv4 /24, IPv6 /48 (expanded, case-insensitive)', () => {
  assert.equal(ipPrefix('203.0.113.7'), '203.0.113.0/24');
  assert.equal(ipPrefix('::ffff:203.0.113.7'), '203.0.113.0/24');
  assert.equal(ipPrefix('2001:db8:1:2:3:4:5:6'), '2001:db8:1::/48');
  assert.equal(ipPrefix('2001:DB8:0001:ffff::1'), '2001:db8:1::/48');
  assert.notEqual(ipPrefix('2001:db8:2::1'), ipPrefix('2001:db8:1::1'));
  assert.equal(ipPrefix('::1'), '0:0:0::/48');
});

test('v2 pre-check: no deadline before funding; client may withdraw extra money mid-deal; revoke_settle only while live', () => {
  const created = deal({ state: 'Created', funded_amount: '0', delivery_deadline_ns: null, creator_payout: '0', client_payout: '2000000' });
  assert.match(precheckAction(created, 'deliver', { deliverable_hash: 'h' }, 'creator', 0n, 'escrow', 'usdc')!, /Created/);
  assert.match(precheckAction(created, 'refund', {}, 'client', 10n ** 30n, 'escrow', 'usdc')!, /Created/);
  const w = { destination: 'd'.repeat(64), amount: '2000000', expires_at_ns: '9999' };
  assert.equal(precheckAction(created, 'withdraw', w, 'client', 0n, 'escrow', 'usdc'), null, 'underpayment withdrawable while Created');
  assert.match(precheckAction(created, 'withdraw', w, 'creator', 0n, 'escrow', 'usdc')!, /exceeds/);
  const funded = deal({ state: 'Funded', client_payout: '2000000', creator_payout: '0' });
  assert.equal(precheckAction(funded, 'withdraw', w, 'client', 0n, 'escrow', 'usdc'), null, 'extra money withdrawable while Funded');
  const seq0 = { seq: '0' };
  assert.equal(precheckAction(funded, 'revoke_settle', seq0, 'client', 0n, 'escrow', 'usdc'), null);
  assert.match(precheckAction(funded, 'revoke_settle', {}, 'client', 0n, 'escrow', 'usdc')!, /seq/);
  assert.match(precheckAction(funded, 'revoke_settle', { seq: '1' }, 'client', 0n, 'escrow', 'usdc')!, /settle_seq/);
  assert.match(precheckAction(funded, 'revoke_settle', { seq: '00' }, 'client', 0n, 'escrow', 'usdc')!, /canonical/);
  assert.match(precheckAction(created, 'revoke_settle', seq0, 'client', 0n, 'escrow', 'usdc')!, /Created/);
  assert.match(precheckAction(deal(), 'revoke_settle', seq0, 'creator', 0n, 'escrow', 'usdc')!, /Released/);
  // A plain transfer to intents.near would be lost
  const toIntents = { ...w, destination: 'intents.near' };
  assert.match(precheckAction(funded, 'withdraw', toIntents, 'client', 0n, 'escrow', 'usdc')!, /bad destination/);
  // deliverable hash: up to 192 chars (room for a version prefix)
  const long = (n: number) => ({ deliverable_hash: 'h'.repeat(n) });
  assert.equal(precheckAction(funded, 'deliver', long(192), 'creator', 0n, 'escrow', 'usdc'), null);
  assert.match(precheckAction(funded, 'deliver', long(193), 'creator', 0n, 'escrow', 'usdc')!, /192/);
});

test('settle pre-check mirrors the contract: state, seq, expiry, the running timer', () => {
  const d = deal({ state: 'Delivered', settle_seq: 2, review_ends_at_ns: '510', delivery_deadline_ns: '1000' });
  const p = (over: Record<string, unknown> = {}) => ({ split_bps: '7000', state: 'Delivered', seq: '2', expires_at_ns: '600', nonce: 'n1', ...over });
  assert.equal(settleTimerEnd(d), 510n);
  assert.equal(settleTimerEnd(deal({ state: 'Funded' })), 1000n);
  assert.equal(settleTimerEnd(deal({ state: 'Disputed', dispute_ends_at_ns: '900' })), 900n);
  assert.equal(settleTimerEnd(deal({ state: 'Created' })), null);
  assert.equal(precheckSettle(d, p(), 500n), null);
  assert.match(precheckSettle(d, p({ split_bps: '10001' }), 500n)!, /split_bps/);
  assert.match(precheckSettle(d, p({ split_bps: '07000' }), 500n)!, /split_bps/);
  assert.match(precheckSettle(d, p({ seq: '1' }), 500n)!, /revoked/);
  assert.match(precheckSettle(d, p({ state: 'Funded' }), 500n)!, /signed for Funded/);
  assert.match(precheckSettle(d, p({ expires_at_ns: '499' }), 500n)!, /expired/);
  assert.match(precheckSettle(d, p({ nonce: '' }), 500n)!, /nonce/);
  assert.match(precheckSettle(d, p(), 511n)!, /timer is over/, 'after the review end the timeout rules win');
  assert.match(precheckSettle(deal({ state: 'Released' }), p({ state: 'Released', seq: '0' }), 0n)!, /Released/);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { NearChain } from '../src/chain.ts';

test('relayer transactions are serialized (no concurrent nonces)', async () => {
  const chain = new NearChain({
    rpcUrl: 'http://127.0.0.1:9',
    contractId: 'escrow.test.near',
    relayerAccountId: 'relayer.test.near',
    // throwaway key, never used for a real network
    relayerPrivateKey: 'ed25519:3tgdk2wPraJzT4nsTuf86UX41xgPNk3MHnq8epARMdBNs29AFEztAuaQ7iHddDfXG9F2RzV1XNQYgJyAyoW51UBB',
  });
  let active = 0;
  let maxActive = 0;
  const order: string[] = [];
  (chain as unknown as { send: (m: string) => Promise<unknown> }).send = async (method: string) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 20));
    order.push(method);
    active--;
    if (method === 'release_after_timeout') throw new Error('boom');
    return { txHash: method, value: true };
  };
  const results = await Promise.allSettled([
    chain.act(0, 'accept', '{}', 'sig'),
    chain.releaseAfterTimeout(0),
    chain.createDeal('{}', 'sig', 'pk'),
  ]);
  assert.equal(maxActive, 1);
  assert.deepEqual(order, ['act', 'release_after_timeout', 'create_deal']);
  assert.equal(results[1].status, 'rejected');
  assert.equal(results[2].status, 'fulfilled', 'a failed tx does not block the queue');
});

test('relayer queue: earliest deadline first, then arrival order', async () => {
  const chain = new NearChain({
    rpcUrl: 'http://127.0.0.1:9',
    contractId: 'escrow.test.near',
    relayerAccountId: 'relayer.test.near',
    relayerPrivateKey: 'ed25519:3tgdk2wPraJzT4nsTuf86UX41xgPNk3MHnq8epARMdBNs29AFEztAuaQ7iHddDfXG9F2RzV1XNQYgJyAyoW51UBB',
  });
  const order: string[] = [];
  (chain as unknown as { send: (m: string, a: Record<string, unknown>) => Promise<unknown> }).send = async (method, args) => {
    await new Promise((r) => setTimeout(r, 10));
    order.push(String(args.action ?? method));
    return { txHash: method, value: true };
  };
  await Promise.all([
    chain.createDeal('{}', 'sig', 'pk'), // starts immediately
    chain.act(0, 'withdraw', '{}', 's1', 900n),
    chain.releaseAfterTimeout(1), // no deadline
    chain.act(2, 'dispute', '{}', 's2', 100n),
    chain.act(3, 'cancel', '{}', 's3'), // no deadline
    chain.act(4, 'deliver', '{}', 's4', 500n),
  ]);
  assert.deepEqual(order, ['create_deal', 'dispute', 'deliver', 'withdraw', 'release_after_timeout', 'cancel']);
});

test('relayer drops a queued tx whose contract deadline passed while it waited (no gas for a sure failure)', async () => {
  let t = 0n;
  const chain = new NearChain({
    rpcUrl: 'http://127.0.0.1:9',
    contractId: 'escrow.test.near',
    relayerAccountId: 'relayer.test.near',
    relayerPrivateKey: 'ed25519:3tgdk2wPraJzT4nsTuf86UX41xgPNk3MHnq8epARMdBNs29AFEztAuaQ7iHddDfXG9F2RzV1XNQYgJyAyoW51UBB',
    nowNs: () => t,
  });
  const sent: string[] = [];
  (chain as unknown as { send: (m: string, a: Record<string, unknown>) => Promise<unknown> }).send = async (method, args) => {
    await new Promise((r) => setTimeout(r, 10));
    sent.push(String(args.action ?? method));
    t += 10_000_000_000n; // each tx takes "10 s"
    return { txHash: method, value: true };
  };
  const [first, late, ok] = await Promise.allSettled([
    chain.createDeal('{}', 'sig', 'pk'),
    chain.act(0, 'dispute', '{}', 's', 1n, 1n), // hard deadline long past by its turn
    chain.act(1, 'accept', '{}', 's2', 2n, null), // no hard deadline
  ]);
  assert.equal(first.status, 'fulfilled');
  assert.equal(late.status, 'rejected');
  assert.equal((late as PromiseRejectedResult).reason.name, 'DeadlinePassedError');
  assert.equal(ok.status, 'fulfilled');
  assert.deepEqual(sent, ['create_deal', 'accept']);
});

test('timeouts queued with their due time run before deadline-less withdraws', async () => {
  const chain = new NearChain({
    rpcUrl: 'http://127.0.0.1:9',
    contractId: 'escrow.test.near',
    relayerAccountId: 'relayer.test.near',
    relayerPrivateKey: 'ed25519:3tgdk2wPraJzT4nsTuf86UX41xgPNk3MHnq8epARMdBNs29AFEztAuaQ7iHddDfXG9F2RzV1XNQYgJyAyoW51UBB',
  });
  const order: string[] = [];
  (chain as unknown as { send: (m: string, a: Record<string, unknown>) => Promise<unknown> }).send = async (method, args) => {
    await new Promise((r) => setTimeout(r, 10));
    order.push(String(args.action ?? method));
    return { txHash: method, value: true };
  };
  await Promise.all([
    chain.createDeal('{}', 'sig', 'pk'),
    chain.act(0, 'withdraw', '{}', 's1'),
    chain.resolveDisputeTimeout(1),
  ]);
  // Timeouts no longer jump ahead (no deadline, arrival order).
  assert.deepEqual(order, ['create_deal', 'withdraw', 'resolve_dispute_timeout']);
});

test('an RPC error after sending is reported as "outcome unknown", not as an internal error', async () => {
  const { RelayerTimeoutError } = await import('../src/chain.ts');
  const chain = new NearChain({
    rpcUrl: 'http://127.0.0.1:9',
    contractId: 'escrow.test.near',
    relayerAccountId: 'relayer.test.near',
    relayerPrivateKey: 'ed25519:3tgdk2wPraJzT4nsTuf86UX41xgPNk3MHnq8epARMdBNs29AFEztAuaQ7iHddDfXG9F2RzV1XNQYgJyAyoW51UBB',
  });
  (chain as unknown as { relayer: { callFunctionRaw: () => Promise<unknown> } }).relayer.callFunctionRaw = () =>
    Promise.reject(Object.assign(new Error('Internal server error'), { cause: 500 }));
  await assert.rejects(chain.act(0, 'withdraw', '{}', 's'), (e) => e instanceof RelayerTimeoutError);
});

test('a hung RPC send times out and the queue moves on', async () => {
  const { RelayerTimeoutError } = await import('../src/chain.ts');
  const chain = new NearChain({
    rpcUrl: 'http://127.0.0.1:9',
    contractId: 'escrow.test.near',
    relayerAccountId: 'relayer.test.near',
    relayerPrivateKey: 'ed25519:3tgdk2wPraJzT4nsTuf86UX41xgPNk3MHnq8epARMdBNs29AFEztAuaQ7iHddDfXG9F2RzV1XNQYgJyAyoW51UBB',
    sendTimeoutMs: 50,
  });
  let n = 0;
  (chain as unknown as { relayer: { callFunctionRaw: () => Promise<unknown> } }).relayer.callFunctionRaw = () => {
    n++;
    // the first send never answers; the second answers at once
    if (n === 1) return new Promise(() => {});
    return Promise.resolve({ transaction: { hash: 'h2' }, status: { SuccessValue: '' } });
  };
  const [a, b] = await Promise.allSettled([chain.act(0, 'deliver', '{}', 's1'), chain.act(1, 'accept', '{}', 's2')]);
  assert.equal(a.status, 'rejected');
  assert.ok((a as PromiseRejectedResult).reason instanceof RelayerTimeoutError);
  assert.equal(b.status, 'fulfilled', 'the next tx is sent after the timeout');
});

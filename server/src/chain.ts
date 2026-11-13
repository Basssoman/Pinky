// NEAR access: views + the relayer that signs transactions with
// RELAYER_ACCOUNT_ID / RELAYER_PRIVATE_KEY (near-api-js v7).
//
// The relayer can only call `create_deal` (needs a creator-signed offer),
// `act` (needs a deal-key signature it cannot forge), `settle` (needs BOTH
// deal-key signatures), `revoke_offer` (creator-signed) and the timeout
// methods (anyone). It can never move funds on its own. Relayer
// transactions are serialized through one queue to avoid nonce collisions.
// Contract v2: a relayed withdraw attaches WITHDRAW_DEPOSIT (the submitter
// pays the storage it costs).

import { Account, JsonRpcProvider, KeyPairSigner, type KeyPairString } from 'near-api-js';

import { DEAL_DEPOSIT_YOCTO, REVOKE_DEPOSIT_YOCTO, WITHDRAW_DEPOSIT_YOCTO } from './encoding.ts';

export type DealState =
  | 'Created'
  | 'Funded'
  | 'Delivered'
  | 'Released'
  | 'PaidOut'
  | 'Disputed'
  | 'Refunded'
  | 'Cancelled'
  | 'Expired';

/** How a deal ended (contract v2 `Outcome`, externally tagged JSON). */
export type Outcome =
  | 'Accepted'
  | 'AutoReleased'
  | 'RefundedByCreator'
  | 'RefundedAfterDeadline'
  | 'Cancelled'
  | 'ClosedUnpaid'
  | { ArbiterSplit: { creator_share_bps: number } }
  | { TimeoutSplit: { creator_share_bps: number } }
  | { Settled: { creator_share_bps: number } };

/** Contract `DealView`. */
export interface DealView {
  id: number;
  amount: string;
  funded_amount: string;
  state: DealState;
  creator_pk: string;
  client_pk: string;
  fee_bps: number;
  fee_amount: string;
  delivery_duration_ns: string;
  /** null until the deal is funded (deadline = funded_at + duration). */
  delivery_deadline_ns: string | null;
  review_period_ns: string;
  pay_by_ns: string;
  /** After this a payment no longer funds the deal (pay_by + grace). */
  funding_cutoff_ns: string;
  funded_at_ns: string | null;
  delivered_at_ns: string | null;
  deliverable_hash: string | null;
  terms_hash: string;
  creator_payout: string;
  client_payout: string;
  created_at_ns: string;
  review_ends_at_ns: string | null;
  disputed_at_ns: string | null;
  dispute_ends_at_ns: string | null;
  ended_at_ns: string | null;
  outcome: Outcome | null;
  settle_seq: number;
  creator_pending: string;
  client_pending: string;
  creator_withdrawn: string;
  client_withdrawn: string;
  settled: boolean;
  creator_fingerprint: string;
  client_fingerprint: string;
  /** true when the deal was purged and this view was rebuilt from its tombstone. */
  purged?: boolean;
}

/** Contract `TombstoneView`: what is left of a purged deal. */
export interface TombstoneView {
  id: number;
  state: DealState;
  outcome: Outcome | null;
  ended_at_ns: string;
  creator_pk: string;
  client_pk: string;
  client_payout: string;
  client_pending: string;
  client_withdrawn: string;
  creator_fingerprint: string;
  client_fingerprint: string;
}

/**
 * A purged deal as a `DealView`: only the keys, how it ended and the
 * client's leftover money are real; everything else is empty. The client
 * key withdraws that money with the normal `act(withdraw)` on the deal id.
 */
export function tombstoneAsDeal(t: TombstoneView): DealView {
  return {
    id: t.id,
    amount: '0',
    funded_amount: '0',
    state: t.state,
    creator_pk: t.creator_pk,
    client_pk: t.client_pk,
    fee_bps: 0,
    fee_amount: '0',
    delivery_duration_ns: '0',
    delivery_deadline_ns: null,
    review_period_ns: '0',
    pay_by_ns: '0',
    funding_cutoff_ns: '0',
    funded_at_ns: null,
    delivered_at_ns: null,
    deliverable_hash: null,
    terms_hash: '',
    creator_payout: '0',
    client_payout: t.client_payout,
    created_at_ns: '0',
    review_ends_at_ns: null,
    disputed_at_ns: null,
    dispute_ends_at_ns: null,
    ended_at_ns: t.ended_at_ns,
    outcome: t.outcome,
    settle_seq: 0,
    creator_pending: '0',
    client_pending: t.client_pending,
    creator_withdrawn: '0',
    client_withdrawn: t.client_withdrawn,
    settled: t.client_payout === '0' && t.client_pending === '0',
    creator_fingerprint: t.creator_fingerprint,
    client_fingerprint: t.client_fingerprint,
    purged: true,
  };
}

export interface TxResult<T = unknown> {
  txHash: string;
  value: T;
}

/** A transaction reached the chain but the contract rejected it. */
export class ChainCallError extends Error {
  readonly txHash: string | undefined;
  constructor(message: string, txHash?: string) {
    super(message);
    this.name = 'ChainCallError';
    this.txHash = txHash;
  }
}

/**
 * The RPC did not answer a relayer send in time. The tx may
 * still land later: re-read the deal before retrying. The contract makes a
 * retry safe (a used withdraw signature, a changed state, a used offer are
 * refused).
 */
export class RelayerTimeoutError extends Error {
  constructor(message = 'the network did not answer in time; the transaction may still land, re-read the deal before retrying') {
    super(message);
    this.name = 'RelayerTimeoutError';
  }
}

/** The relayer dropped a queued transaction whose contract deadline passed before it could be sent. */
export class DeadlinePassedError extends Error {
  constructor(message = 'the deadline passed before the relayer could send this transaction') {
    super(message);
    this.name = 'DeadlinePassedError';
  }
}

export interface Chain {
  readonly contractId: string;
  /** The deal, or (for a purged deal) its tombstone as a view with `purged: true`. */
  getDeal(id: number): Promise<DealView | null>;
  createDeal(offer: string, offerSignature: string, clientPk: string): Promise<TxResult<number>>;
  /**
   * `deadlineNs`: earlier deadlines are relayed first (default: none).
   * `hardDeadlineNs`: if it has passed when the tx's turn comes, the tx is
   * not sent and DeadlinePassedError is thrown (the contract would reject it).
   */
  act(
    dealId: number,
    action: string,
    payload: string,
    signature: string,
    deadlineNs?: bigint,
    hardDeadlineNs?: bigint | null,
  ): Promise<TxResult<unknown>>;
  /** Mutual split with both deal-key signatures ("Dogovoritsya"). */
  settle(
    dealId: number,
    payload: string,
    creatorSignature: string,
    clientSignature: string,
    deadlineNs?: bigint,
    hardDeadlineNs?: bigint | null,
  ): Promise<TxResult<unknown>>;
  /** Creator-signed revocation of an unjoined offer (attaches REVOKE_DEPOSIT). */
  revokeOffer(offer: string, signature: string): Promise<TxResult<unknown>>;
  /**
   * Timeouts are queued with NO deadline, behind every deliver/dispute
   * (queued at their past due time they outranked a dispute).
   * A late timeout costs nobody anything: after the review / dispute end /
   * funding cutoff the contract refuses the competing actions anyway.
   */
  releaseAfterTimeout(dealId: number): Promise<TxResult<unknown>>;
  resolveDisputeTimeout(dealId: number): Promise<TxResult<unknown>>;
  /** Created -> Expired after the funding cutoff. */
  closeUnpaid(dealId: number): Promise<TxResult<unknown>>;
  /** false only if the NEAR account certainly does not exist. */
  accountExists(accountId: string): Promise<boolean>;
  /** Available NEAR (yocto) of escrow and relayer accounts. */
  getNearBalances(): Promise<{ escrow: bigint; relayer: bigint }>;
  /** Deal id created from this exact offer string, if any. */
  getDealIdByOffer(offer: string): Promise<number | null>;
  /** Whether a withdraw signature (signer key, deal, payload) was already used. */
  isWithdrawUsed(dealId: number, payload: string, signerPk: string): Promise<boolean>;
}

/** "No deadline" sort key for the relayer queue. */
const NO_DEADLINE = 2n ** 64n;
/** Clock-skew allowance before a hard deadline counts as passed. */
const HARD_DEADLINE_GRACE_NS = 5_000_000_000n;

/**
 * Prepaid gas per action. Prepaid gas is bought at
 * runtime_config.min_gas_purchase_price (10x the gas price on protocol 86)
 * and unused gas is not fully refunded, so attach only what is needed:
 * withdraw needs >= 100 TGas (contract check; storage_deposit + ft_transfer +
 * callback), every other action is a plain state change.
 */
export function actGasTgas(action: string): bigint {
  return action === 'withdraw' ? 150n : 30n;
}

/** NEAR (yocto) the submitter must attach to `act`: only withdraw needs it. */
export function actDeposit(action: string): bigint {
  return action === 'withdraw' ? WITHDRAW_DEPOSIT_YOCTO : 0n;
}

/** The exact `act` call any NEAR account can submit itself (permissionless). */
export function actCall(contractId: string, dealId: number, action: string, payload: string, signature: string) {
  return {
    contract_id: contractId,
    method_name: 'act',
    args: { deal_id: dealId, action, payload, signature },
    gas: (actGasTgas(action) * TGAS).toString(),
    deposit: actDeposit(action).toString(),
  };
}

const TGAS = 1_000_000_000_000n;
/** 1e19 yocto per byte of storage. */
const STORAGE_PRICE = 10_000_000_000_000_000_000n;

export interface NearChainOptions {
  rpcUrl: string;
  /** RPC for relayer sends (default: rpcUrl). */
  rpcSendUrl?: string;
  contractId: string;
  relayerAccountId: string;
  relayerPrivateKey: string;
  /** Clock for hard deadlines (tests). */
  nowNs?: () => bigint;
  /**
   * Max wait for one relayer send (default 120 s; 60 s was too short for
   * a withdraw on the free mainnet RPC, seen 2026-11-06). near-api-js passes no
   * timeout to fetch (undici waits up to 300 s, with retries), and the queue
   * sends one tx at a time, so one hung RPC call froze every deal.
   * After the timeout the queue moves on; nonces are tracked locally
   * by near-api-js, so the next tx does not clash with the hung one.
   */
  sendTimeoutMs?: number;
}

export class NearChain implements Chain {
  readonly contractId: string;
  private readonly provider: JsonRpcProvider;
  private readonly relayer: Account;
  private readonly relayerId: string;
  private readonly queue: { deadline: bigint; seq: number; hardDeadline: bigint | null; run: () => Promise<void>; drop: () => void }[] = [];
  private readonly nowNs: () => bigint;
  private readonly sendTimeoutMs: number;
  private seq = 0;
  private busy = false;

  constructor(opts: NearChainOptions) {
    this.contractId = opts.contractId;
    this.relayerId = opts.relayerAccountId;
    this.provider = new JsonRpcProvider({ url: opts.rpcUrl });
    const sendProvider = opts.rpcSendUrl && opts.rpcSendUrl !== opts.rpcUrl ? new JsonRpcProvider({ url: opts.rpcSendUrl }) : this.provider;
    const signer = KeyPairSigner.fromSecretKey(opts.relayerPrivateKey as KeyPairString);
    this.relayer = new Account(opts.relayerAccountId, sendProvider, signer);
    this.nowNs = opts.nowNs ?? (() => BigInt(Date.now()) * 1_000_000n);
    this.sendTimeoutMs = opts.sendTimeoutMs ?? 120_000;
  }

  async view<T>(method: string, args: Record<string, unknown>): Promise<T> {
    return (await this.provider.callFunction({ contractId: this.contractId, method, args })) as T;
  }

  async getDeal(id: number): Promise<DealView | null> {
    const deal = (await this.view<DealView | null>('get_deal', { deal_id: id })) ?? null;
    if (deal) return deal;
    // Purged: the client's leftover money is still withdrawable.
    const tomb = (await this.view<TombstoneView | null>('get_tombstone', { deal_id: id })) ?? null;
    return tomb ? tombstoneAsDeal(tomb) : null;
  }

  createDeal(offer: string, offerSignature: string, clientPk: string): Promise<TxResult<number>> {
    // The relayer pays the deal's storage up front (contract v2).
    return this.call<number>(
      'create_deal',
      { offer, offer_signature: offerSignature, client_pk: clientPk },
      30n,
      NO_DEADLINE,
      null,
      DEAL_DEPOSIT_YOCTO,
    );
  }

  act(
    dealId: number,
    action: string,
    payload: string,
    signature: string,
    deadlineNs: bigint = NO_DEADLINE,
    hardDeadlineNs: bigint | null = null,
  ): Promise<TxResult<unknown>> {
    // withdraw needs >= 100 TGas (contract check); give everything headroom.
    return this.call(
      'act',
      { deal_id: dealId, action, payload, signature },
      actGasTgas(action),
      deadlineNs,
      hardDeadlineNs,
      actDeposit(action),
    );
  }

  settle(
    dealId: number,
    payload: string,
    creatorSignature: string,
    clientSignature: string,
    deadlineNs: bigint = NO_DEADLINE,
    hardDeadlineNs: bigint | null = null,
  ): Promise<TxResult<unknown>> {
    return this.call(
      'settle',
      { deal_id: dealId, payload, creator_signature: creatorSignature, client_signature: clientSignature },
      30n,
      deadlineNs,
      hardDeadlineNs,
    );
  }

  revokeOffer(offer: string, signature: string): Promise<TxResult<unknown>> {
    return this.call('revoke_offer', { offer, signature }, 30n, NO_DEADLINE, null, REVOKE_DEPOSIT_YOCTO);
  }

  closeUnpaid(dealId: number): Promise<TxResult<unknown>> {
    return this.call('close_unpaid', { deal_id: dealId }, 30n);
  }

  async accountExists(accountId: string): Promise<boolean> {
    try {
      await this.provider.viewAccount({ accountId });
      return true;
    } catch (e) {
      // Only a definite "does not exist" counts; network errors do not block.
      return !/does not exist|UNKNOWN_ACCOUNT|AccountDoesNotExist/i.test(String((e as Error)?.message ?? e));
    }
  }

  async getDealIdByOffer(offer: string): Promise<number | null> {
    const v = await this.view<number | null>('get_deal_id_by_offer', { offer });
    return typeof v === 'number' ? v : null;
  }

  async isWithdrawUsed(dealId: number, payload: string, signerPk: string): Promise<boolean> {
    return (await this.view<boolean>('is_withdraw_used', { deal_id: dealId, payload, signer_pk: signerPk })) === true;
  }

  releaseAfterTimeout(dealId: number): Promise<TxResult<unknown>> {
    return this.call('release_after_timeout', { deal_id: dealId }, 30n);
  }

  resolveDisputeTimeout(dealId: number): Promise<TxResult<unknown>> {
    return this.call('resolve_dispute_timeout', { deal_id: dealId }, 30n);
  }

  async getNearBalances(): Promise<{ escrow: bigint; relayer: bigint }> {
    const available = async (accountId: string) => {
      const a = (await this.provider.viewAccount({ accountId })) as unknown as {
        amount: string | bigint;
        storage_usage?: number | bigint;
        storageUsage?: number | bigint;
      };
      const usage = BigInt(a.storage_usage ?? a.storageUsage ?? 0);
      const total = BigInt(a.amount);
      const locked = usage * STORAGE_PRICE;
      return total > locked ? total - locked : 0n;
    };
    const [escrow, relayer] = await Promise.all([available(this.contractId), available(this.relayerId)]);
    return { escrow, relayer };
  }

  /**
   * Serialized: one relayer transaction at a time (no nonce collisions).
   * Earliest deadline runs first; equal deadlines keep arrival order.
   */
  private call<T>(
    methodName: string,
    args: Record<string, unknown>,
    tgas: bigint,
    deadline: bigint = NO_DEADLINE,
    hardDeadline: bigint | null = null,
    deposit: bigint = 0n,
  ): Promise<TxResult<T>> {
    return new Promise<TxResult<T>>((resolve, reject) => {
      this.queue.push({
        deadline,
        seq: this.seq++,
        hardDeadline,
        run: () => this.send<T>(methodName, args, tgas, deposit).then(resolve, reject),
        drop: () => reject(new DeadlinePassedError()),
      });
      this.queue.sort((a, b) => (a.deadline < b.deadline ? -1 : a.deadline > b.deadline ? 1 : a.seq - b.seq));
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (let job = this.queue.shift(); job; job = this.queue.shift()) {
        // Re-checked at send time: a tx that can only fail is not paid for.
        if (job.hardDeadline !== null && this.nowNs() > job.hardDeadline + HARD_DEADLINE_GRACE_NS) job.drop();
        else await job.run();
      }
    } finally {
      this.busy = false;
    }
  }

  private async send<T>(methodName: string, args: Record<string, unknown>, tgas: bigint, deposit: bigint): Promise<TxResult<T>> {
    let res: Awaited<ReturnType<Account['callFunctionRaw']>>;
    const call = this.relayer.callFunctionRaw({
      contractId: this.contractId,
      methodName,
      args,
      gas: tgas * TGAS,
      deposit,
      waitUntil: 'EXECUTED_OPTIMISTIC',
    });
    call.catch(() => {}); // a late failure after the timeout must not crash the process
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new RelayerTimeoutError()), this.sendTimeoutMs);
    });
    try {
      res = await Promise.race([call, timeout]);
    } catch (e) {
      if (e instanceof RelayerTimeoutError) throw e;
      const err = toChainError(e);
      // A contract rejection (with a tx hash) and "not enough NEAR" are known
      // outcomes. Any other error (an RPC 500, a dropped connection) may come
      // AFTER the tx was sent: the outcome is unknown, so say so instead of
      // "internal error" (seen on mainnet 2026-11-06: drpc answered 500 to a
      // withdraw that landed).
      if (err instanceof ChainCallError || (err as Error).name === 'NotEnoughBalanceError') throw err;
      const why = String((err as Error)?.message ?? err).slice(0, 200);
      throw new RelayerTimeoutError(`the network answered with an error (${why}); the transaction may still land, re-read the deal before retrying`);
    } finally {
      clearTimeout(timer);
    }
    const txHash = res.transaction.hash;
    const status = res.status as unknown;
    if (status && typeof status === 'object' && 'Failure' in status) {
      throw new ChainCallError(describeFailure((status as { Failure: unknown }).Failure), txHash);
    }
    const b64 =
      status && typeof status === 'object' && 'SuccessValue' in status
        ? String((status as { SuccessValue: unknown }).SuccessValue ?? '')
        : '';
    const text = b64 ? Buffer.from(b64, 'base64').toString('utf8') : '';
    let value: unknown = null;
    if (text) {
      try {
        value = JSON.parse(text);
      } catch {
        value = text;
      }
    }
    return { txHash, value: value as T };
  }
}

function describeFailure(failure: unknown): string {
  const s = JSON.stringify(failure);
  const m = /"(?:panic_msg|PanicMsg|ExecutionError)":"((?:[^"\\]|\\.)*)"/.exec(s);
  return m ? stripPanic(m[1]) : s.slice(0, 500);
}

function toChainError(e: unknown): Error {
  if (e instanceof ChainCallError) return e;
  const err = e as { panicMessage?: string; message?: string; transactionResult?: { transaction?: { hash?: string } } };
  const txHash = err?.transactionResult?.transaction?.hash;
  if (typeof err?.panicMessage === 'string') return new ChainCallError(stripPanic(err.panicMessage), txHash);
  if (txHash) return new ChainCallError(stripPanic(err.message ?? 'transaction failed'), txHash);
  return e instanceof Error ? e : new Error(String(e));
}

function stripPanic(msg: string): string {
  return msg.replace(/^.*?Smart contract panicked: /s, '');
}

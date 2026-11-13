// Off-chain storage (node:sqlite, built into Node >= 22.13; no native deps).
//
// Privacy:
// - A deal is addressed by `handle` = sha256(link token). The token itself
//   (128-bit, in the link fragment) is never stored.
// - Plain terms ARE stored (the operator can read them).
// - Refund addresses, payout recipients and deposit addresses are NOT
//   stored; only sha256(deposit_address) to check that a status lookup
//   belongs to the deal.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface DealRecord {
  handle: string;
  offer: string;
  offer_signature: string;
  creator_pk: string;
  title: string;
  description: string;
  salt: string;
  amount: string;
  /** Contract v2: work time counted from funding. */
  delivery_duration_ns: string;
  review_period_ns: string;
  /** Agreed number of revisions ("" if not set). */
  revisions: string;
  fee_bps: string;
  terms_hash: string;
  deal_id: number | null;
  created_at: string;
  joined_at: string | null;
  /** Set once the creator's `revoke_offer` landed (the link can never start a deal). */
  revoked_at: string | null;
}

export type NewDeal = Omit<DealRecord, 'deal_id' | 'created_at' | 'joined_at' | 'revoked_at'>;
export type QuoteKind = 'pay' | 'payout';

/** A signed "Agree on a split" proposal waiting for the other party's signature. */
export interface SettleProposal {
  handle: string;
  signer: 'creator' | 'client';
  payload: string;
  signature: string;
  created_at: string;
}

/**
 * An encrypted note of one party: the files link, the dispute point
 * and text, the copies for the arbiter. The server stores ciphertext only;
 * `payload` is the exact JSON the party signed (`data` inside is ciphertext).
 */
export interface DealNote {
  handle: string;
  kind: string;
  signer: 'creator' | 'client';
  payload: string;
  signature: string;
  created_at: string;
}

/** One line of the public dispute-decision log: no names, amounts or deal ids. */
export interface DisputeLogEntry {
  month: string;
  outcome: string;
  reason: string;
}

export interface Store {
  /** Rolling daily counters that survive a restart (deal-scoped keys only). */
  countEventsSince(key: string, sinceMs: number): number;
  addEvent(key: string, atMs: number): void;
  insertDeal(d: NewDeal): void;
  getDeal(handle: string): DealRecord | null;
  /** Whether this exact offer is already stored under some handle. */
  offerExists(offer: string): boolean;
  setDealId(handle: string, dealId: number): void;
  markRevoked(handle: string): void;
  /** Rows created / joined since this ISO time (daily caps). */
  countOffersSince(iso: string): number;
  countJoinsSince(iso: string): number;
  saveQuoteRef(handle: string, kind: QuoteKind, depositAddressHash: string, deadline: string | null): void;
  hasQuoteRef(handle: string, kind: QuoteKind, depositAddressHash: string): boolean;
  /** Latest quote deadline (ISO) of this kind that is still in the future, or null. */
  liveQuoteDeadline(handle: string, kind: QuoteKind, nowIso: string): string | null;
  /** One open proposal per signer; a new one replaces the old one. */
  saveSettleProposal(p: Omit<SettleProposal, 'created_at'>): void;
  getSettleProposals(handle: string): SettleProposal[];
  /** One note per (deal, kind); a new one replaces the old one. */
  saveNote(n: Omit<DealNote, 'created_at'>): void;
  getNotes(handle: string): DealNote[];
  getDealById(dealId: number): DealRecord | null;
  /** One log line per deal; a second decision for the same deal replaces it. */
  saveDisputeDecision(dealId: number, month: string, outcome: string, reason: string): void;
  /** Public log lines created before this ISO time, newest first. */
  getDisputeLog(beforeIso: string, limit: number): DisputeLogEntry[];
  close(): void;
}

export class SqliteStore implements Store {
  /** Shared with the marketplace tables (market.ts). */
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS deals (
        handle TEXT PRIMARY KEY,
        offer TEXT NOT NULL,
        offer_signature TEXT NOT NULL,
        creator_pk TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        salt TEXT NOT NULL,
        amount TEXT NOT NULL,
        delivery_duration_ns TEXT NOT NULL,
        review_period_ns TEXT NOT NULL,
        revisions TEXT NOT NULL,
        fee_bps TEXT NOT NULL,
        terms_hash TEXT NOT NULL,
        deal_id INTEGER UNIQUE,
        created_at TEXT NOT NULL,
        joined_at TEXT,
        revoked_at TEXT
      );
      -- One handle per offer: a copied offer under a second handle would orphan
      -- the creator's handle.
      CREATE UNIQUE INDEX IF NOT EXISTS deals_offer ON deals (offer);
      CREATE TABLE IF NOT EXISTS quote_refs (
        handle TEXT NOT NULL,
        kind TEXT NOT NULL,
        deposit_address_hash TEXT NOT NULL,
        deadline TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (handle, kind, deposit_address_hash)
      );
      -- Daily counters of relayed txs per deal / link (never IP addresses).
      CREATE TABLE IF NOT EXISTS counters (
        key TEXT NOT NULL,
        at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS counters_key_at ON counters (key, at);
      CREATE TABLE IF NOT EXISTS settle_proposals (
        handle TEXT NOT NULL,
        signer TEXT NOT NULL,
        payload TEXT NOT NULL,
        signature TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (handle, signer)
      );
      -- Encrypted party notes (ciphertext only): files link, dispute point, arbiter copies.
      CREATE TABLE IF NOT EXISTS notes (
        handle TEXT NOT NULL,
        kind TEXT NOT NULL,
        signer TEXT NOT NULL,
        payload TEXT NOT NULL,
        signature TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (handle, kind)
      );
      -- Public dispute-decision log: month, outcome, one-line reason.
      CREATE TABLE IF NOT EXISTS dispute_log (
        deal_id INTEGER PRIMARY KEY,
        month TEXT NOT NULL,
        outcome TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  insertDeal(d: NewDeal): void {
    this.db
      .prepare(
        `INSERT INTO deals (handle, offer, offer_signature, creator_pk, title, description, salt, amount,
           delivery_duration_ns, review_period_ns, revisions, fee_bps, terms_hash, deal_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      )
      .run(
        d.handle,
        d.offer,
        d.offer_signature,
        d.creator_pk,
        d.title,
        d.description,
        d.salt,
        d.amount,
        d.delivery_duration_ns,
        d.review_period_ns,
        d.revisions,
        d.fee_bps,
        d.terms_hash,
        new Date().toISOString(),
      );
  }

  getDeal(handle: string): DealRecord | null {
    const row = this.db.prepare('SELECT * FROM deals WHERE handle = ?').get(handle);
    return (row as DealRecord | undefined) ?? null;
  }

  private addsSincePrune = 0;

  countEventsSince(key: string, sinceMs: number): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM counters WHERE key = ? AND at > ?').get(key, sinceMs) as { n: number }).n);
  }

  addEvent(key: string, atMs: number): void {
    this.db.prepare('INSERT INTO counters (key, at) VALUES (?, ?)').run(key, atMs);
    // Rows older than 2 days are never read again.
    if (++this.addsSincePrune >= 500) {
      this.addsSincePrune = 0;
      this.db.prepare('DELETE FROM counters WHERE at < ?').run(atMs - 2 * 24 * 3600 * 1000);
    }
  }

  offerExists(offer: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM deals WHERE offer = ?').get(offer);
  }

  setDealId(handle: string, dealId: number): void {
    this.db
      .prepare('UPDATE deals SET deal_id = ?, joined_at = ? WHERE handle = ? AND deal_id IS NULL')
      .run(dealId, new Date().toISOString(), handle);
  }

  markRevoked(handle: string): void {
    this.db.prepare('UPDATE deals SET revoked_at = ? WHERE handle = ? AND revoked_at IS NULL').run(new Date().toISOString(), handle);
  }

  countOffersSince(iso: string): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM deals WHERE created_at >= ?').get(iso) as { n: number }).n);
  }

  countJoinsSince(iso: string): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM deals WHERE joined_at >= ?').get(iso) as { n: number }).n);
  }

  saveQuoteRef(handle: string, kind: QuoteKind, depositAddressHash: string, deadline: string | null): void {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO quote_refs (handle, kind, deposit_address_hash, deadline, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(handle, kind, depositAddressHash, deadline, new Date().toISOString());
  }

  hasQuoteRef(handle: string, kind: QuoteKind, depositAddressHash: string): boolean {
    return !!this.db
      .prepare('SELECT 1 FROM quote_refs WHERE handle = ? AND kind = ? AND deposit_address_hash = ?')
      .get(handle, kind, depositAddressHash);
  }

  liveQuoteDeadline(handle: string, kind: QuoteKind, nowIso: string): string | null {
    const row = this.db
      .prepare(
        'SELECT MAX(deadline) AS d FROM quote_refs WHERE handle = ? AND kind = ? AND deadline IS NOT NULL AND deadline > ?',
      )
      .get(handle, kind, nowIso) as { d: string | null } | undefined;
    return row?.d ?? null;
  }

  saveSettleProposal(p: Omit<SettleProposal, 'created_at'>): void {
    this.db
      .prepare(
        `INSERT INTO settle_proposals (handle, signer, payload, signature, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (handle, signer) DO UPDATE SET payload = excluded.payload, signature = excluded.signature,
           created_at = excluded.created_at`,
      )
      .run(p.handle, p.signer, p.payload, p.signature, new Date().toISOString());
  }

  getSettleProposals(handle: string): SettleProposal[] {
    return this.db
      .prepare('SELECT handle, signer, payload, signature, created_at FROM settle_proposals WHERE handle = ? ORDER BY signer')
      .all(handle) as unknown as SettleProposal[];
  }

  saveNote(n: Omit<DealNote, 'created_at'>): void {
    this.db
      .prepare(
        `INSERT INTO notes (handle, kind, signer, payload, signature, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (handle, kind) DO UPDATE SET signer = excluded.signer, payload = excluded.payload,
           signature = excluded.signature, created_at = excluded.created_at`,
      )
      .run(n.handle, n.kind, n.signer, n.payload, n.signature, new Date().toISOString());
  }

  getNotes(handle: string): DealNote[] {
    return this.db
      .prepare('SELECT handle, kind, signer, payload, signature, created_at FROM notes WHERE handle = ? ORDER BY kind')
      .all(handle) as unknown as DealNote[];
  }

  getDealById(dealId: number): DealRecord | null {
    const row = this.db.prepare('SELECT * FROM deals WHERE deal_id = ?').get(dealId);
    return (row as DealRecord | undefined) ?? null;
  }

  saveDisputeDecision(dealId: number, month: string, outcome: string, reason: string): void {
    this.db
      .prepare(
        `INSERT INTO dispute_log (deal_id, month, outcome, reason, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (deal_id) DO UPDATE SET month = excluded.month, outcome = excluded.outcome,
           reason = excluded.reason, created_at = excluded.created_at`,
      )
      .run(dealId, month, outcome, reason, new Date().toISOString());
  }

  getDisputeLog(beforeIso: string, limit: number): DisputeLogEntry[] {
    return this.db
      .prepare('SELECT month, outcome, reason FROM dispute_log WHERE created_at < ? ORDER BY created_at DESC LIMIT ?')
      .all(beforeIso, limit) as unknown as DisputeLogEntry[];
  }

  close(): void {
    this.db.close();
  }
}

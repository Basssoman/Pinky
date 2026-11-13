// Telegram notifications: one-time subscribe codes and
// subscriptions. Privacy rules:
// - a subscription row is chat id ↔ deal handle + party, never a per-user
//   record; no keys, links or deal details are stored;
// - only a client who subscribed BEFORE joining keeps its public key here
//   (`pending_pk`) until the chain shows it is the deal's client key; then it
//   is cleared (a public key is not a secret, but it is not needed after that);
// - codes are stored as sha256 only and expire after 30 minutes;
// - every row of a deal is deleted when the deal is over (see notify.ts); for a
//   deal from a request only the client's row waits until the review reminder
// is sent, the review is written or the 3-day window ends.

import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export type Party = 'creator' | 'client';

/** What the watcher last saw of a deal, per subscription (to send each event once). */
export interface Seen {
  /** Deal state, or "None" before the client joined. */
  s: string;
  /** Outcome kind once the deal ended ("Accepted", "ArbiterSplit", …). */
  o: string | null;
  /** "1 day left to review" was sent. */
  rw?: boolean;
  /** "Leave a review, less than 2 days left" was sent (deals from a request). */
  rv?: boolean;
  /** "1 day left to deliver" was sent. */
  dw?: boolean;
  /** "Delivery time is over" was sent. */
  late?: boolean;
  /** Paid / delivered / disputed were seen (or sent). */
  p?: boolean;
  d?: boolean;
  x?: boolean;
}

export interface NotifyCode {
  handle: string;
  party: Party;
  pending_pk: string | null;
  lang: string;
  seen: Seen;
  expires_ms: number;
}

export interface NotifySub {
  chat_id: string;
  handle: string;
  party: Party;
  pending_pk: string | null;
  lang: string;
  seen: Seen;
}

const hashCode = (code: string) => createHash('sha256').update(code, 'utf8').digest('hex');

type Row = Record<string, unknown>;

function subRow(r: Row): NotifySub {
  return {
    chat_id: String(r.chat_id),
    handle: String(r.handle),
    party: r.party as Party,
    pending_pk: (r.pending_pk as string | null) ?? null,
    lang: String(r.lang),
    seen: JSON.parse(String(r.seen)) as Seen,
  };
}

export class NotifyStore {
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(db: DatabaseSync, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS notify_codes (
        code_hash TEXT PRIMARY KEY,
        handle TEXT NOT NULL,
        party TEXT NOT NULL,
        pending_pk TEXT,
        lang TEXT NOT NULL,
        seen TEXT NOT NULL,
        expires_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS notify_subs (
        chat_id TEXT NOT NULL,
        handle TEXT NOT NULL,
        party TEXT NOT NULL,
        pending_pk TEXT,
        lang TEXT NOT NULL,
        seen TEXT NOT NULL,
        PRIMARY KEY (chat_id, handle, party)
      );
      CREATE INDEX IF NOT EXISTS notify_subs_handle ON notify_subs (handle);
    `);
  }

  addCode(code: string, c: NotifyCode): void {
    this.db.prepare('DELETE FROM notify_codes WHERE expires_ms < ?').run(this.now());
    this.db
      .prepare('INSERT INTO notify_codes (code_hash, handle, party, pending_pk, lang, seen, expires_ms) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(hashCode(code), c.handle, c.party, c.pending_pk, c.lang, JSON.stringify(c.seen), c.expires_ms);
  }

  /** Takes a code once: returns it and deletes it (null if unknown or expired). */
  takeCode(code: string): NotifyCode | null {
    const h = hashCode(code);
    const r = this.db.prepare('SELECT * FROM notify_codes WHERE code_hash = ?').get(h) as Row | undefined;
    if (!r) return null;
    this.db.prepare('DELETE FROM notify_codes WHERE code_hash = ?').run(h);
    if (Number(r.expires_ms) < this.now()) return null;
    return {
      handle: String(r.handle),
      party: r.party as Party,
      pending_pk: (r.pending_pk as string | null) ?? null,
      lang: String(r.lang),
      seen: JSON.parse(String(r.seen)) as Seen,
      expires_ms: Number(r.expires_ms),
    };
  }

  /** Subscribes a chat (a repeated subscribe of the same chat and party replaces the old row). */
  subscribe(s: NotifySub): void {
    this.db
      .prepare(
        `INSERT INTO notify_subs (chat_id, handle, party, pending_pk, lang, seen) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (chat_id, handle, party) DO UPDATE SET pending_pk = excluded.pending_pk, lang = excluded.lang, seen = excluded.seen`,
      )
      .run(s.chat_id, s.handle, s.party, s.pending_pk, s.lang, JSON.stringify(s.seen));
  }

  countForChat(chatId: string): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM notify_subs WHERE chat_id = ?').get(chatId) as Row).n);
  }

  countFor(handle: string, party: Party): number {
    return Number(
      (this.db.prepare('SELECT COUNT(*) AS n FROM notify_subs WHERE handle = ? AND party = ?').get(handle, party) as Row).n,
    );
  }

  handles(): string[] {
    return (this.db.prepare('SELECT DISTINCT handle FROM notify_subs').all() as Row[]).map((r) => String(r.handle));
  }

  subsOf(handle: string): NotifySub[] {
    return (this.db.prepare('SELECT * FROM notify_subs WHERE handle = ?').all(handle) as Row[]).map(subRow);
  }

  setSeen(s: Pick<NotifySub, 'chat_id' | 'handle' | 'party'>, seen: Seen): void {
    this.db
      .prepare('UPDATE notify_subs SET seen = ? WHERE chat_id = ? AND handle = ? AND party = ?')
      .run(JSON.stringify(seen), s.chat_id, s.handle, s.party);
  }

  clearPendingPk(s: Pick<NotifySub, 'chat_id' | 'handle' | 'party'>): void {
    this.db.prepare('UPDATE notify_subs SET pending_pk = NULL WHERE chat_id = ? AND handle = ? AND party = ?').run(s.chat_id, s.handle, s.party);
  }

  removeSub(s: Pick<NotifySub, 'chat_id' | 'handle' | 'party'>): void {
    this.db.prepare('DELETE FROM notify_subs WHERE chat_id = ? AND handle = ? AND party = ?').run(s.chat_id, s.handle, s.party);
  }

  /** Unsubscribe with the deal key: every chat of this party, and its unused codes. */
  removeParty(handle: string, party: Party): number {
    this.db.prepare('DELETE FROM notify_codes WHERE handle = ? AND party = ?').run(handle, party);
    return Number(this.db.prepare('DELETE FROM notify_subs WHERE handle = ? AND party = ?').run(handle, party).changes);
  }

  /** Unsubscribe from the chat (/stop): every deal of this chat. */
  removeChat(chatId: string): number {
    return Number(this.db.prepare('DELETE FROM notify_subs WHERE chat_id = ?').run(chatId).changes);
  }

  /** The deal is over: nothing about it stays. */
  removeHandle(handle: string): void {
    this.db.prepare('DELETE FROM notify_codes WHERE handle = ?').run(handle);
    this.db.prepare('DELETE FROM notify_subs WHERE handle = ?').run(handle);
  }
}

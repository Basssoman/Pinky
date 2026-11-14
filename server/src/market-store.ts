// Marketplace tables: creator profiles, their services, client
// requests, request -> deal links and reviews. Same SQLite file as the deals
// (node:sqlite); every table is created on start, so an existing database
// gets them on the first start of this version (no separate migration).
//
// Privacy:
// - Request links work like deal links: only sha256(token) is stored.
// - The client contact is stored plain next to the brief (the operator can
//   read it; see the README privacy notes). It leaves the server only in the creator's
//   signed inbox.
// - The deal link in a request is stored as a box encrypted in the browser to
//   the client's request key: the server cannot open it.
// - Request -> deal links stay here; they are never part of public output.

import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export interface ContactV {
  kind: string;
  value: string;
}

export interface ServiceV {
  id: string;
  title: string;
  description: string;
  price_from_usdc: number;
  delivery_days: number;
}

/** A service as it comes from the editor: `id` only for an existing one. */
export type ServiceIn = Omit<ServiceV, 'id'> & { id?: string };

export interface ProfileIn {
  nickname: string;
  bio: string;
  categories: string[];
  portfolio: string[];
  contacts: ContactV[];
  services: ServiceIn[];
}

export interface ProfileRow {
  profile_id: string;
  profile_pk: string;
  nickname: string;
  bio: string;
  categories: string[];
  portfolio: string[];
  contacts: ContactV[];
  min_price: number | null;
  finished_deals: number;
  rating_avg: number | null;
  reviews_count: number;
  self_hidden: boolean;
  hidden: boolean;
  /** Version of the uploaded picture (part of its URL), null = none. */
  avatar: string | null;
  /**
   * The last signed profile write, exactly as sent: the client's
   * browser checks the nickname against the profile key it pinned. null for
   * profiles saved before this version (until their next save).
   */
  signed: SignedProfile | null;
  /** When the public contacts last changed; null = not since this version. */
  contacts_changed_at: string | null;
  /** When support last replaced the profile key; null = never. */
  key_changed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SignedProfile {
  /** JSON of the `profile` object as the editor sent and signed it. */
  profile: string;
  expires_at_ns: string;
  sig: string;
}

/**
 * Request life: open = sent; viewed = the creator opened the inbox
 * with it; discussing = the creator marked it (or the deal from it ended
 * unpaid); closed = no answer for 7 days.
 */
export type RequestStatus = 'open' | 'viewed' | 'discussing' | 'declined' | 'cancelled' | 'deal_ready' | 'closed';
/** Statuses where the creator has not answered yet (auto-close after 7 days). */
export const UNANSWERED: readonly RequestStatus[] = ['open', 'viewed'];

export interface RequestRow {
  handle: string;
  profile_id: string;
  /** Snapshot of the service at request time (it may change later). */
  service: { id: string; title: string; price_from_usdc: number; delivery_days: number } | null;
  brief: string;
  wanted_deadline: string | null;
  contact_kind: string;
  contact_value: string;
  client_box_pk: string;
  status: RequestStatus;
  /** The creator's optional reason with a decline. */
  decline_reason: string | null;
  /**
   * Lines of `brief` (0-based, split on line breaks) that the AI helper wrote and the
   * client kept as they were; the creator’s inbox marks them.
   */
  ai_lines: number[];
  created_at: string;
  updated_at: string;
}

export interface LinkBox {
  epk: string;
  iv: string;
  ct: string;
}

export interface LinkRow {
  deal_handle: string;
  request_handle: string;
  profile_id: string;
  deal_link_box: LinkBox | null;
  created_at: string;
  /** The deal reached an end state on-chain (facts below are frozen). */
  final: boolean;
  /** Fully paid and finished (Released / Refunded / PaidOut): a review is allowed. */
  reviewable: boolean;
  /** Reviewable AND the creator got money: counts as a finished deal. */
  counted: boolean;
  checked_at: number;
  /** When the deal reached its end state (ms; from the chain's `ended_at_ns`). The review window starts here. */
  ended_ms: number | null;
  /** The outcome label shown on a review of this deal. */
  outcome: ReviewOutcome | null;
  /**
   * The profile-key signature over (request handle, the deal's creator key)
   * as the creator's browser sent it: served to the client, whose
   * browser checks it against the key it pinned. null for links stored
   * before this version.
   */
  proof: LinkProof | null;
  /**
   * The deal ended by itself (auto-release after the review timer, or
   * refund after a missed delivery deadline): the review window starts when
   * the client first opens the deal after the end (at most 30 days after it).
   */
  idle_end: boolean;
  /** When the client first opened the deal after it ended (a signed read), ms; null = not yet. */
  opened_ms: number | null;
}

export interface LinkProof {
  /** The deal's creator (deal) key the signature covers. */
  creator_pk: string;
  /** The profile key that signed. */
  profile_pk: string;
  expires_at_ns: string;
  sig: string;
}

/** "paid" = the creator got money; "refunded" = the money went back to the client; "dispute" = a dispute was opened. */
export type ReviewOutcome = 'paid' | 'refunded' | 'dispute';

export interface LinkFacts {
  final: boolean;
  reviewable: boolean;
  counted: boolean;
  ended_ms?: number | null;
  outcome?: ReviewOutcome | null;
  /** Nobody acted (AutoReleased / RefundedAfterDeadline). */
  idle?: boolean;
}

export interface ReviewRow {
  /** Random public id (the deal handle is never public). */
  review_id: string;
  deal_handle: string;
  profile_id: string;
  rating: number;
  text: string;
  /** The creator got nothing (money went back to the client): label + can only lower the rating. */
  refunded: boolean;
  hidden: boolean;
  signed_expires_ns: string;
  /** Outcome label; old rows: derived from `refunded`. */
  outcome: ReviewOutcome;
  /** The creator's one public answer, signed by the profile key. */
  reply_text: string | null;
  reply_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Profile key reset by support: issued (code given to the
 * owner) -> pending (the operator saw the code in the account bio; the new key
 * takes effect at `effective_at`, the current key can still cancel) ->
 * applied | cancelled. Every row is the public reset log.
 */
export type ResetStatus = 'issued' | 'pending' | 'applied' | 'cancelled';

export interface KeyResetRow {
  reset_id: string;
  profile_id: string;
  old_pk: string;
  new_pk: string;
  /** The account whose bio the operator checked (by hand: automatic checks are not built). */
  account_url: string;
  code: string;
  status: ResetStatus;
  issued_at: string;
  confirmed_at: string | null;
  effective_at: string | null;
  done_at: string | null;
  /** Who cancelled: "operator" or "owner_key" (the current key, one signature). */
  cancelled_by: string | null;
  /**
   * "verified" = the reset code was put in the bio of an account that
   * was confirmed on this profile long before the reset (then the current key
   * cannot cancel it; only the operator can). null = plain reset.
   */
  proof: 'verified' | null;
}

/**
 * A creator account on the profile: waiting (code given,
 * not seen yet) -> review (the site could not read the page: a person of the
 * team checks by hand) -> confirmed -> lost (the code is gone); removed by the
 * owner = the row is deleted.
 */
export type AccountStatus = 'waiting' | 'review' | 'confirmed' | 'lost';

export interface AccountRow {
  account_id: string;
  profile_id: string;
  platform: string;
  url: string;
  handle: string;
  code: string;
  status: AccountStatus;
  /** How the mark was made: "auto" (the site read the bio) or "operator" (checked by hand). Kept in the log only. */
  method: 'auto' | 'operator' | null;
  created_at: string;
  confirmed_at: string | null;
  /** Last read of the page (ms), and what it said. */
  checked_ms: number;
  last_result: string | null;
  /** Reads in a row where the page was read but the code was not there (the mark goes at 2). */
  misses: number;
  lost_at: string | null;
}

export interface CatalogQuery {
  category?: string;
  q?: string;
  offset: number;
  limit: number;
}

type Row = Record<string, unknown>;

const json = <T>(s: unknown, dflt: T): T => {
  try {
    return typeof s === 'string' ? (JSON.parse(s) as T) : dflt;
  } catch {
    return dflt;
  }
};

/** LIKE pattern with %, _ and \ escaped (used with ESCAPE '\'). */
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export class MarketStore {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private sigInserts = 0;

  constructor(db: DatabaseSync, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS market_profiles (
        profile_id TEXT PRIMARY KEY,
        profile_pk TEXT NOT NULL UNIQUE,
        nickname TEXT NOT NULL,
        bio TEXT NOT NULL,
        categories TEXT NOT NULL,
        portfolio TEXT NOT NULL,
        contacts TEXT NOT NULL,
        -- lowercased nickname + bio + service titles, for the catalog search
        search TEXT NOT NULL,
        min_price INTEGER,
        finished_deals INTEGER NOT NULL DEFAULT 0,
        rating_avg REAL,
        reviews_count INTEGER NOT NULL DEFAULT 0,
        self_hidden INTEGER NOT NULL DEFAULT 0,
        hidden INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS market_services (
        profile_id TEXT NOT NULL,
        id TEXT NOT NULL,
        position INTEGER NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        price_from_usdc INTEGER NOT NULL,
        delivery_days INTEGER NOT NULL,
        PRIMARY KEY (profile_id, id)
      );
      CREATE TABLE IF NOT EXISTS market_requests (
        handle TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        service TEXT,
        brief TEXT NOT NULL,
        wanted_deadline TEXT,
        contact_kind TEXT NOT NULL,
        contact_value TEXT NOT NULL,
        client_box_pk TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS market_requests_profile ON market_requests (profile_id, created_at);
      CREATE TABLE IF NOT EXISTS market_request_deals (
        deal_handle TEXT PRIMARY KEY,
        request_handle TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        deal_link_box TEXT,
        created_at TEXT NOT NULL,
        final INTEGER NOT NULL DEFAULT 0,
        reviewable INTEGER NOT NULL DEFAULT 0,
        counted INTEGER NOT NULL DEFAULT 0,
        checked_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS market_links_request ON market_request_deals (request_handle, created_at);
      CREATE INDEX IF NOT EXISTS market_links_profile ON market_request_deals (profile_id);
      CREATE INDEX IF NOT EXISTS market_links_open ON market_request_deals (final, checked_at);
      CREATE TABLE IF NOT EXISTS market_reviews (
        deal_handle TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        rating INTEGER NOT NULL,
        text TEXT NOT NULL,
        refunded INTEGER NOT NULL,
        hidden INTEGER NOT NULL DEFAULT 0,
        signed_expires_ns TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS market_reviews_profile ON market_reviews (profile_id, created_at);
      -- Re-encoded profile pictures: 256 x 256 WebP, no metadata, one per profile.
      CREATE TABLE IF NOT EXISTS market_avatars (
        profile_id TEXT PRIMARY KEY,
        version TEXT NOT NULL,
        image BLOB NOT NULL,
        updated_at TEXT NOT NULL
      );
      -- Profile key resets by support: also the public reset log.
      CREATE TABLE IF NOT EXISTS market_key_resets (
        reset_id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        old_pk TEXT NOT NULL,
        new_pk TEXT NOT NULL,
        account_url TEXT NOT NULL,
        code TEXT NOT NULL,
        status TEXT NOT NULL,
        issued_at TEXT NOT NULL,
        confirmed_at TEXT,
        effective_at TEXT,
        done_at TEXT,
        cancelled_by TEXT
      );
      CREATE INDEX IF NOT EXISTS market_key_resets_profile ON market_key_resets (profile_id, issued_at);
      CREATE INDEX IF NOT EXISTS market_key_resets_status ON market_key_resets (status, effective_at);
      -- Creator accounts with a verification code in the bio: also the log of how each mark was made.
      CREATE TABLE IF NOT EXISTS market_accounts (
        account_id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        platform TEXT NOT NULL,
        url TEXT NOT NULL,
        handle TEXT NOT NULL,
        code TEXT NOT NULL,
        status TEXT NOT NULL,
        method TEXT,
        created_at TEXT NOT NULL,
        confirmed_at TEXT,
        checked_ms INTEGER NOT NULL DEFAULT 0,
        last_result TEXT,
        misses INTEGER NOT NULL DEFAULT 0,
        lost_at TEXT,
        UNIQUE (profile_id, url)
      );
      CREATE INDEX IF NOT EXISTS market_accounts_status ON market_accounts (status, checked_ms);
      -- Replay cache of marketplace signatures (kept until they expire, survives a restart).
      CREATE TABLE IF NOT EXISTS market_used_sigs (
        sig TEXT PRIMARY KEY,
        expires_ms INTEGER NOT NULL
      );
    `);
    // Columns added after the first marketplace release (2026-11-12): review window, outcome label, creator answer.
    this.addColumn('market_request_deals', 'ended_ms', 'INTEGER');
    this.addColumn('market_request_deals', 'outcome', 'TEXT');
    this.addColumn('market_reviews', 'review_id', 'TEXT');
    this.addColumn('market_reviews', 'outcome', 'TEXT');
    this.addColumn('market_reviews', 'reply_text', 'TEXT');
    this.addColumn('market_reviews', 'reply_at', 'TEXT');
    // 2026-11-12: uploaded profile pictures.
    this.addColumn('market_profiles', 'avatar', 'TEXT');
    // 2026-11-13: signed profile for the client's check, change dates, request life, link proof.
    this.addColumn('market_profiles', 'signed_profile', 'TEXT');
    this.addColumn('market_profiles', 'contacts_changed_at', 'TEXT');
    this.addColumn('market_profiles', 'key_changed_at', 'TEXT');
    this.addColumn('market_requests', 'decline_reason', 'TEXT');
    this.addColumn('market_requests', 'ai_lines', 'TEXT');
    this.addColumn('market_request_deals', 'proof', 'TEXT');
    // 2026-11-13: review window of "nobody acted" deals starts on the client's first open.
    this.addColumn('market_request_deals', 'idle_end', 'INTEGER');
    this.addColumn('market_request_deals', 'opened_ms', 'INTEGER');
    // 2026-11-13: the bot told the owner about a confirmed key reset; verified-account proof.
    this.addColumn('market_key_resets', 'owner_told_at', 'TEXT');
    this.addColumn('market_key_resets', 'proof', 'TEXT');
    this.db.exec('CREATE INDEX IF NOT EXISTS market_requests_status ON market_requests (status, created_at)');
    for (const r of this.db.prepare('SELECT deal_handle FROM market_reviews WHERE review_id IS NULL').all() as Row[]) {
      this.db.prepare('UPDATE market_reviews SET review_id = ? WHERE deal_handle = ?').run(randomBytes(8).toString('hex'), r.deal_handle as string);
    }
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS market_reviews_id ON market_reviews (review_id)');
  }

  private addColumn(table: string, column: string, type: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[];
    if (!cols.some((c) => c.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  /** The store's clock (ms): the operator tools use it, so tests can move time. */
  nowMs(): number {
    return this.now();
  }

  // ------------------------------------------------------------ replay cache

  /** true if the signature was not used before (and marks it used until `expiresMs`). */
  useSignature(sig: string, expiresMs: number): boolean {
    const t = this.now();
    if (++this.sigInserts >= 200) {
      this.sigInserts = 0;
      this.db.prepare('DELETE FROM market_used_sigs WHERE expires_ms < ?').run(t);
    }
    const prev = this.db.prepare('SELECT expires_ms FROM market_used_sigs WHERE sig = ?').get(sig) as { expires_ms: number } | undefined;
    if (prev && prev.expires_ms >= t) return false;
    this.db
      .prepare('INSERT INTO market_used_sigs (sig, expires_ms) VALUES (?, ?) ON CONFLICT (sig) DO UPDATE SET expires_ms = excluded.expires_ms')
      .run(sig, expiresMs);
    return true;
  }

  // ------------------------------------------------------------ profiles

  private profileRow(r: Row | undefined): ProfileRow | null {
    if (!r) return null;
    return {
      profile_id: r.profile_id as string,
      profile_pk: r.profile_pk as string,
      nickname: r.nickname as string,
      bio: r.bio as string,
      categories: json<string[]>(r.categories, []),
      portfolio: json<string[]>(r.portfolio, []),
      contacts: json<ContactV[]>(r.contacts, []),
      min_price: r.min_price === null ? null : Number(r.min_price),
      finished_deals: Number(r.finished_deals),
      rating_avg: r.rating_avg === null ? null : Number(r.rating_avg),
      reviews_count: Number(r.reviews_count),
      self_hidden: Number(r.self_hidden) === 1,
      hidden: Number(r.hidden) === 1,
      avatar: typeof r.avatar === 'string' && r.avatar ? r.avatar : null,
      signed: json<SignedProfile | null>(r.signed_profile, null),
      contacts_changed_at: (r.contacts_changed_at as string | null) ?? null,
      key_changed_at: (r.key_changed_at as string | null) ?? null,
      created_at: r.created_at as string,
      updated_at: r.updated_at as string,
    };
  }

  getProfile(profileId: string): ProfileRow | null {
    return this.profileRow(this.db.prepare('SELECT * FROM market_profiles WHERE profile_id = ?').get(profileId) as Row | undefined);
  }

  getServices(profileId: string): ServiceV[] {
    return (
      this.db
        .prepare('SELECT id, title, description, price_from_usdc, delivery_days FROM market_services WHERE profile_id = ? ORDER BY position')
        .all(profileId) as Row[]
    ).map((s) => ({
      id: s.id as string,
      title: s.title as string,
      description: s.description as string,
      price_from_usdc: Number(s.price_from_usdc),
      delivery_days: Number(s.delivery_days),
    }));
  }

  /**
   * Creates or replaces the profile (and its services); un-hides a self-hidden
   * profile. `signed` = the write as sent and signed (kept for the client's check).
   */
  saveProfile(profileId: string, profilePk: string, p: ProfileIn, signed: SignedProfile | null = null): { created: boolean } {
    const at = this.iso();
    const existing = this.getProfile(profileId);
    const contactsChanged = !!existing && JSON.stringify(existing.contacts) !== JSON.stringify(p.contacts);
    const services: ServiceV[] = [];
    // Given ids are existing, unique ones (checked by the caller); new services get fresh ids.
    const taken = new Set(p.services.map((s) => s.id).filter((id): id is string => !!id));
    for (const s of p.services) {
      let id = s.id;
      while (!id) {
        const fresh = randomBytes(4).toString('hex');
        if (!taken.has(fresh)) id = fresh;
      }
      taken.add(id);
      services.push({ ...s, id });
    }
    const search = [p.nickname, p.bio, ...services.map((s) => s.title)].join('\n').toLowerCase();
    const minPrice = services.length ? Math.min(...services.map((s) => s.price_from_usdc)) : null;
    this.db.exec('BEGIN');
    try {
      if (existing) {
        this.db
          .prepare(
            `UPDATE market_profiles SET nickname = ?, bio = ?, categories = ?, portfolio = ?, contacts = ?, search = ?,
               min_price = ?, self_hidden = 0, signed_profile = ?, contacts_changed_at = ?, updated_at = ? WHERE profile_id = ?`,
          )
          .run(
            p.nickname,
            p.bio,
            JSON.stringify(p.categories),
            JSON.stringify(p.portfolio),
            JSON.stringify(p.contacts),
            search,
            minPrice,
            signed ? JSON.stringify(signed) : null,
            contactsChanged ? at : existing.contacts_changed_at,
            at,
            profileId,
          );
      } else {
        this.db
          .prepare(
            `INSERT INTO market_profiles (profile_id, profile_pk, nickname, bio, categories, portfolio, contacts, search,
               min_price, signed_profile, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            profileId,
            profilePk,
            p.nickname,
            p.bio,
            JSON.stringify(p.categories),
            JSON.stringify(p.portfolio),
            JSON.stringify(p.contacts),
            search,
            minPrice,
            signed ? JSON.stringify(signed) : null,
            at,
            at,
          );
      }
      this.db.prepare('DELETE FROM market_services WHERE profile_id = ?').run(profileId);
      const ins = this.db.prepare(
        `INSERT INTO market_services (profile_id, id, position, title, description, price_from_usdc, delivery_days)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      services.forEach((s, i) => ins.run(profileId, s.id, i, s.title, s.description, s.price_from_usdc, s.delivery_days));
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return { created: !existing };
  }

  setSelfHidden(profileId: string, hidden: boolean): void {
    this.db.prepare('UPDATE market_profiles SET self_hidden = ?, updated_at = ? WHERE profile_id = ?').run(hidden ? 1 : 0, this.iso(), profileId);
  }

  // ------------------------------------------------------------ avatars

  /** Stores the (already re-encoded) picture and points the profile at it. */
  setAvatar(profileId: string, version: string, image: Uint8Array): void {
    const at = this.iso();
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          `INSERT INTO market_avatars (profile_id, version, image, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (profile_id) DO UPDATE SET version = excluded.version, image = excluded.image, updated_at = excluded.updated_at`,
        )
        .run(profileId, version, image, at);
      this.db.prepare('UPDATE market_profiles SET avatar = ?, updated_at = ? WHERE profile_id = ?').run(version, at, profileId);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /** Deletes the picture (the profile shows its pixel pattern again). */
  removeAvatar(profileId: string): void {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM market_avatars WHERE profile_id = ?').run(profileId);
      this.db.prepare('UPDATE market_profiles SET avatar = NULL, updated_at = ? WHERE profile_id = ?').run(this.iso(), profileId);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  getAvatar(profileId: string): { version: string; image: Uint8Array } | null {
    const r = this.db.prepare('SELECT version, image FROM market_avatars WHERE profile_id = ?').get(profileId) as Row | undefined;
    return r ? { version: r.version as string, image: r.image as Uint8Array } : null;
  }

  /** Operator hide (`scripts/market-admin.ts hide`). Returns false if there is no such profile. */
  setOperatorHidden(profileId: string, hidden: boolean): boolean {
    return Number(this.db.prepare('UPDATE market_profiles SET hidden = ? WHERE profile_id = ?').run(hidden ? 1 : 0, profileId).changes) > 0;
  }

  /** Visible profiles, best first: most finished deals, most reviews, newest. */
  catalog(q: CatalogQuery): ProfileRow[] {
    const where = ['hidden = 0', 'self_hidden = 0'];
    const args: (string | number)[] = [];
    if (q.category) {
      where.push(`categories LIKE ? ESCAPE '\\'`);
      args.push(`%${likeEscape(JSON.stringify(q.category))}%`);
    }
    if (q.q) {
      where.push(`search LIKE ? ESCAPE '\\'`);
      args.push(`%${likeEscape(q.q.toLowerCase())}%`);
    }
    args.push(q.limit, q.offset);
    const rows = this.db
      .prepare(
        `SELECT * FROM market_profiles WHERE ${where.join(' AND ')}
         ORDER BY finished_deals DESC, reviews_count DESC, created_at DESC, profile_id LIMIT ? OFFSET ?`,
      )
      .all(...args) as Row[];
    return rows.map((r) => this.profileRow(r)!);
  }

  /**
   * Recounts the public counters of a profile:
   * - finished_deals: linked deals, fully paid, finished, creator got money;
   * - rating_avg: average of the reviews where the creator got money, plus
   *   "money went back" reviews only when they are LOWER than that average
   *   (they can only lower it); no paid reviews -> no average;
   * - reviews_count: all shown reviews;
   * - min_price: the lowest "from" price of the services.
   */
  recomputeStats(profileId: string): void {
    const finished = Number(
      (this.db.prepare('SELECT COUNT(*) AS n FROM market_request_deals WHERE profile_id = ? AND counted = 1').get(profileId) as { n: number }).n,
    );
    const reviews = this.db.prepare('SELECT rating, refunded FROM market_reviews WHERE profile_id = ? AND hidden = 0').all(profileId) as {
      rating: number;
      refunded: number;
    }[];
    const paid = reviews.filter((r) => Number(r.refunded) === 0).map((r) => Number(r.rating));
    let avg: number | null = null;
    if (paid.length) {
      const base = paid.reduce((a, b) => a + b, 0) / paid.length;
      const lower = reviews.filter((r) => Number(r.refunded) === 1 && Number(r.rating) < base).map((r) => Number(r.rating));
      const all = [...paid, ...lower];
      avg = Math.round((all.reduce((a, b) => a + b, 0) / all.length) * 10) / 10;
    }
    const minRow = this.db.prepare('SELECT MIN(price_from_usdc) AS m FROM market_services WHERE profile_id = ?').get(profileId) as {
      m: number | null;
    };
    this.db
      .prepare('UPDATE market_profiles SET finished_deals = ?, rating_avg = ?, reviews_count = ?, min_price = ? WHERE profile_id = ?')
      .run(finished, avg, reviews.length, minRow.m === null ? null : Number(minRow.m), profileId);
  }

  // ------------------------------------------------------------ requests

  private requestRow(r: Row | undefined): RequestRow | null {
    if (!r) return null;
    return {
      handle: r.handle as string,
      profile_id: r.profile_id as string,
      service: json<RequestRow['service']>(r.service, null),
      brief: r.brief as string,
      wanted_deadline: (r.wanted_deadline as string | null) ?? null,
      contact_kind: r.contact_kind as string,
      contact_value: r.contact_value as string,
      client_box_pk: r.client_box_pk as string,
      status: r.status as RequestStatus,
      decline_reason: (r.decline_reason as string | null) ?? null,
      ai_lines: json<number[]>(r.ai_lines, []),
      created_at: r.created_at as string,
      updated_at: r.updated_at as string,
    };
  }

  insertRequest(r: Omit<RequestRow, 'status' | 'decline_reason' | 'ai_lines' | 'created_at' | 'updated_at'> & { ai_lines?: number[] }): void {
    const at = this.iso();
    this.db
      .prepare(
        `INSERT INTO market_requests (handle, profile_id, service, brief, wanted_deadline, contact_kind, contact_value,
           client_box_pk, ai_lines, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
      )
      .run(
        r.handle,
        r.profile_id,
        r.service ? JSON.stringify(r.service) : null,
        r.brief,
        r.wanted_deadline,
        r.contact_kind,
        r.contact_value,
        r.client_box_pk,
        r.ai_lines?.length ? JSON.stringify(r.ai_lines) : null,
        at,
        at,
      );
  }

  getRequest(handle: string): RequestRow | null {
    return this.requestRow(this.db.prepare('SELECT * FROM market_requests WHERE handle = ?').get(handle) as Row | undefined);
  }

  setRequestStatus(handle: string, status: RequestStatus, declineReason: string | null = null): void {
    this.db
      .prepare('UPDATE market_requests SET status = ?, decline_reason = ?, updated_at = ? WHERE handle = ?')
      .run(status, status === 'declined' ? declineReason : null, this.iso(), handle);
  }

  /** Requests without an answer (open / viewed) sent before `beforeIso` are closed. Returns how many. */
  closeStale(beforeIso: string): number {
    const res = this.db
      .prepare(`UPDATE market_requests SET status = 'closed', updated_at = ? WHERE status IN ('open', 'viewed') AND created_at < ?`)
      .run(this.iso(), beforeIso);
    return Number(res.changes);
  }

  /** The creator read the inbox: new requests become "viewed". */
  markViewed(profileId: string): void {
    this.db.prepare(`UPDATE market_requests SET status = 'viewed', updated_at = ? WHERE profile_id = ? AND status = 'open'`).run(this.iso(), profileId);
  }

  /**
   * The deal shown on the request ended unpaid (expired, cancelled,
   * never joined): the request goes back to "discussing", so the creator can
   * make a new deal. Only for the newest deal of the request. true if changed.
   */
  reopenAfterDeadDeal(dealHandle: string): boolean {
    const link = this.getLink(dealHandle);
    if (!link) return false;
    if (this.latestLink(link.request_handle)?.deal_handle !== dealHandle) return false;
    const res = this.db
      .prepare(`UPDATE market_requests SET status = 'discussing', updated_at = ? WHERE handle = ? AND status = 'deal_ready'`)
      .run(this.iso(), link.request_handle);
    return Number(res.changes) > 0;
  }

  inbox(profileId: string, limit: number): RequestRow[] {
    return (
      this.db.prepare('SELECT * FROM market_requests WHERE profile_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(profileId, limit) as Row[]
    ).map((r) => this.requestRow(r)!);
  }

  // ------------------------------------------------------------ request -> deal links

  private linkRow(r: Row | undefined): LinkRow | null {
    if (!r) return null;
    return {
      deal_handle: r.deal_handle as string,
      request_handle: r.request_handle as string,
      profile_id: r.profile_id as string,
      deal_link_box: json<LinkBox | null>(r.deal_link_box, null),
      created_at: r.created_at as string,
      final: Number(r.final) === 1,
      reviewable: Number(r.reviewable) === 1,
      counted: Number(r.counted) === 1,
      checked_at: Number(r.checked_at),
      ended_ms: r.ended_ms === null || r.ended_ms === undefined ? null : Number(r.ended_ms),
      outcome: (r.outcome as ReviewOutcome | null) ?? null,
      proof: json<LinkProof | null>(r.proof, null),
      idle_end: Number(r.idle_end) === 1,
      opened_ms: r.opened_ms === null || r.opened_ms === undefined ? null : Number(r.opened_ms),
    };
  }

  /** Links a new deal to its request; the request becomes `deal_ready`. */
  linkDeal(dealHandle: string, requestHandle: string, profileId: string, box: LinkBox | null, proof: LinkProof | null = null): void {
    const at = this.iso();
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare('INSERT INTO market_request_deals (deal_handle, request_handle, profile_id, deal_link_box, proof, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(dealHandle, requestHandle, profileId, box ? JSON.stringify(box) : null, proof ? JSON.stringify(proof) : null, at);
      this.db.prepare(`UPDATE market_requests SET status = 'deal_ready', updated_at = ? WHERE handle = ?`).run(at, requestHandle);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  getLink(dealHandle: string): LinkRow | null {
    return this.linkRow(this.db.prepare('SELECT * FROM market_request_deals WHERE deal_handle = ?').get(dealHandle) as Row | undefined);
  }

  countLinks(requestHandle: string): number {
    return Number(
      (this.db.prepare('SELECT COUNT(*) AS n FROM market_request_deals WHERE request_handle = ?').get(requestHandle) as { n: number }).n,
    );
  }

  /** The newest deal made from this request (its box is what the request page shows). */
  latestLink(requestHandle: string): LinkRow | null {
    return this.linkRow(
      this.db
        .prepare('SELECT * FROM market_request_deals WHERE request_handle = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
        .get(requestHandle) as Row | undefined,
    );
  }

  /** Every deal made from this request, newest first. */
  linksOf(requestHandle: string): LinkRow[] {
    return (
      this.db
        .prepare('SELECT * FROM market_request_deals WHERE request_handle = ? ORDER BY created_at DESC, rowid DESC')
        .all(requestHandle) as Row[]
    ).map((r) => this.linkRow(r)!);
  }

  /** Not yet final links, least recently checked first. */
  openLinks(checkedBeforeMs: number, limit: number): LinkRow[] {
    return (
      this.db
        .prepare('SELECT * FROM market_request_deals WHERE final = 0 AND checked_at < ? ORDER BY checked_at LIMIT ?')
        .all(checkedBeforeMs, limit) as Row[]
    ).map((r) => this.linkRow(r)!);
  }

  /** Stores what the chain says about a linked deal; frozen once final. Returns true if anything changed. */
  setLinkFacts(dealHandle: string, f: LinkFacts | null): boolean {
    const t = this.now();
    if (!f) {
      this.db.prepare('UPDATE market_request_deals SET checked_at = ? WHERE deal_handle = ?').run(t, dealHandle);
      return false;
    }
    // End time and outcome label are filled once (also for links that were final before these columns existed).
    if (f.final) {
      this.db.prepare('UPDATE market_request_deals SET ended_ms = ? WHERE deal_handle = ? AND ended_ms IS NULL').run(f.ended_ms ?? t, dealHandle);
      if (f.outcome) this.db.prepare('UPDATE market_request_deals SET outcome = ? WHERE deal_handle = ? AND outcome IS NULL').run(f.outcome, dealHandle);
      if (f.idle !== undefined) {
        this.db.prepare('UPDATE market_request_deals SET idle_end = ? WHERE deal_handle = ? AND idle_end IS NULL').run(f.idle ? 1 : 0, dealHandle);
      }
    }
    const res = this.db
      .prepare(
        `UPDATE market_request_deals SET final = ?, reviewable = ?, counted = ?, checked_at = ?
         WHERE deal_handle = ? AND final = 0`,
      )
      .run(f.final ? 1 : 0, f.reviewable ? 1 : 0, f.counted ? 1 : 0, t, dealHandle);
    return Number(res.changes) > 0 && (f.final || f.reviewable || f.counted);
  }

  /** The client opened the deal after it ended (first time only). true if this was the first open. */
  markOpened(dealHandle: string, atMs: number): boolean {
    const res = this.db.prepare('UPDATE market_request_deals SET opened_ms = ? WHERE deal_handle = ? AND opened_ms IS NULL').run(atMs, dealHandle);
    return Number(res.changes) > 0;
  }

  // ------------------------------------------------------------ profile key reset by support

  private resetRow(r: Row | undefined): KeyResetRow | null {
    if (!r) return null;
    return {
      reset_id: r.reset_id as string,
      profile_id: r.profile_id as string,
      old_pk: r.old_pk as string,
      new_pk: r.new_pk as string,
      account_url: r.account_url as string,
      code: r.code as string,
      status: r.status as ResetStatus,
      issued_at: r.issued_at as string,
      confirmed_at: (r.confirmed_at as string | null) ?? null,
      effective_at: (r.effective_at as string | null) ?? null,
      done_at: (r.done_at as string | null) ?? null,
      cancelled_by: (r.cancelled_by as string | null) ?? null,
      proof: r.proof === 'verified' ? 'verified' : null,
    };
  }

  /** The profile that has this key now (any profile, hidden too). */
  profileByKey(pk: string): ProfileRow | null {
    return this.profileRow(this.db.prepare('SELECT * FROM market_profiles WHERE profile_pk = ?').get(pk) as Row | undefined);
  }

  getReset(resetId: string): KeyResetRow | null {
    return this.resetRow(this.db.prepare('SELECT * FROM market_key_resets WHERE reset_id = ?').get(resetId) as Row | undefined);
  }

  /** The reset in progress for a profile (issued or pending), if any. */
  openReset(profileId: string): KeyResetRow | null {
    return this.resetRow(
      this.db
        .prepare(`SELECT * FROM market_key_resets WHERE profile_id = ? AND status IN ('issued', 'pending') ORDER BY issued_at DESC LIMIT 1`)
        .get(profileId) as Row | undefined,
    );
  }

  /** A key that is the new key of a reset in progress (it must not start another profile meanwhile). */
  resetForNewKey(pk: string): KeyResetRow | null {
    return this.resetRow(
      this.db.prepare(`SELECT * FROM market_key_resets WHERE new_pk = ? AND status IN ('issued', 'pending') LIMIT 1`).get(pk) as Row | undefined,
    );
  }

  /** All resets (the public log shows a part of each), newest first. */
  resets(limit: number, profileId?: string): KeyResetRow[] {
    const rows = profileId
      ? this.db.prepare('SELECT * FROM market_key_resets WHERE profile_id = ? ORDER BY issued_at DESC, rowid DESC LIMIT ?').all(profileId, limit)
      : this.db.prepare('SELECT * FROM market_key_resets ORDER BY issued_at DESC, rowid DESC LIMIT ?').all(limit);
    return (rows as Row[]).map((r) => this.resetRow(r)!);
  }

  insertReset(r: Pick<KeyResetRow, 'reset_id' | 'profile_id' | 'old_pk' | 'new_pk' | 'account_url' | 'code'> & { proof?: 'verified' | null }): KeyResetRow {
    this.db
      .prepare(
        `INSERT INTO market_key_resets (reset_id, profile_id, old_pk, new_pk, account_url, code, status, issued_at, proof)
         VALUES (?, ?, ?, ?, ?, ?, 'issued', ?, ?)`,
      )
      .run(r.reset_id, r.profile_id, r.old_pk, r.new_pk, r.account_url, r.code, this.iso(), r.proof ?? null);
    return this.getReset(r.reset_id)!;
  }

  /** The operator saw the code in the bio: the new key takes effect after `delayMs`. false if not "issued". */
  confirmReset(resetId: string, delayMs: number): boolean {
    const t = this.now();
    const res = this.db
      .prepare(`UPDATE market_key_resets SET status = 'pending', confirmed_at = ?, effective_at = ? WHERE reset_id = ? AND status = 'issued'`)
      .run(new Date(t).toISOString(), new Date(t + delayMs).toISOString(), resetId);
    return Number(res.changes) > 0;
  }

  /** The proof no longer holds (the account lost its mark): the current key can cancel again. */
  dropResetProof(resetId: string): void {
    this.db.prepare('UPDATE market_key_resets SET proof = NULL WHERE reset_id = ?').run(resetId);
  }

  /** false if it is not in progress any more. */
  cancelReset(resetId: string, by: 'operator' | 'owner_key'): boolean {
    const res = this.db
      .prepare(`UPDATE market_key_resets SET status = 'cancelled', done_at = ?, cancelled_by = ? WHERE reset_id = ? AND status IN ('issued', 'pending')`)
      .run(this.iso(), by, resetId);
    return Number(res.changes) > 0;
  }

  /** Confirmed resets (pending) the bot has not told the owner about yet. */
  resetsToTell(): KeyResetRow[] {
    return (this.db.prepare(`SELECT * FROM market_key_resets WHERE status = 'pending' AND owner_told_at IS NULL`).all() as Row[]).map(
      (r) => this.resetRow(r)!,
    );
  }

  markResetTold(resetId: string): void {
    this.db.prepare('UPDATE market_key_resets SET owner_told_at = ? WHERE reset_id = ?').run(this.iso(), resetId);
  }

  /** Every deal made from a request to this profile (its handles: the bot finds the creator's chats by them). */
  linkedDeals(profileId: string): string[] {
    return (this.db.prepare('SELECT deal_handle FROM market_request_deals WHERE profile_id = ?').all(profileId) as Row[]).map((r) => r.deal_handle as string);
  }

  /**
   * Replaces the profile key for every pending reset whose time has come.
   * The old signed profile goes (it was signed by the old key); the profile
   * shows "key changed N days ago". Returns the applied resets.
   */
  applyDueResets(): KeyResetRow[] {
    const at = this.iso();
    const due = (
      this.db.prepare(`SELECT * FROM market_key_resets WHERE status = 'pending' AND effective_at <= ?`).all(at) as Row[]
    ).map((r) => this.resetRow(r)!);
    const done: KeyResetRow[] = [];
    for (const r of due) {
      this.db.exec('BEGIN');
      try {
        const taken = this.profileByKey(r.new_pk);
        if (taken && taken.profile_id !== r.profile_id) {
          // The new key started its own profile meanwhile (should not happen: PUT refuses it): stop, the operator decides.
          this.db.prepare(`UPDATE market_key_resets SET status = 'cancelled', done_at = ?, cancelled_by = 'conflict' WHERE reset_id = ?`).run(at, r.reset_id);
        } else {
          this.db
            .prepare('UPDATE market_profiles SET profile_pk = ?, signed_profile = NULL, key_changed_at = ?, updated_at = ? WHERE profile_id = ?')
            .run(r.new_pk, at, at, r.profile_id);
          this.db.prepare(`UPDATE market_key_resets SET status = 'applied', done_at = ? WHERE reset_id = ?`).run(at, r.reset_id);
          done.push({ ...r, status: 'applied', done_at: at });
        }
        this.db.exec('COMMIT');
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
      }
    }
    return done;
  }

  // ------------------------------------------------------------ verified accounts

  private accountRow(r: Row | undefined): AccountRow | null {
    if (!r) return null;
    return {
      account_id: r.account_id as string,
      profile_id: r.profile_id as string,
      platform: r.platform as string,
      url: r.url as string,
      handle: r.handle as string,
      code: r.code as string,
      status: r.status as AccountStatus,
      method: r.method === 'auto' || r.method === 'operator' ? r.method : null,
      created_at: r.created_at as string,
      confirmed_at: (r.confirmed_at as string | null) ?? null,
      checked_ms: Number(r.checked_ms),
      last_result: (r.last_result as string | null) ?? null,
      misses: Number(r.misses),
      lost_at: (r.lost_at as string | null) ?? null,
    };
  }

  accountsOf(profileId: string): AccountRow[] {
    return (this.db.prepare('SELECT * FROM market_accounts WHERE profile_id = ? ORDER BY created_at, rowid').all(profileId) as Row[]).map(
      (r) => this.accountRow(r)!,
    );
  }

  getAccount(accountId: string): AccountRow | null {
    return this.accountRow(this.db.prepare('SELECT * FROM market_accounts WHERE account_id = ?').get(accountId) as Row | undefined);
  }

  accountByUrl(profileId: string, url: string): AccountRow | null {
    return this.accountRow(this.db.prepare('SELECT * FROM market_accounts WHERE profile_id = ? AND url = ?').get(profileId, url) as Row | undefined);
  }

  insertAccount(a: Pick<AccountRow, 'account_id' | 'profile_id' | 'platform' | 'url' | 'handle' | 'code'>): AccountRow {
    this.db
      .prepare(
        `INSERT INTO market_accounts (account_id, profile_id, platform, url, handle, code, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'waiting', ?)`,
      )
      .run(a.account_id, a.profile_id, a.platform, a.url, a.handle, a.code, this.iso());
    return this.getAccount(a.account_id)!;
  }

  deleteAccount(accountId: string): boolean {
    return Number(this.db.prepare('DELETE FROM market_accounts WHERE account_id = ?').run(accountId).changes) > 0;
  }

  /**
   * Stores one read of the page and moves the status:
   * found -> confirmed (method "auto" unless it was confirmed by hand before);
   * absent -> a confirmed mark goes after 2 reads in a row; a waiting one stays waiting;
   * unreadable / manual -> a waiting account goes to "review" (the team); a confirmed one keeps its mark.
   */
  recordCheck(accountId: string, result: string): AccountRow | null {
    const a = this.getAccount(accountId);
    if (!a) return null;
    const t = this.now();
    const at = new Date(t).toISOString();
    let { status, method, misses } = a;
    let confirmedAt = a.confirmed_at;
    let lostAt = a.lost_at;
    if (result === 'found') {
      if (status !== 'confirmed') {
        status = 'confirmed';
        method = 'auto';
        confirmedAt = at;
        lostAt = null;
      }
      misses = 0;
    } else if (result === 'absent') {
      if (status === 'confirmed') {
        misses += 1;
        if (misses >= 2) {
          status = 'lost';
          lostAt = at;
        }
      } else if (status === 'review') status = 'waiting';
    } else if ((result === 'unreadable' || result === 'manual') && (status === 'waiting' || status === 'lost')) {
      status = 'review';
    }
    this.db
      .prepare(
        `UPDATE market_accounts SET status = ?, method = ?, misses = ?, confirmed_at = ?, lost_at = ?, checked_ms = ?, last_result = ? WHERE account_id = ?`,
      )
      .run(status, method, misses, confirmedAt, lostAt, t, result, accountId);
    return this.getAccount(accountId);
  }

  /** The operator opened the account and saw the code (X, or a page the site could not read). */
  confirmByOperator(accountId: string): boolean {
    const at = this.iso();
    const res = this.db
      .prepare(
        `UPDATE market_accounts SET status = 'confirmed', method = 'operator', confirmed_at = ?, lost_at = NULL, misses = 0, checked_ms = ?, last_result = 'operator'
         WHERE account_id = ?`,
      )
      .run(at, this.now(), accountId);
    return Number(res.changes) > 0;
  }

  /** The operator saw the code is gone (or the account changed hands): the mark goes. */
  markLost(accountId: string): boolean {
    const at = this.iso();
    const res = this.db
      .prepare(`UPDATE market_accounts SET status = 'lost', lost_at = ?, checked_ms = ?, last_result = 'operator-lost' WHERE account_id = ?`)
      .run(at, this.now(), accountId);
    return Number(res.changes) > 0;
  }

  /** Confirmed accounts of readable platforms last read before `beforeMs` (oldest first). */
  accountsToRecheck(platforms: readonly string[], beforeMs: number, limit: number): AccountRow[] {
    if (!platforms.length) return [];
    const marks = platforms.map(() => '?').join(', ');
    return (
      this.db
        .prepare(`SELECT * FROM market_accounts WHERE status = 'confirmed' AND platform IN (${marks}) AND checked_ms < ? ORDER BY checked_ms LIMIT ?`)
        .all(...platforms, beforeMs, limit) as Row[]
    ).map((r) => this.accountRow(r)!);
  }

  /** Accounts with this status (the log for ops/accounts.sh), least recently read first. */
  accountsByStatus(status: AccountStatus, limit = 200): AccountRow[] {
    return (this.db.prepare('SELECT * FROM market_accounts WHERE status = ? ORDER BY checked_ms, rowid LIMIT ?').all(status, limit) as Row[]).map(
      (r) => this.accountRow(r)!,
    );
  }

  allAccounts(limit = 500): AccountRow[] {
    return (this.db.prepare('SELECT * FROM market_accounts ORDER BY created_at DESC, rowid DESC LIMIT ?').all(limit) as Row[]).map((r) => this.accountRow(r)!);
  }

  // ------------------------------------------------------------ reviews

  private reviewRow(r: Row | undefined): ReviewRow | null {
    if (!r) return null;
    const refunded = Number(r.refunded) === 1;
    return {
      review_id: r.review_id as string,
      deal_handle: r.deal_handle as string,
      profile_id: r.profile_id as string,
      rating: Number(r.rating),
      text: r.text as string,
      refunded,
      hidden: Number(r.hidden) === 1,
      signed_expires_ns: r.signed_expires_ns as string,
      outcome: (r.outcome as ReviewOutcome | null) ?? (refunded ? 'refunded' : 'paid'),
      reply_text: (r.reply_text as string | null) ?? null,
      reply_at: (r.reply_at as string | null) ?? null,
      created_at: r.created_at as string,
      updated_at: r.updated_at as string,
    };
  }

  getReview(dealHandle: string): ReviewRow | null {
    return this.reviewRow(this.db.prepare('SELECT * FROM market_reviews WHERE deal_handle = ?').get(dealHandle) as Row | undefined);
  }

  /** One review per deal; a new one (same client key) replaces the text and rating, keeps the month. */
  saveReview(
    r: Pick<ReviewRow, 'deal_handle' | 'profile_id' | 'rating' | 'text' | 'refunded' | 'signed_expires_ns' | 'outcome'>,
  ): { created: boolean } {
    const at = this.iso();
    const existing = this.getReview(r.deal_handle);
    this.db
      .prepare(
        `INSERT INTO market_reviews (review_id, deal_handle, profile_id, rating, text, refunded, outcome, signed_expires_ns, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (deal_handle) DO UPDATE SET rating = excluded.rating, text = excluded.text, refunded = excluded.refunded,
           outcome = excluded.outcome, signed_expires_ns = excluded.signed_expires_ns, updated_at = excluded.updated_at`,
      )
      .run(randomBytes(8).toString('hex'), r.deal_handle, r.profile_id, r.rating, r.text, r.refunded ? 1 : 0, r.outcome, r.signed_expires_ns, at, at);
    return { created: !existing };
  }

  getReviewById(reviewId: string): ReviewRow | null {
    return this.reviewRow(this.db.prepare('SELECT * FROM market_reviews WHERE review_id = ?').get(reviewId) as Row | undefined);
  }

  /** The creator's one answer. false if there already is one. */
  saveReply(reviewId: string, text: string): boolean {
    const res = this.db
      .prepare('UPDATE market_reviews SET reply_text = ?, reply_at = ? WHERE review_id = ? AND reply_text IS NULL')
      .run(text, this.iso(), reviewId);
    return Number(res.changes) > 0;
  }

  /** Shown reviews of a profile, newest first. */
  reviewsOf(profileId: string, limit: number): ReviewRow[] {
    return (
      this.db
        .prepare('SELECT * FROM market_reviews WHERE profile_id = ? AND hidden = 0 ORDER BY created_at DESC, rowid DESC LIMIT ?')
        .all(profileId, limit) as Row[]
    ).map((r) => this.reviewRow(r)!);
  }

  /** All reviews of a profile incl. hidden ones (operator tool). */
  allReviewsOf(profileId: string): ReviewRow[] {
    return (this.db.prepare('SELECT * FROM market_reviews WHERE profile_id = ? ORDER BY created_at DESC').all(profileId) as Row[]).map(
      (r) => this.reviewRow(r)!,
    );
  }

  /** Operator hide of one review. Returns the profile id, or null if there is no such review. */
  setReviewHidden(dealHandle: string, hidden: boolean): string | null {
    const r = this.getReview(dealHandle);
    if (!r) return null;
    this.db.prepare('UPDATE market_reviews SET hidden = ? WHERE deal_handle = ?').run(hidden ? 1 : 0, dealHandle);
    this.recomputeStats(r.profile_id);
    return r.profile_id;
  }
}

// "Report" button: anyone can flag a creator profile, a
// review, a creator's answer to a review, or (the creator, from the inbox) a
// request. The report is stored for the operator; if TELEGRAM_REPORTS_CHAT_ID
// is set, our bot also sends ONE short message to that chat.
//
// Privacy: the reporter's IP is never stored. It only keys the in-memory rate
// limiters below (gone after a restart or when the window ends).
// The bot never forwards a clickable link from user text: links,
// domains, e-mails and @names in the text are broken up before sending.
// The operator hides things with the existing tools (scripts/market-admin.ts);
// scripts/reports.ts lists the open reports and says which command hides what.

import { DatabaseSync } from 'node:sqlite';

import type { FastifyBaseLogger, FastifyInstance } from 'fastify';

import type { Config } from './config.ts';
import { HttpError } from './errors.ts';
import { ipKey, ipPrefix, RateLimiter } from './guards.ts';
import type { MarketStore } from './market-store.ts';
import type { Store } from './store.ts';
import { httpTelegram, TelegramError, type TelegramApi } from './telegram.ts';

export const REPORT_KINDS = ['profile', 'review', 'reply', 'request'] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];
export const REPORT_REASONS = ['scam', 'link', 'offensive', 'other'] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];
/** Characters (Unicode code points), same as the web form. */
export const REPORT_TEXT_MAX = 500;

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** Per IP address (IPv6 /64) per minute, and per network (IPv4 /24, IPv6 /48) per day. */
const PER_IP_PER_MIN = 3;
const PER_NET_PER_DAY = 20;
/** One person reports one thing once a day; one thing gets at most this many reports an hour. */
const PER_TARGET_PER_HOUR = 10;
/** Telegram messages per hour at most, so a flood never buries the operator chat (the rest are still stored). */
const CHAT_MESSAGES_PER_HOUR = 30;

const ID_RE: Record<ReportKind, RegExp> = {
  profile: /^[0-9a-f]{24}$/,
  review: /^[0-9a-f]{16}$/,
  reply: /^[0-9a-f]{16}$/,
  request: /^[0-9a-f]{64}$/,
};

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const BAD_TEXT = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‪-‮⁦-⁩]/;

export interface ReportRow {
  id: number;
  kind: ReportKind;
  target_id: string;
  reason: ReportReason;
  text: string;
  status: 'open' | 'closed';
  created_at: string;
  closed_at: string | null;
}

export class ReportStore {
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(db: DatabaseSync, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        target_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        created_at TEXT NOT NULL,
        closed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS reports_status ON reports (status, id);
      CREATE INDEX IF NOT EXISTS reports_target ON reports (kind, target_id);
    `);
  }

  add(r: { kind: ReportKind; target_id: string; reason: ReportReason; text: string }): number {
    const res = this.db
      .prepare('INSERT INTO reports (kind, target_id, reason, text, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(r.kind, r.target_id, r.reason, r.text, new Date(this.now()).toISOString());
    return Number(res.lastInsertRowid);
  }

  list(opts: { all?: boolean; limit?: number } = {}): ReportRow[] {
    const sql = `SELECT * FROM reports ${opts.all ? '' : "WHERE status = 'open'"} ORDER BY id DESC LIMIT ?`;
    return this.db.prepare(sql).all(opts.limit ?? 200) as unknown as ReportRow[];
  }

  get(id: number): ReportRow | null {
    return (this.db.prepare('SELECT * FROM reports WHERE id = ?').get(id) as unknown as ReportRow | undefined) ?? null;
  }

  /** Open reports about the same thing (the operator sees how many people flagged it). */
  countOpenFor(kind: ReportKind, targetId: string): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM reports WHERE kind = ? AND target_id = ? AND status = 'open'").get(kind, targetId) as { n: number }).n);
  }

  /** Closes one report, or (`sameTarget`) every open report about the same thing. Returns how many were closed. */
  close(id: number, sameTarget = false): number {
    const r = this.get(id);
    if (!r) return 0;
    const at = new Date(this.now()).toISOString();
    const res = sameTarget
      ? this.db.prepare("UPDATE reports SET status = 'closed', closed_at = ? WHERE kind = ? AND target_id = ? AND status = 'open'").run(at, r.kind, r.target_id)
      : this.db.prepare("UPDATE reports SET status = 'closed', closed_at = ? WHERE id = ? AND status = 'open'").run(at, id);
    return Number(res.changes);
  }
}

// ---------------------------------------------------------------- the bot message (pure)

/**
 * User text made safe for a plain-text Telegram message: Telegram turns
 * anything that looks like a link, a domain, an e-mail or an @name into
 * something clickable, so those are broken up ("evil.com" -> "evil[.]com",
 * "https://" -> "hxxps[:]//", "@name" -> "(at)name"). Control and bidi
 * characters are removed; lines are joined.
 */
export function defang(s: string): string {
  return s
    .replace(/[\u0000-\u001F\u007F‪-‮⁦-⁩​-‏﻿]+/g, ' ')
    .replace(/h(?:t|x){2}p(s?):\/\//gi, (_m, s1: string) => `hxxp${s1}[:]//`)
    .replace(/:\/\//g, '[:]//')
    .replace(/[.。．｡․﹒](?=\S)/g, '[.]')
    .replace(/[@＠]/g, '(at)')
    .replace(/\s+/g, ' ')
    .trim();
}

const KIND_WORD: Record<ReportKind, string> = {
  profile: 'creator profile',
  review: 'review',
  reply: "creator's answer to a review",
  request: 'request (private: see the reports script)',
};
const REASON_WORD: Record<ReportReason, string> = {
  scam: 'scam or fraud',
  link: 'dangerous link or file',
  offensive: 'offensive',
  other: 'other',
};

/** The one operator message. Only our own site link is a link; the user's text is defanged. */
export function reportMessage(r: { id: number; kind: ReportKind; reason: ReportReason; text: string; link: string | null; count: number }): string {
  const lines = [`Pinky report #${r.id}: ${KIND_WORD[r.kind]}`, `Reason: ${REASON_WORD[r.reason]}`];
  if (r.text) lines.push(`Text: ${defang(r.text)}`);
  if (r.link) lines.push(`Open: ${r.link}`);
  if (r.count > 1) lines.push(`Open reports about this: ${r.count}`);
  lines.push(`Details and how to hide: node dist/scripts/reports.js show ${r.id}`);
  return lines.join('\n');
}

/** Our own site (first http(s) origin in CORS_ORIGIN), for the link in the operator message; null = no link. */
export function siteOrigin(corsOrigin: string): string | null {
  for (const o of corsOrigin.split(',').map((s) => s.trim())) {
    if (/^https?:\/\/[^/\s]+$/.test(o)) return o;
  }
  return null;
}

// ---------------------------------------------------------------- route

export interface ReportsDeps {
  config: Config;
  market: MarketStore;
  /** The server's store: reports go into the same SQLite file. */
  store: Store;
  now: () => number;
  log: FastifyBaseLogger;
  /** Tests pass a fake. */
  telegram?: TelegramApi;
}

export function registerReports(app: FastifyInstance, deps: ReportsDeps): { store: ReportStore } {
  const { config, market: ms, now, log } = deps;
  const db = (deps.store as { db?: DatabaseSync }).db ?? new DatabaseSync(':memory:');
  const rs = new ReportStore(db, now);
  const perMin = new RateLimiter(MIN, now);
  const perHour = new RateLimiter(HOUR, now);
  const perDay = new RateLimiter(DAY, now);
  const chatId = config.telegramReportsChatId;
  const tg: TelegramApi | null = chatId && config.telegramBotToken ? (deps.telegram ?? httpTelegram(config.telegramBotToken)) : null;
  const site = siteOrigin(config.corsOrigin);

  const bad = (message: string) => new HttpError(400, 'bad_request', message);
  const gone = () => new HttpError(404, 'not_found', 'nothing to report here (it is gone or already hidden)');
  const tooMany = () => new HttpError(429, 'rate_limited', 'too many reports for now; try again later');

  /** Checks the thing exists and is shown; returns the site link for the operator (null when it has no public page). */
  function target(kind: ReportKind, id: string): string | null {
    const page = (profileId: string) => (site ? `${site}/creators/${profileId}` : null);
    switch (kind) {
      case 'profile': {
        const p = ms.getProfile(id);
        if (!p || p.hidden || p.self_hidden) throw gone();
        return page(id);
      }
      case 'review':
      case 'reply': {
        const r = ms.getReviewById(id);
        if (!r || r.hidden || (kind === 'reply' && r.reply_text === null)) throw gone();
        return page(r.profile_id);
      }
      case 'request': {
        if (!ms.getRequest(id)) throw gone();
        return null;
      }
    }
  }

  app.post('/api/reports', async (req, reply) => {
    const ip = ipKey(req.ip);
    if (!perMin.take(`ip:${ip}`, PER_IP_PER_MIN)) throw tooMany();
    const body = (req.body ?? {}) as Record<string, unknown>;
    const kind = body.kind;
    if (typeof kind !== 'string' || !(REPORT_KINDS as readonly string[]).includes(kind)) throw bad(`kind must be one of ${REPORT_KINDS.join(', ')}`);
    const k = kind as ReportKind;
    const id = body.target_id;
    if (typeof id !== 'string' || !ID_RE[k].test(id)) throw gone();
    const reason = body.reason;
    if (typeof reason !== 'string' || !(REPORT_REASONS as readonly string[]).includes(reason)) throw bad(`reason must be one of ${REPORT_REASONS.join(', ')}`);
    const raw = body.text ?? '';
    if (typeof raw !== 'string') throw bad('text must be a string');
    const text = raw.trim();
    if ([...text].length > REPORT_TEXT_MAX) throw bad(`text is too long (max ${REPORT_TEXT_MAX} characters)`);
    if (LONE_SURROGATE.test(text) || BAD_TEXT.test(text)) throw bad('text has characters that are not allowed');

    const link = target(k, id);

    // The same person reporting the same thing again today: thank them, store nothing new.
    if (perDay.exhausted(`dup:${ip}:${k}:${id}`, 1)) {
      reply.status(202);
      return { ok: true };
    }
    if (perDay.exhausted(`net:${ipPrefix(req.ip)}`, PER_NET_PER_DAY)) throw tooMany();
    if (!perHour.take(`target:${k}:${id}`, PER_TARGET_PER_HOUR)) throw tooMany();
    perDay.take(`net:${ipPrefix(req.ip)}`, PER_NET_PER_DAY);
    perDay.take(`dup:${ip}:${k}:${id}`, 1);

    const rid = rs.add({ kind: k, target_id: id, reason: reason as ReportReason, text });
    if (tg && perHour.take('chat', CHAT_MESSAGES_PER_HOUR)) {
      const msg = reportMessage({ id: rid, kind: k, reason: reason as ReportReason, text, link, count: rs.countOpenFor(k, id) });
      // Not awaited by the reporter: the answer does not depend on Telegram.
      void tg.sendMessage(chatId, msg).catch((e: unknown) => {
        log.warn({ err: { name: (e as Error).name, status: (e as TelegramError).status } }, 'report message to the operator chat failed');
      });
    }
    reply.status(201);
    return { ok: true };
  });

  return { store: rs };
}

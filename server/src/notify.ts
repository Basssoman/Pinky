// Telegram deal notifications. Rules: no links, no details, only a confirmed subscription.
//
// Subscribe: on the "save your key" step (or the deal page) the browser signs
//   `escrow-v1|<contract>|notify|<payload>` with the party's deal key and
//   POSTs it to /api/deals/:handle/notify {op: "start"}; the server checks the
//   key belongs to that party and answers a one-time code (30 min). The
//   person opens t.me/<bot>?start=<code>; the bot takes the code once and
//   stores chat id ↔ deal handle + party. No link or key ever goes to the bot.
// Unsubscribe: /stop in the chat (all deals of the chat), or op "stop" signed
//   with the deal key (every chat of that party).
// Events: a watcher re-reads the subscribed deals from the chain (the same
//   reads the API does) and sends one fixed text per change: never an amount,
//   title, id or link. When the deal is over, every row about it is deleted.
// Review reminder: the client of a fully paid, finished deal made
//   from a request hears once "leave a review, less than 2 days left" when
//   2 of the 3 review days remain and no review was written. Only that
//   client's row waits for it after the deal is over; it goes with the
//   reminder, the review or the end of the window, whichever comes first.
// Split proposals ("work it out"): when one party publishes a signed split,
//   the OTHER party's confirmed chats get one fixed message right away: "your
//   deal has a new proposal, answer by <time> (UTC)". No amount, share,
//   title or link. At most one such message per chat and deal per hour, so a
//   party cannot flood the other side by re-posting proposals.
// Off unless TELEGRAM_BOT_TOKEN and TELEGRAM_BOT_USERNAME are set; then the
//   bot long-polls Telegram (no public webhook URL needed). Run ONE server
//   per bot token (Telegram allows one long poller).

import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from 'fastify';

import type { Chain, DealView } from './chain.ts';
import type { Config } from './config.ts';
import { isCanonicalSignature, parsePublicKey, sha256Hex, utf8Len, verifySignature } from './encoding.ts';
import { HttpError } from './errors.ts';
import { linkFacts, reviewUntilMs, type Market } from './market.ts';
import { ipKey, type RateLimiter } from './guards.ts';
import { NotifyStore, type NotifySub, type Party, type Seen } from './notify-store.ts';
import type { DealRecord, Store } from './store.ts';
import { BOT_TEXTS, botLang, httpTelegram, LOOKS_SECRET, newsText, proposalText, TelegramError, type NotifyEvent, type TelegramApi, type TgUpdate } from './telegram.ts';

const SEC_NS = 1_000_000_000n;
const DAY_NS = 86_400n * SEC_NS;
const CODE_TTL_MS = 30 * 60 * 1000;
const SIGNED_MAX_AGE_NS = 120n * SEC_NS;
const SIGNED_MAX_FUTURE_NS = 30n * SEC_NS;
const MAX_SUBS_PER_CHAT = 20;
/** Remind about the review when this much of the 3-day window is left. */
export const REVIEW_REMIND_MS = 2 * 86_400_000;
/** Quiet time per chat and deal after a "new proposal" message. */
export const PROPOSAL_NOTICE_GAP_MS = 3600_000;
const HANDLE_RE = /^[0-9a-f]{64}$/;
const CODE_RE = /^[A-Za-z0-9_-]{16,64}$/;

/** What a deal key signs to subscribe, unsubscribe or ask the status (no deal id: the client may not have joined yet). */
export const notifyMessage = (contractId: string, payload: string) => `escrow-v1|${contractId}|notify|${payload}`;

export interface NotifyDeps {
  config: Config;
  chain: Chain;
  store: Store;
  now: () => number;
  limiter: RateLimiter;
  log: FastifyBaseLogger;
  /** Tests pass a fake; then nothing starts by itself (call tick / handleUpdate). */
  telegram?: TelegramApi;
  /** The marketplace, for the review reminder. Without it there is no reminder. */
  market?: Pick<Market, 'reviewWindow' | 'store'>;
}

export interface Notify {
  /** The bot's username, or null when notifications are off. */
  bot: string | null;
  /** One pass of the deal watcher. */
  tick(): Promise<void>;
  /** One update from Telegram. */
  handleUpdate(u: TgUpdate): Promise<void>;
  /**
   * `signer` published a split proposal that can be answered until `answerByMs`:
   * tell the other party's confirmed chats. Never throws.
   */
  proposal(handle: string, signer: Party, answerByMs: number): Promise<void>;
  store: NotifyStore | null;
}

// ---------------------------------------------------------------- events (pure)

function outcomeKind(o: DealView['outcome']): string | null {
  if (o === null || o === undefined) return null;
  return typeof o === 'string' ? o : (Object.keys(o)[0] ?? null);
}

/** What the deal looks like now, as a baseline: nothing that already happened is sent later. */
export function snapshot(deal: DealView | null): Seen {
  if (!deal) return { s: 'None', o: null };
  return {
    s: deal.state,
    o: outcomeKind(deal.outcome),
    ...(deal.funded_at_ns ? { p: true } : {}),
    ...(deal.delivered_at_ns ? { d: true } : {}),
    ...(deal.disputed_at_ns ? { x: true } : {}),
  };
}

type SeenX = Seen;

/** The events one party should hear about since `prev`, and the new baseline. */
export function deriveEvents(party: Party, prev: Seen, deal: DealView, nowNs: bigint): { events: NotifyEvent[]; seen: Seen } {
  const was = prev as SeenX;
  const ev: NotifyEvent[] = [];
  const next: SeenX = { ...was, s: deal.state, o: outcomeKind(deal.outcome) };
  if (deal.purged) return { events: [], seen: next };

  if (deal.funded_at_ns && !was.p) {
    next.p = true;
    ev.push('paid');
  }
  if (deal.delivered_at_ns && !was.d) {
    next.d = true;
    if (party === 'client') ev.push('delivered');
  }
  if (deal.disputed_at_ns && !was.x) {
    next.x = true;
    if (party === 'creator') ev.push('dispute');
  }
  if (next.o && !was.o) {
    const byKind: Record<string, Partial<Record<Party, NotifyEvent>>> = {
      Accepted: { creator: 'accepted' },
      AutoReleased: { creator: 'accepted', client: 'ended' },
      RefundedByCreator: { client: 'refunded' },
      RefundedAfterDeadline: { creator: 'ended' },
      Cancelled: { client: 'ended' },
      ClosedUnpaid: { creator: 'ended', client: 'ended' },
      ArbiterSplit: { creator: 'decided', client: 'decided' },
      TimeoutSplit: { creator: 'decided', client: 'decided' },
      Settled: { creator: 'ended', client: 'ended' },
    };
    const e = (byKind[next.o] ?? { creator: 'ended', client: 'ended' })[party];
    if (e) ev.push(e);
  } else if (!next.o) {
    // Timer warnings, once each.
    if (party === 'client' && deal.state === 'Delivered' && deal.review_ends_at_ns && !was.rw) {
      const left = BigInt(deal.review_ends_at_ns) - nowNs;
      if (left > 0n && left <= DAY_NS) {
        next.rw = true;
        ev.push('review_soon');
      }
    }
    if (deal.state === 'Funded' && deal.delivery_deadline_ns) {
      const left = BigInt(deal.delivery_deadline_ns) - nowNs;
      if (party === 'creator' && !was.dw && left > 0n && left <= DAY_NS) {
        next.dw = true;
        ev.push('deliver_soon');
      }
      if (party === 'client' && !was.late && left <= 0n) {
        next.late = true;
        ev.push('late');
      }
    }
  }
  return { events: ev, seen: next };
}

/**
 * The review window of a deal from a request, as the watcher sees it:
 * `{until_ms, reviewed}` while it is open, "wait" while the deal is reviewable
 * on-chain but the marketplace has not stored its end yet (it re-reads linked
 * deals on its own timer), null when there is nothing to remind about.
 */
export type ReviewHold = { until_ms: number; reviewed: boolean } | 'wait' | null;

/** Send "leave a review, less than 2 days left" now? Client only, once, before a review exists. */
export function reviewReminderDue(party: Party, seen: Seen, hold: ReviewHold, nowMs: number): boolean {
  if (party !== 'client' || seen.rv || !hold || hold === 'wait' || hold.reviewed) return false;
  const left = hold.until_ms - nowMs;
  return left > 0 && left <= REVIEW_REMIND_MS;
}

/** The deal is over for good: nothing more to tell, the Telegram ↔ deal link goes. */
export function dealOver(deal: DealView, nowNs: bigint): boolean {
  if (deal.purged) return true;
  if (deal.outcome !== null && deal.outcome !== undefined && deal.settled) return true;
  return deal.state === 'Created' && nowNs > BigInt(deal.funding_cutoff_ns);
}

// ---------------------------------------------------------------- module

export function registerNotify(app: FastifyInstance, deps: NotifyDeps): Notify {
  const { config, chain, store, now, limiter, log } = deps;
  const username = config.telegramBotUsername;
  const on = Boolean(config.telegramBotToken && username);
  const nowNs = () => BigInt(now()) * 1_000_000n;
  const db = (store as { db?: DatabaseSync }).db ?? new DatabaseSync(':memory:');
  const ns = on ? new NotifyStore(db, now) : null;
  const tg: TelegramApi | null = on ? (deps.telegram ?? httpTelegram(config.telegramBotToken)) : null;
  const used = new Map<string, number>(); // signature -> expiry ms (single use)

  function reviewHold(handle: string, deal: DealView): ReviewHold {
    const market = deps.market;
    if (!market) return null;
    const w = market.reviewWindow(handle);
    if (w) return w.open ? { until_ms: w.until_ms, reviewed: w.reviewed } : null;
    const link = market.store.getLink(handle);
    if (!link || link.final) return null;
    // Linked, but the marketplace has not stored the end yet: wait if the chain says a review will be possible.
    const f = linkFacts(deal);
    if (!f?.reviewable) return null;
    // A deal that ended by itself keeps its window open up to 30 days + 3 days (until the client opens it).
    const until = f.ended_ms == null ? null : reviewUntilMs({ ended_ms: f.ended_ms, idle_end: f.idle, opened_ms: null }, config.reviewWindowSeconds * 1000);
    if (until !== null && now() >= until) return null;
    return 'wait';
  }

  async function dealIdOf(rec: DealRecord): Promise<number | null> {
    if (rec.deal_id !== null) return rec.deal_id;
    const id = await chain.getDealIdByOffer(rec.offer);
    if (id !== null) store.setDealId(rec.handle, id);
    return id;
  }

  // ------------------------------------------------------------ route

  app.post('/api/deals/:handle/notify', async (req: FastifyRequest) => {
    if (!ns) throw new HttpError(404, 'notify_off', 'notifications are not set up on this server');
    if (!limiter.take(`notify:${ipKey(req.ip)}`, config.rateWritesPerMin)) throw new HttpError(429, 'rate_limited', 'too many requests');
    const handle = (req.params as { handle?: string }).handle ?? '';
    const rec = HANDLE_RE.test(handle) ? store.getDeal(handle) : null;
    const token = req.headers['x-deal-token'];
    if (!rec || typeof token !== 'string' || token.length > 128 || sha256Hex(token) !== rec.handle) {
      throw new HttpError(404, 'not_found', 'deal not found');
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { payload, signature } = body;
    if (typeof payload !== 'string' || utf8Len(payload) > 1024) throw new HttpError(400, 'bad_request', 'payload must be a JSON string');
    if (!isCanonicalSignature(signature)) throw new HttpError(400, 'bad_signature_encoding', 'signature must be canonical base64 of 64 bytes');
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      throw new HttpError(400, 'bad_request', 'payload must be a JSON string');
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new HttpError(400, 'bad_request', 'payload must be a JSON object');
    const op = data.op;
    const party = data.role;
    const pk = data.pk;
    if (op !== 'start' && op !== 'stop' && op !== 'status') throw new HttpError(400, 'bad_request', 'payload.op must be start, stop or status');
    if (party !== 'creator' && party !== 'client') throw new HttpError(400, 'bad_request', 'payload.role must be creator or client');
    if (data.handle !== rec.handle) throw new HttpError(400, 'bad_request', 'payload.handle must be this deal');
    if (typeof pk !== 'string' || !parsePublicKey(pk)) throw new HttpError(400, 'bad_request', 'payload.pk must be an ed25519 key');
    const issued = data.issued_at_ns;
    if (typeof issued !== 'string' || !/^\d{1,20}$/.test(issued)) throw new HttpError(400, 'bad_request', 'payload.issued_at_ns is required');
    const age = nowNs() - BigInt(issued);
    if (age > SIGNED_MAX_AGE_NS || age < -SIGNED_MAX_FUTURE_NS) {
      throw new HttpError(401, 'stale_request', 'payload.issued_at_ns must be within the last 2 minutes');
    }
    if (!verifySignature(pk, notifyMessage(chain.contractId, payload), signature)) {
      throw new HttpError(401, 'invalid_signature', 'signature does not match the key');
    }
    const t = now();
    for (const [k, exp] of used) if (exp < t) used.delete(k);
    if ((used.get(signature) ?? 0) > t) throw new HttpError(401, 'replayed_request', 'this signed request was already used');
    used.set(signature, t + Number((SIGNED_MAX_AGE_NS + SIGNED_MAX_FUTURE_NS) / 1_000_000n));

    // The key must be this party's key of this deal.
    let deal: DealView | null = null;
    let pending: string | null = null;
    if (party === 'creator') {
      if (pk !== rec.creator_pk) throw new HttpError(403, 'wrong_key', 'this is not the creator key of this deal');
    }
    const id = await dealIdOf(rec);
    if (id !== null) {
      deal = await chain.getDeal(id);
      if (!deal) throw new HttpError(502, 'chain_mismatch', 'deal not found on chain');
      if (party === 'client' && pk !== deal.client_pk) throw new HttpError(403, 'wrong_key', 'this is not the client key of this deal');
    } else if (party === 'client') {
      // Not joined yet: the key is checked against the chain once the client joins.
      pending = pk;
    }

    if (op === 'status') return { subscribed: ns.countFor(rec.handle, party) > 0, bot: username };
    if (op === 'stop') return { ok: true, removed: ns.removeParty(rec.handle, party) };

    if (!limiter.take(`notifycode:${rec.handle}:${party}`, 5)) {
      throw new HttpError(429, 'rate_limited', 'too many codes for this deal; wait a minute');
    }
    if (deal && dealOver(deal, nowNs())) throw new HttpError(409, 'deal_over', 'this deal is over; there is nothing to notify about');
    const code = randomBytes(24).toString('base64url');
    ns.addCode(code, { handle: rec.handle, party, pending_pk: pending, lang: botLang(data.lang), seen: snapshot(deal), expires_ms: t + CODE_TTL_MS });
    return { code, bot: username, expires_in_seconds: CODE_TTL_MS / 1000 };
  });

  if (!ns || !tg) {
    return { bot: null, tick: async () => {}, handleUpdate: async () => {}, proposal: async () => {}, store: null };
  }

  // ------------------------------------------------------------ bot

  async function send(chatId: string, text: string): Promise<void> {
    try {
      await tg!.sendMessage(chatId, text);
    } catch (e) {
      if (e instanceof TelegramError && e.gone) {
        ns!.removeChat(chatId);
        return;
      }
      // No chat id or text in the log.
      log.warn({ err: { name: (e as Error).name, status: (e as TelegramError).status } }, 'telegram send failed');
    }
  }

  async function handleUpdate(u: TgUpdate): Promise<void> {
    const m = u.message;
    if (!m || typeof m.text !== 'string' || !m.chat) return;
    // /chatid works in any chat (a private one or a team group): the operator
    // puts the answer into TELEGRAM_REPORTS_CHAT_ID. Never logged.
    if (/^\/chatid(?:@\w+)?\s*$/.test(m.text.trim())) {
      const from = (m as { from?: { language_code?: string } }).from;
      return send(String(m.chat.id), BOT_TEXTS[botLang(from?.language_code === 'uk' ? 'uk' : 'en')].chatId(String(m.chat.id)));
    }
    if (m.chat.type !== 'private') return;
    const chat = String(m.chat.id);
    const text = m.text.trim();
    const from = (m as { from?: { language_code?: string } }).from;
    const lang = botLang(from?.language_code === 'uk' ? 'uk' : 'en');
    const start = /^\/start(?:@\w+)?(?:\s+(\S+))?\s*$/.exec(text);
    if (start) {
      const code = start[1];
      if (!code) return send(chat, BOT_TEXTS[lang].hello);
      const c = CODE_RE.test(code) ? ns!.takeCode(code) : null;
      if (!c) return send(chat, BOT_TEXTS[lang].badCode);
      const l = botLang(c.lang);
      const already = ns!.subsOf(c.handle).some((s) => s.chat_id === chat && s.party === c.party);
      if (!already && ns!.countForChat(chat) >= MAX_SUBS_PER_CHAT) return send(chat, BOT_TEXTS[l].tooMany);
      ns!.subscribe({ chat_id: chat, handle: c.handle, party: c.party, pending_pk: c.pending_pk, lang: l, seen: c.seen });
      return send(chat, BOT_TEXTS[l].subscribed);
    }
    if (/^\/stop(?:@\w+)?\s*$/.test(text)) {
      const n = ns!.removeChat(chat);
      return send(chat, n > 0 ? BOT_TEXTS[lang].stopped : BOT_TEXTS[lang].stoppedNone);
    }
    if (LOOKS_SECRET.test(text)) {
      // The bot never takes links or keys: try to delete it, and say why.
      try {
        await tg!.deleteMessage(chat, m.message_id);
      } catch {
        /* too old or not allowed: the text asks the person to delete it */
      }
      return send(chat, BOT_TEXTS[lang].noLinks);
    }
    return send(chat, BOT_TEXTS[lang].help);
  }

  // ------------------------------------------------------------ split proposals

  const proposalTold = new Map<string, number>(); // chat|handle|party -> ms of the last message

  async function proposal(handle: string, signer: Party, answerByMs: number): Promise<void> {
    try {
      const t = now();
      if (answerByMs <= t) return;
      for (const [k, at] of proposalTold) if (t - at >= PROPOSAL_NOTICE_GAP_MS) proposalTold.delete(k);
      const other: Party = signer === 'creator' ? 'client' : 'creator';
      for (const sub of ns!.subsOf(handle)) {
        // Only confirmed subscriptions: a pre-join client key is checked by the watcher first.
        if (sub.party !== other || sub.pending_pk) continue;
        const key = `${sub.chat_id}|${handle}|${other}`;
        if (proposalTold.has(key)) continue;
        proposalTold.set(key, t);
        await send(sub.chat_id, proposalText(botLang(sub.lang), answerByMs));
      }
    } catch {
      log.warn('telegram proposal notice failed');
    }
  }

  // ------------------------------------------------------------ watcher

  let ticking = false;
  async function tick(): Promise<void> {
    if (ticking) return;
    ticking = true;
    try {
      await tellKeyResets();
      for (const handle of ns!.handles()) {
        try {
          await checkDeal(handle);
        } catch {
          /* chain unreachable: try again next time */
        }
      }
    } finally {
      ticking = false;
    }
  }

  /**
   * A key reset confirmed by support -> one fixed
   * message to every chat subscribed as the CREATOR of a deal made from that
   * profile (that deal key was signed by the profile key). Profiles have no
   * subscription of their own; an owner with no such deal hears nothing here
   * (the inbox banner and the profile page still show it).
   */
  async function tellKeyResets(): Promise<void> {
    const market = deps.market;
    if (!market) return;
    for (const r of market.store.resetsToTell()) {
      market.store.markResetTold(r.reset_id);
      const chats = new Map<string, string>();
      for (const h of market.store.linkedDeals(r.profile_id)) {
        for (const s of ns!.subsOf(h)) if (s.party === 'creator' && !s.pending_pk) chats.set(s.chat_id, s.lang);
      }
      for (const [chat, lang] of chats) await send(chat, BOT_TEXTS[botLang(lang)].keyReset);
    }
  }

  async function checkDeal(handle: string): Promise<void> {
    const rec = store.getDeal(handle);
    if (!rec) return ns!.removeHandle(handle);
    const id = await dealIdOf(rec);
    if (id === null) {
      let expires = 0n;
      try {
        expires = BigInt((JSON.parse(rec.offer) as { offer_expires_at_ns: string }).offer_expires_at_ns);
      } catch {
        /* unreadable offer: treat as expired */
      }
      // The link expired or was cancelled before anyone joined: the deal never started.
      if (rec.revoked_at || nowNs() > expires + 60n * SEC_NS) ns!.removeHandle(handle);
      return;
    }
    const deal = await chain.getDeal(id);
    if (!deal) return;
    const t = nowNs();
    const hold = reviewHold(handle, deal);
    for (const sub of ns!.subsOf(handle)) {
      if (sub.pending_pk) {
        // Subscribed before joining: only the key that really joined keeps the subscription.
        if (sub.pending_pk !== deal.client_pk) {
          ns!.removeSub(sub);
          continue;
        }
        ns!.clearPendingPk(sub);
      }
      await tell(sub, deal, t, hold);
    }
    if (!dealOver(deal, t)) return;
    if (hold === 'wait' || (hold && !hold.reviewed)) {
      // Only a client still waiting for the review reminder stays (deleted once the window is over).
      for (const s of ns!.subsOf(handle)) if (s.party !== 'client' || s.seen.rv) ns!.removeSub(s);
    } else ns!.removeHandle(handle);
  }

  async function tell(sub: NotifySub, deal: DealView, t: bigint, hold: ReviewHold): Promise<void> {
    const { events, seen } = deriveEvents(sub.party, sub.seen, deal, t);
    if (reviewReminderDue(sub.party, seen, hold, Number(t / 1_000_000n))) {
      seen.rv = true;
      events.push('leave_review');
    }
    ns!.setSeen(sub, seen);
    if (events.length) await send(sub.chat_id, newsText(botLang(sub.lang), events));
  }

  // ------------------------------------------------------------ loops (real bot only)

  if (!deps.telegram) {
    const stop = new AbortController();
    let offset = 0;
    const sleep = (ms: number) =>
      new Promise<void>((r) => {
        const t = setTimeout(r, ms);
        t.unref();
      });
    const poll = async () => {
      let backoff = 1000;
      while (!stop.signal.aborted) {
        try {
          const updates = await tg.getUpdates(offset, 25, stop.signal);
          backoff = 1000;
          for (const u of updates) {
            offset = Math.max(offset, u.update_id + 1);
            try {
              await handleUpdate(u);
            } catch {
              log.warn('telegram update failed');
            }
          }
        } catch (e) {
          if (stop.signal.aborted) break;
          log.warn({ err: { name: (e as Error).name, status: (e as TelegramError).status } }, 'telegram poll failed');
          await sleep(backoff);
          backoff = Math.min(backoff * 2, 60_000);
        }
      }
    };
    const timer = setInterval(() => void tick(), Math.max(10, config.notifyPollSeconds) * 1000);
    timer.unref();
    app.addHook('onReady', async () => {
      void poll();
    });
    app.addHook('onClose', async () => {
      stop.abort();
      clearInterval(timer);
    });
  }

  return { bot: username, tick, handleUpdate, proposal, store: ns };
}

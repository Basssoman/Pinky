// Telegram deal notifications, the browser side.
// The deal key signs "subscribe / stop / status" for its own deal; the server
// answers a one-time code for t.me/<bot>?start=<code>. Nothing secret goes to
// the server or to Telegram: no key, no link, no token in the code.

import { randomHex } from './bytes';
import { MESSAGE_PREFIX, keyFromSeed, sign } from './keys';
import type { LocalDeal } from './local';

/** What a deal key signs for the bot routes (no deal id: the client may not have joined yet). */
export const notifyMessage = (contractId: string, payload: string) => `${MESSAGE_PREFIX}|${contractId}|notify|${payload}`;

export type NotifyOp = 'start' | 'stop' | 'status';

export interface NotifyApi {
  /** The bot's username, or null when the server has no bot (the site then hides the button). */
  bot(): Promise<string | null>;
  start(handle: string, token: string, body: { payload: string; signature: string }): Promise<{ code: string; bot: string; expires_in_seconds: number }>;
  stop(handle: string, token: string, body: { payload: string; signature: string }): Promise<{ ok: boolean; removed: number }>;
  status(handle: string, token: string, body: { payload: string; signature: string }): Promise<{ subscribed: boolean }>;
}

export class NotifyError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'NotifyError';
    this.status = status;
    this.code = code;
  }
}

export function httpNotify(base: string, fetchImpl: typeof fetch = (...a) => fetch(...a)): NotifyApi {
  let botOnce: Promise<string | null> | null = null;
  async function call<T>(method: 'GET' | 'POST', path: string, token?: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers['X-Deal-Token'] = token;
    let res: Response;
    try {
      res = await fetchImpl(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
    } catch {
      throw new NotifyError(0, 'unreachable', 'The server is not responding.');
    }
    let json: Record<string, unknown> = {};
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      /* not JSON */
    }
    if (!res.ok) throw new NotifyError(res.status, String(json.error ?? 'error'), String(json.message ?? `HTTP ${res.status}`));
    return json as T;
  }
  const at = (handle: string) => `/api/deals/${handle}/notify`;
  return {
    bot: () => {
      botOnce ??= call<{ telegram_bot?: unknown }>('GET', '/api/config')
        .then((c) => (typeof c.telegram_bot === 'string' && /^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(c.telegram_bot) ? c.telegram_bot : null))
        .catch(() => {
          botOnce = null; // try again next time
          return null;
        });
      return botOnce;
    },
    start: (h, token, body) => call('POST', at(h), token, body),
    stop: (h, token, body) => call('POST', at(h), token, body),
    status: (h, token, body) => call('POST', at(h), token, body),
  };
}

/** The signed request for one op, made with this party's deal key. */
export function signNotify(
  contractId: string,
  local: Pick<LocalDeal, 'role' | 'handle' | 'seed'>,
  op: NotifyOp,
  lang: string,
  nowMs: number,
): { payload: string; signature: string } {
  const key = keyFromSeed(local.seed);
  const payload = JSON.stringify({
    op,
    role: local.role,
    pk: key.pk,
    handle: local.handle,
    lang: lang === 'uk' ? 'uk' : 'en',
    issued_at_ns: (BigInt(Math.floor(nowMs)) * 1_000_000n).toString(),
    nonce: randomHex(8),
  });
  return { payload, signature: sign(key, notifyMessage(contractId, payload)) };
}

/** The deep link the person opens; it carries only the one-time code. */
export const botLink = (bot: string, code: string): string => `https://t.me/${bot}?start=${encodeURIComponent(code)}`;

// "Get deal updates in Telegram": on the key step and on
// the deal page, for both parties. Hidden when the server has no bot. The deal
// key signs the request; the bot gets only a one-time code, never a link.
import { useEffect, useState } from 'react';
import { useLang, useT } from './i18n';
import { NET } from './lib/config';
import type { LocalDeal } from './lib/local';
import { botLink, httpNotify, signNotify, type NotifyApi, type NotifyOp } from './lib/notify';
import { getCtx } from './real/ctx';

/**
 * Development only: `?bot=SomeBot` shows the Telegram block with a pretend bot
 * and no network calls, to look at it on the example-deal pages.
 */
const DEV_BOT = import.meta.env.DEV ? new URLSearchParams(window.location.search).get('bot') : null;
export const DEV_PREVIEW = DEV_BOT !== null && /^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(DEV_BOT);

function previewApi(bot: string): NotifyApi {
  let on = false;
  let asked = 0;
  return {
    bot: async () => bot,
    start: async () => ({ code: 'DEV-PREVIEW-NOT-A-CODE', bot, expires_in_seconds: 1800 }),
    stop: async () => {
      on = false;
      return { ok: true, removed: 1 };
    },
    // Pretends the person pressed Start a little after the button was shown.
    status: async () => ({ subscribed: on || (asked++ > 2 && (on = true)) }),
  };
}

let api: NotifyApi | null = null;
export const getNotify = (): NotifyApi => (api ??= DEV_PREVIEW ? previewApi(DEV_BOT!) : httpNotify(NET.apiBase));

/** The official bot's username, or null (no bot on this server / server down). */
export function useBot(): string | null | undefined {
  const [bot, setBot] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    void getNotify()
      .bot()
      .then((b) => alive && setBot(b));
    return () => {
      alive = false;
    };
  }, []);
  return bot;
}

const CODE_LIFE_MS = 30 * 60 * 1000;

export function TelegramNotify({ local }: { local: Pick<LocalDeal, 'role' | 'handle' | 'seed' | 'token'> }) {
  const bot = useBot();
  const tt = useT();
  const k = tt.key;
  const n = tt.notify;
  const lang = useLang().code;
  const [st, setSt] = useState<'idle' | 'busy' | 'code' | 'on' | 'stopped'>('idle');
  const [code, setCode] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const signed = (op: NotifyOp) => {
    const ctx = getCtx();
    return signNotify(ctx.net.contractId, local, op, lang, ctx.now());
  };

  // Already on? (asked once, signed with the key)
  useEffect(() => {
    if (!bot) return;
    let alive = true;
    getNotify()
      .status(local.handle, local.token, signed('status'))
      .then((r) => alive && r.subscribed && setSt('on'))
      .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bot, local.handle]);

  // While the Telegram button is shown: notice when the person pressed Start.
  useEffect(() => {
    if (st !== 'code') return;
    const since = Date.now();
    const timer = window.setInterval(() => {
      if (Date.now() - since > CODE_LIFE_MS) {
        setCode(null);
        setSt('idle');
        return;
      }
      if (document.hidden) return;
      getNotify()
        .status(local.handle, local.token, signed('status'))
        .then((r) => {
          if (r.subscribed) {
            setCode(null);
            setSt('on');
          }
        })
        .catch(() => {});
    }, 5000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st]);

  if (!bot) return null;

  const connect = async () => {
    setFailed(false);
    setSt('busy');
    try {
      const r = await getNotify().start(local.handle, local.token, signed('start'));
      setCode(r.code);
      setSt('code');
    } catch {
      setFailed(true);
      setSt('idle');
    }
  };

  const stop = async () => {
    setFailed(false);
    setSt('busy');
    try {
      await getNotify().stop(local.handle, local.token, signed('stop'));
      setSt('stopped');
    } catch {
      setFailed(true);
      setSt('on');
    }
  };

  const line = st === 'on' ? n.on(bot) : st === 'code' ? n.openHint : st === 'stopped' ? n.stopped : n.privacy;

  return (
    <div className="notify" aria-live="polite">
      <div>
        <p className="notify-title">{k.telegram}</p>
        <p className="hint">{line}</p>
        <p className="hint">{n.onlyBot(bot)}</p>
        {failed && (
          <p className="hint notify-failed" role="alert">
            {n.failed}
          </p>
        )}
      </div>
      {st === 'code' && code ? (
        <a className="cta cta-inline" href={botLink(bot, code)} target="_blank" rel="noopener noreferrer">
          {n.open(bot)}
        </a>
      ) : st === 'on' ? (
        <button className="btn-ghost" type="button" onClick={stop}>
          {n.stop}
        </button>
      ) : (
        <button className="btn-ghost" type="button" disabled={st === 'busy'} onClick={connect}>
          {st === 'busy' ? k.oneMoment : k.connectTelegram}
        </button>
      )}
    </div>
  );
}

/** One line for every page footer: the exact name of the only official bot. */
export function BotLine() {
  const bot = useBot();
  const n = useT().notify;
  return bot ? <p>{n.onlyBot(bot)}</p> : null;
}

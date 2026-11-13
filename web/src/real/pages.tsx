// The smaller real pages: "New deal", the personal key link, the service
// status page and the page about how disputes are decided.
import { useEffect, useState } from 'react';
import { clearDraft, CreatePage, loadDraft, saveDraft, type Terms } from '../CreatePage';
import { LINK_MAX } from '../lib/limits';
import { UnfinishedDeals } from '../Unfinished';
import { DAY } from '../deal';
import { locale, useT } from '../i18n';
import { KeyLinkPage } from '../KeyLinkPage';
import type { Health } from '../lib/api';
import { nsToMs } from '../lib/chain';
import { SUPPORT_CONTACT } from '../lib/config';
import { createDeal } from '../lib/flows';
import { keyFromSeed, sha256Hex } from '../lib/keys';
import { parsePersonalLink, rememberUnlocked } from '../lib/local';
import { parseSealedLink } from '../lib/passkey';
import { OpenChoice } from '../PasskeyProtect';
import { Notice } from '../ui';
import { useProfileKey } from '../market/ctx';
import { PREFILL_KEY, type RequestPrefill } from '../market/Inbox';
import { getCtx, navigate, useContractLimits } from './ctx';

const DAY_S = 24 * 3600;

/** Sets the tab title, and again when the language changes. */
function useTitle(title: string) {
  useEffect(() => {
    document.title = title;
  }, [title]);
}

/** What "Make a deal from it" in the inbox left for this tab (null = a deal without a request). */
function readPrefill(): RequestPrefill | null {
  const handle = new URLSearchParams(window.location.search).get('request');
  if (!handle || !/^[0-9a-f]{64}$/.test(handle)) return null;
  try {
    const p = JSON.parse(sessionStorage.getItem(PREFILL_KEY) ?? 'null') as RequestPrefill | null;
    return p && p.handle === handle ? p : null;
  } catch {
    return null;
  }
}

function prefillTerms(p: RequestPrefill, generalTitle: string): Partial<Terms> {
  let days = p.deliveryDays;
  if (p.wantedDeadline) {
    const ms = new Date(`${p.wantedDeadline}T23:59:59Z`).getTime() - Date.now();
    if (Number.isFinite(ms) && ms > 0) days = Math.min(90, Math.max(1, Math.floor(ms / (DAY_S * 1000))));
  }
  return {
    title: (p.serviceTitle ?? generalTitle).slice(0, 200),
    work: p.brief.slice(0, 4800),
    ...(p.priceFrom ? { price: String(p.priceFrom) } : {}),
    ...(days ? { deliveryDays: String(days) } : {}),
  };
}

/** `/new`: the creator seals the terms; then `/d#token` takes over (save the key, send the link). */
export function NewDeal() {
  const tt = useT();
  useTitle(tt.titles.newDeal);
  const [prefill] = useState(readPrefill);
  const [draft] = useState(() => (readPrefill() ? null : loadDraft()));
  const profileKey = useProfileKey();
  const limits = useContractLimits();
  const linkable = prefill !== null && profileKey !== null;
  // Development only: "?unit=min" reads the day fields as minutes, to try the timers on a local sandbox.
  const unit = import.meta.env.DEV && new URLSearchParams(window.location.search).get('unit') === 'min' ? 60 : DAY_S;
  const create = async (t: Terms) => {
    const deal = await createDeal(getCtx(), {
      title: t.title,
      work: t.work,
      gets: t.gets,
      revisions: Number(t.revisions),
      price: t.price.trim(),
      deliverySeconds: Number(t.deliveryDays) * unit,
      reviewSeconds: Number(t.reviewDays) * unit,
      // "As long as the contract allows": the flow cuts it to the contract limit (lib/flows.ts linkNs).
      linkSeconds: t.linkDays === LINK_MAX ? Math.floor((limits?.maxLinkMs ?? DAY) / 1000) : Number(t.linkDays) * DAY_S,
      ...(linkable ? { fromRequest: { handle: prefill.handle, profileKey, clientBoxPk: prefill.clientBoxPk } } : {}),
    });
    if (!prefill) clearDraft();
    if (linkable) {
      try {
        sessionStorage.removeItem(PREFILL_KEY);
      } catch {
        /* nothing to clean */
      }
    }
    navigate(`/d#${deal.token}`);
  };
  const m = tt.market.fromRequest;
  const note = prefill ? (
    <div className={linkable ? 'panel mk-from-request' : 'notice'}>
      <span className="keylink-label">{m.tag}</span>
      <p className="mk-pre mk-from-brief">{prefill.brief.length > 280 ? `${prefill.brief.slice(0, 278)}…` : prefill.brief}</p>
      <p className="hint">{linkable ? m.line : m.noProfileKey}</p>
    </div>
  ) : null;
  return (
    <CreatePage
      onCreate={create}
      initial={prefill ? prefillTerms(prefill, m.generalTitle) : (draft ?? undefined)}
      onDraft={prefill ? undefined : saveDraft}
      limits={limits ?? undefined}
      note={
        <>
          <UnfinishedDeals />
          {note}
        </>
      }
    />
  );
}

/** `/k#…`: the personal link. Stores the key in this browser only after the person confirms it is theirs. */
export function KeyLink() {
  const ctx = getCtx();
  const tt = useT();
  const t = tt.notice;
  const [parsed] = useState(() => parsePersonalLink(window.location.hash));
  // A Face ID link (`k2`): the key inside opens only with the passkey.
  const [sealedLink] = useState(() => (parsed ? null : parseSealedLink(window.location.hash)));
  useTitle(tt.titles.secretKey);
  if (sealedLink) {
    const s = sealedLink;
    const sHandle = sha256Hex(s.token);
    const here = ctx.store.get(sHandle);
    // Already in this browser: its deal page asks how to open it if needed.
    if (here) {
      return <KeyLinkPage held title={here.title} onOpen={() => navigate(`/d#${s.token}`, true)} onLeave={() => navigate('/', true)} />;
    }
    // A new browser: the same link for everyone, two ways in.
    const opened = (seed: string) => {
      ctx.store.put({ role: s.role, token: s.token, handle: sHandle, seed, saved: true, title: '', createdAt: ctx.now(), sealed: { ...s.sealed, pk: keyFromSeed(seed).pk } });
      navigate(`/d#${s.token}`, true);
    };
    return (
      <main className="keylink" aria-labelledby="keylink-title">
        <p className="keylink-label">{tt.passkey.label}</p>
        <h1 id="keylink-title">{tt.passkey.openTitle}</h1>
        <p className="lead">{tt.passkey.openLead}</p>
        <OpenChoice sealed={s.sealed} role={s.role} token={s.token} handle={sHandle} onOpened={opened} />
        <p className="hint">{tt.keylink.never}</p>
      </main>
    );
  }
  if (!parsed) {
    return <Notice title={t.notKeyLink} lines={[t.notKeyLinkLine]} />;
  }
  const handle = sha256Hex(parsed.token);
  const existing = ctx.store.get(handle);
  // The key file (`k1`) of a deal protected here: the same key, so it unlocks it without the passkey.
  const sameSealed = Boolean(existing?.sealed?.pk) && existing!.sealed!.pk === keyFromSeed(parsed.seed).pk;
  if (existing && existing.seed !== parsed.seed && !sameSealed) {
    return <Notice tone="warn" title={t.otherKeyHere} lines={[t.otherKeyHereLine]} />;
  }
  const open = () => {
    if (!existing) {
      ctx.store.put({ role: parsed.role, token: parsed.token, handle, seed: parsed.seed, saved: true, title: '', createdAt: ctx.now() });
    } else if (sameSealed) {
      rememberUnlocked(handle, parsed.seed);
    }
    // The key leaves the address bar and the history at once.
    navigate(`/d#${parsed.token}`, true);
  };
  return <KeyLinkPage held={existing !== null} title={existing?.title ?? ''} onOpen={open} onLeave={() => navigate('/', true)} />;
}

type Check = 'checking' | 'ok' | 'slow' | 'down';

/** `/status`: is the service working right now. */
export function StatusPage() {
  const ctx = getCtx();
  const tt = useT();
  const t = tt.status;
  const [api, setApi] = useState<Check>('checking');
  const [chain, setChain] = useState<Check>('checking');
  const [health, setHealth] = useState<Health | null>(null);
  const [at, setAt] = useState<Date | null>(null);
  useTitle(tt.titles.status);

  useEffect(() => {
    let alive = true;
    const check = () => {
      ctx.api
        .health()
        .then((h) => {
          if (!alive) return;
          setHealth(h);
          setApi(h.ok ? 'ok' : 'slow');
        })
        .catch(() => alive && setApi('down'));
      ctx.chain
        .getTimeMs()
        .then((t) => alive && setChain(Date.now() - t < 120_000 ? 'ok' : 'slow'))
        .catch(() => alive && setChain('down'));
      setAt(new Date());
    };
    check();
    const timer = window.setInterval(check, 30_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [ctx]);

  const word = (c: Check, ok: string, slow: string, down: string) =>
    c === 'checking' ? t.checking : c === 'ok' ? ok : c === 'slow' ? slow : down;
  const allOk = api === 'ok' && chain === 'ok';
  const anyDown = api === 'down' || chain === 'down';

  return (
    <main className="home">
      <section className="home-section" aria-labelledby="status-title">
        <h1 id="status-title">{t.title}</h1>
        <div className={`hero ${anyDown ? 'hero-warn' : allOk ? 'hero-safe' : 'hero-wait'}`} role="status">
          <span className="hero-mark" aria-hidden="true" />
          <div>
            <p className="hero-big">
              {api === 'checking' || chain === 'checking' ? t.checking : allOk ? t.allOk : anyDown ? t.down : t.slow}
            </p>
            <p className="hero-line">{t.moneySafe}</p>
          </div>
        </div>
        <dl className="facts">
          <div>
            <dt>{t.server}</dt>
            <dd>
              {word(api, t.serverOk, t.serverSlow, t.serverDown)} {api === 'down' && t.serverDownMore}
              {api === 'slow' && health?.warnings.length ? t.serverWait : ''}
            </dd>
          </div>
          <div>
            <dt>{t.near}</dt>
            <dd>{word(chain, t.nearOk, t.nearSlow, t.nearDown)}</dd>
          </div>
        </dl>
        {at && (
          <p className="hint">
            {t.checkedAt(at.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit', hour12: false }))}
          </p>
        )}
        {SUPPORT_CONTACT && <p className="hint">{t.support(SUPPORT_CONTACT)}</p>}
      </section>
    </main>
  );
}

function monthName(month: string): string {
  const d = new Date(`${month}-01T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? month : d.toLocaleDateString(locale(), { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** `/disputes`: the published arbiter rules and the public log of decisions. */
export function DisputesPage() {
  const tt = useT();
  const t = tt.disputes;
  const [log, setLog] = useState<{ month: string; outcome: string; reason: string }[] | null | 'error'>(null);
  // The arbiter's time is a setting of the contract: read it from the chain (7 days by default).
  const [disputeMs, setDisputeMs] = useState(7 * DAY);
  useTitle(tt.titles.disputes);
  useEffect(() => {
    let alive = true;
    const ctx = getCtx();
    ctx.api
      .disputeLog()
      .then((l) => alive && setLog(l))
      .catch(() => alive && setLog('error'));
    ctx.chain
      .getPeriods()
      .then((p) => alive && setDisputeMs(nsToMs(p.disputePeriodNs)))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const outcomes: Record<string, string> = { creator: t.outcomeCreator, client: t.outcomeClient, split: t.outcomeSplit };

  return (
    <main className="home">
      <section className="home-section" aria-labelledby="rules-title">
        <h1 id="rules-title">{t.title}</h1>
        <p className="home-lead">{t.lead}</p>
        <dl className="facts">
          <div>
            <dt>{t.who}</dt>
            <dd>{t.whoText}</dd>
          </div>
          <div>
            <dt>{t.what}</dt>
            <dd>{t.whatText}</dd>
          </div>
          <div>
            <dt>{t.point}</dt>
            <dd>{t.pointText}</dd>
          </div>
          <div>
            <dt>{t.files}</dt>
            <dd>{t.filesText}</dd>
          </div>
          <div>
            <dt>{t.time}</dt>
            <dd>{t.timeText(disputeMs)}</dd>
          </div>
          <div>
            <dt>{t.fee}</dt>
            <dd>{t.feeText}</dd>
          </div>
          <div>
            <dt>{t.limit}</dt>
            <dd>{t.limitText}</dd>
          </div>
        </dl>
      </section>

      <section className="home-section" aria-labelledby="log-title">
        <h2 id="log-title">{t.logTitle}</h2>
        <p className="hint">{t.logHint}</p>
        {log === null ? (
          <p className="hint" role="status">
            {t.loading}
          </p>
        ) : log === 'error' ? (
          <p className="hint">{t.logFailed}</p>
        ) : log.length === 0 ? (
          <p className="hint">{t.none}</p>
        ) : (
          <dl className="facts">
            {log.map((e, i) => (
              <div key={i}>
                <dt>{monthName(e.month)}</dt>
                <dd>{t.line(outcomes[e.outcome] ?? e.outcome, e.reason)}</dd>
              </div>
            ))}
          </dl>
        )}
      </section>
    </main>
  );
}

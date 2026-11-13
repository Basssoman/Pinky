// `/d#<token>`: one address for the whole deal, for both sides. What it shows
// depends on the key this browser holds and on the deal as it is ON-CHAIN:
// the client's terms → key → pay path, the creator's key → link path, then
// "Your deal". Reload-safe: nothing here lives only in memory.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../lib/api';
import { ChainError } from '../lib/chain';
import {
  DealError,
  joinDeal,
  loadDeal,
  markKeySaved,
  ownPayout,
  prepareClientKey,
  refreshDeal,
  revokeLink,
  timerOver,
  waitChain,
  type LoadedDeal,
} from '../lib/flows';
import { clientLink, personalLink } from '../lib/local';
import { Share } from '../CreatePage';
import { fmtDate, usd, type DealInfo } from '../deal';
import { tr, useT } from '../i18n';
import { DealPage } from '../DealPage';
import { DealSummary } from '../DealSummary';
import { KeyStep } from '../KeyStep';
import { sha256Hex } from '../lib/keys';
import { isLocked, UnlockScreen } from '../PasskeyProtect';
import { Steps } from '../Steps';
import { explain, Notice, useNow, useRun } from '../ui';
import { getCtx } from './ctx';
import { dealInfo } from './model';
import { PayReal } from './PayReal';
import { StatusReal } from './StatusReal';

type Loaded = { d: LoadedDeal | null; error: unknown };

function useDeal(token: string) {
  const ctx = getCtx();
  const [st, setSt] = useState<Loaded>({ d: null, error: null });
  const cur = useRef<LoadedDeal | null>(null);
  const set = useCallback((d: LoadedDeal) => {
    cur.current = d;
    setSt({ d, error: null });
  }, []);

  useEffect(() => {
    let alive = true;
    cur.current = null;
    setSt({ d: null, error: null });
    const load = () =>
      loadDeal(ctx, token)
        .then((d) => alive && set(d))
        .catch((error) => alive && !cur.current && setSt({ d: null, error }));
    void load();
    // The chain is re-read every 8 s while the page is visible, and at once when it becomes visible again.
    const refresh = () => {
      if (document.hidden) return;
      if (!cur.current) return void load();
      const before = cur.current;
      refreshDeal(ctx, before)
        .then((d) => {
          if (alive && cur.current === before) set(d);
        })
        .catch(() => {});
    };
    const t = window.setInterval(refresh, 8000);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      alive = false;
      window.clearInterval(t);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [ctx, token, set]);

  /** After an action: wait until the chain shows the change, then redraw. */
  const settle = useCallback(
    async (changed: (d: LoadedDeal) => boolean) => {
      const d = await waitChain(ctx, cur.current!, changed, 25, 1000);
      set(d);
      return d;
    },
    [ctx, set],
  );

  return { ...st, set, settle };
}

function problemPage(error: unknown) {
  const t = tr().notice;
  if (error instanceof DealError && error.code === 'not_found') {
    return <Notice title={t.unknownLink} lines={[t.unknownLinkLine]} />;
  }
  if (error instanceof DealError && error.code === 'tampered') {
    return <Notice tone="warn" title={t.tampered} lines={[t.tamperedLine1, t.tamperedLine2]} />;
  }
  if (error instanceof DealError && error.code === 'wrong_key') {
    return <Notice tone="warn" title={t.wrongKey} lines={[t.wrongKeyLine]} />;
  }
  if (error instanceof ApiError || error instanceof ChainError) {
    return <Notice title={t.cantOpen} lines={[explain(error), t.cantOpenSafe]} />;
  }
  return <Notice title={t.cantOpen} lines={[t.cantOpenReload]} />;
}

/** A deal protected with the passkey asks for Face ID first (or the key file link, `/k#k1…`). */
export function DealRoute({ token }: { token: string }) {
  const [, unlocked] = useState(0);
  const own = getCtx().store.get(sha256Hex(token));
  if (own && isLocked(own)) return <UnlockScreen own={own} onUnlocked={() => unlocked((n) => n + 1)} />;
  return <OpenDeal token={token} />;
}

function OpenDeal({ token }: { token: string }) {
  const ctx = getCtx();
  const { d, error, set, settle } = useDeal(token);
  // The client's unpaid deal: the pay step by default; the deal page when money that didn't fund the deal
  // is waiting there, or when the person asked for it.
  const [view, setView] = useState<'auto' | 'pay' | 'deal'>('auto');
  const stepping = useRun();
  const now = useNow(15_000, ctx.now);
  const tt = useT();
  const t = tt.notice;

  const title = !d
    ? tt.titles.deal
    : d.role === 'visitor'
      ? tt.titles.deal
      : d.local && !d.local.saved
        ? tt.titles.saveKey
        : d.role === 'client' && d.deal?.state === 'Created' && view !== 'deal'
          ? tt.titles.pay
          : tt.titles.yourDeal;
  // A page that is only a message (error, used, cancelled, expired) is titled by its Notice.
  const onlyNotice =
    Boolean(error) ||
    (d !== null && (d.role === 'stranger' || (!d.deal && d.role !== 'creator' && (d.revoked || now > d.offerExpiresMs))));
  useEffect(() => {
    if (!onlyNotice) document.title = title;
  }, [title, onlyNotice]);

  if (error) return problemPage(error);
  if (!d) {
    return (
      <main className="keylink" aria-busy="true">
        <p className="lead" role="status">
          {t.opening}
        </p>
      </main>
    );
  }

  const info = dealInfo(d);
  const expired = !d.deal && now > d.offerExpiresMs;
  const origin = window.location.origin;

  // Someone else's deal: this link was already used.
  if (d.role === 'stranger') {
    return (
      <Notice tone="warn" title={t.used} lines={[t.usedLine1, t.usedLine2]} />
    );
  }

  if (!d.deal && d.role !== 'creator') {
    if (d.revoked) return <Notice title={t.revoked} lines={[t.revokedLine]} />;
    if (expired) {
      return <Notice title={t.expired} lines={[t.expiredLine(fmtDate(new Date(d.offerExpiresMs)))]} />;
    }
  }

  if (d.role === 'visitor') {
    return <DealPage info={info} linkExpires={new Date(d.offerExpiresMs)} onAccept={() => set(prepareClientKey(ctx, d))} />;
  }

  const local = d.local!;
  const link = personalLink(origin, local);
  const tag = d.handle.slice(0, 6);

  if (d.role === 'client') {
    // The key exists but is not the deal's key yet: save it, then join.
    if (!d.deal) {
      return (
        <>
          <Steps current={1} />
          <main className="deal">
            <KeyStep
              link={link}
              title={info.title}
              who={tt.key.whoWithCode(info.creatorCode)}
              tag={tag}
              alreadySaved={local.saved}
              own={local}
              onProtected={() => set({ ...d, local: ctx.store.get(d.handle) })}
              busy={stepping.busy}
              error={stepping.error}
              onDone={() => stepping.run(async () => set(await joinDeal(ctx, markKeySaved(ctx, d))))}
            />
            <DealSummary info={info} payBy={null} paid={false} />
          </main>
        </>
      );
    }
    const unpaid = d.deal.state === 'Created';
    const leftover = ownPayout(d).payout > 0n;
    const over = timerOver(d.deal, now) !== null;
    // "Money is in the safe" stays on screen after the payment lands, until "Open my deal".
    const wantPay = view === 'pay' || (view === 'auto' && !leftover);
    if (!d.deal.purged && (unpaid ? wantPay && !over : view !== 'deal' && d.deal.state === 'Funded' && wasPaying.has(d.handle))) {
      if (unpaid) wasPaying.add(d.handle);
      return (
        <>
          <Steps current={unpaid ? 2 : 3} />
          <main className="deal">
            <PayReal d={d} info={info} onOpenDeal={() => setView('deal')} />
            <DealSummary
              info={info}
              payBy={new Date(Number(BigInt(d.deal.pay_by_ns) / 1_000_000n))}
              paid={!unpaid}
              deliverBy={d.deal.delivery_deadline_ns ? new Date(Number(BigInt(d.deal.delivery_deadline_ns) / 1_000_000n)) : null}
            />
          </main>
        </>
      );
    }
    return <StatusReal d={d} info={info} settle={settle} onPay={() => setView('pay')} />;
  }

  // The creator.
  if (!local.saved) {
    return (
      <>
        <Steps current={1} flow="create" />
        <main className="deal">
          <KeyStep
            role="creator"
            link={link}
            title={info.title}
            who={tt.key.whoCreator}
            tag={tag}
            next={tt.create.nextGetLink}
            own={local}
            onProtected={() => set({ ...d, local: ctx.store.get(d.handle) })}
            onDone={() => set(markKeySaved(ctx, d))}
          />
          <ClientSees info={info} />
        </main>
      </>
    );
  }
  if (!d.deal) {
    return (
      <>
        <Steps current={2} flow="create" />
        <main className="deal">
          <Share
            link={clientLink(origin, d.token)}
            expires={new Date(d.offerExpiresMs)}
            code={info.creatorCode}
            cancelled={d.revoked}
            own={local}
            onCancel={async () => {
              try {
                await revokeLink(ctx, d);
              } catch (e) {
                // The client accepted in the meantime: show the deal instead.
                if (!(e instanceof ApiError && e.code === 'already_joined')) throw e;
              }
              set(await refreshDeal(ctx, { ...d, revoked: true }).then((x) => (x.deal ? { ...x, revoked: false } : x)));
            }}
          />
          <ClientSees info={info} />
        </main>
      </>
    );
  }
  return <StatusReal d={d} info={info} settle={settle} onPay={() => {}} />;
}

/** The creator's right column: the sealed terms as the client will see them. */
function ClientSees({ info }: { info: DealInfo }) {
  const tt = useT();
  const t = tt.create;
  return (
    <aside className="summary summary-after" aria-label={t.clientSeesLabel}>
      <p className="from">{t.clientSees}</p>
      <p className="summary-title">{info.title}</p>
      <p className="price">
        <span className="amount amount-sm">{usd(info.amount)}</span>
        <span className="currency">USDC</span>
      </p>
      <dl className="summary-facts">
        <div>
          <dt>{t.delivery}</dt>
          <dd>{tt.units.afterPayment(info.deliveryMs)}</dd>
        </div>
        <div>
          <dt>{t.review}</dt>
          <dd>{tt.units.span(info.reviewMs)}</dd>
        </div>
        <div>
          <dt>{t.revisionsShort}</dt>
          <dd>{info.revisions ?? '—'}</dd>
        </div>
      </dl>
    </aside>
  );
}

/** Deals this tab showed the payment step for (so the "money is in the safe" screen can follow). */
const wasPaying = new Set<string>();

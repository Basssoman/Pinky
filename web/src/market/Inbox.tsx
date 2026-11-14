// `/inbox`: the creator's requests. Reading needs a
// profile-key signature: the client's contact is for this creator only
// (and, honestly, the server operator). "Make a deal from it" opens the
// usual create-deal form, prefilled; "Decline" tells the client.
//
// Request life: "New" → "Seen" (once the inbox was opened) →
// "In talks" (the creator marks it) → a deal, or "Declined" with an optional
// reason. Unanswered requests close after 7 days. A key change by support in
// progress shows on top, with "Cancel" for the current key.
//
// Brief lines the client's AI helper wrote (and the client kept) are marked,
// so the creator checks them with the client before making the deal. One
// live deal per request: a new deal only after the last link was cancelled.
import { useState } from 'react';
import { useT } from '../i18n';
import { NET } from '../lib/config';
import {
  LIMITS,
  profileIdOfKey,
  signDecline,
  signDiscuss,
  signInbox,
  signKeyResetCancel,
  type InboxItem,
  type KeyChange,
  type ProfileKey,
  type RequestStatus,
} from '../lib/market';
import { navigate } from '../real/ctx';
import { CopyButton, Notice, useConfirm, useRun } from '../ui';
import { market, useMarket, useProfileKey, useTitle } from './ctx';
import { dayName, Go, Identicon, LoadState, MarketProblem } from './parts';
import { ReportLink } from './Report';

/** What the create-deal form takes from the request (kept for this tab only). */
export interface RequestPrefill {
  handle: string;
  serviceTitle: string | null;
  brief: string;
  wantedDeadline: string | null;
  priceFrom: number | null;
  deliveryDays: number | null;
  clientBoxPk: string | null;
}

export const PREFILL_KEY = 'kept.dealFromRequest';

export function InboxPage() {
  const tt = useT();
  const key = useProfileKey();
  useTitle(tt.market.titles.inbox);
  if (!key || !key.saved) {
    const t = tt.market.inbox;
    return (
      <Notice title={t.noKeyTitle} lines={[t.noKeyLine]}>
        <div className="actions">
          <Go to="/profile" className="cta cta-inline" onGo={navigate}>
            {t.toEditor}
          </Go>
        </div>
      </Notice>
    );
  }
  return <Inbox k={key} />;
}

function Inbox({ k }: { k: ProfileKey }) {
  const tt = useT();
  const t = tt.market.inbox;
  const id = profileIdOfKey(k);
  const inbox = useMarket((api) => api.inbox(id, { profile_pk: k.pk, ...signInbox(NET.contractId, k, Date.now()) }), [id]);
  // prices and days of the services, to prefill the deal
  const profile = useMarket((api) => api.profile(id).catch(() => null), [id]);
  const items = inbox.data?.items ?? [];

  const makeDeal = (r: InboxItem) => {
    const now = profile.data?.services.find((s) => s.id === r.service?.id) ?? null;
    const prefill: RequestPrefill = {
      handle: r.handle,
      serviceTitle: r.service?.title ?? null,
      brief: r.brief,
      wantedDeadline: r.wanted_deadline,
      priceFrom: r.service?.price_from_usdc ?? now?.price_from_usdc ?? null,
      deliveryDays: r.service?.delivery_days ?? now?.delivery_days ?? null,
      clientBoxPk: r.client_box_pk ?? null,
    };
    try {
      sessionStorage.setItem(PREFILL_KEY, JSON.stringify(prefill));
    } catch {
      /* the form opens empty */
    }
    navigate(`/new?request=${r.handle}`);
  };

  return (
    <main className="mk">
      <div className="mk-narrow">
        <section className="terms screen" aria-labelledby="inbox-title">
          <div className="mk-title-row">
            <h1 id="inbox-title">{t.title}</h1>
            <button className="btn-ghost btn-sm" type="button" disabled={inbox.loading} onClick={inbox.reload}>
              {t.refresh}
            </button>
          </div>
          <p className="lead">{t.lead}</p>
          <p className="hint mk-note">{t.outside}</p>
          {inbox.data?.key_change && <KeyChangeBanner change={inbox.data.key_change} k={k} onDone={inbox.reload} />}

          <LoadState kind="list" loading={inbox.loading && !inbox.data} error={inbox.error} onRetry={inbox.reload} />
          {inbox.data && items.length === 0 && <p className="mk-empty">{t.none}</p>}

          <ul className={inbox.loading && inbox.data ? 'mk-inbox mk-busy' : 'mk-inbox'} aria-busy={inbox.loading}>
            {items.map((r) => (
              <li key={r.handle}>
                <RequestCard r={r} k={k} onDeal={() => makeDeal(r)} onChanged={inbox.reload} />
              </li>
            ))}
          </ul>
        </section>
        <p className="hint mk-inbox-who">
          <Identicon id={id} size="sm" />
          <Go to={`/creators/${id}`} className="nick" onGo={navigate}>
            {tt.market.catalog.yourProfile}
          </Go>
        </p>
      </div>
    </main>
  );
}

/** Requests the creator can still answer. */
const ANSWERABLE: RequestStatus[] = ['open', 'viewed', 'discussing'];

/** Support is changing this profile's key; the current key can stop it with one signature. */
function KeyChangeBanner({ change, k, onDone }: { change: KeyChange; k: ProfileKey; onDone: () => void }) {
  const tt = useT();
  const tl = tt.market.life;
  const cancelling = useRun();
  const asking = useConfirm();
  const [done, setDone] = useState(false);
  const cancel = async () => {
    const api = await market();
    await api.cancelKeyReset(profileIdOfKey(k), { profile_pk: k.pk, reset_id: change.reset_id, ...signKeyResetCancel(NET.contractId, k, change.reset_id, Date.now()) });
    setDone(true);
    onDone();
  };
  if (done) return <p className="hint mk-note">{tl.resetCancelled}</p>;
  return (
    <div className="alert" role="alert">
      <p>
        <strong>{tl.resetTitle}</strong>
      </p>
      <p>{tl.resetLine(dayName(change.effective_at))}</p>
      {/* Proved through an account confirmed on this profile: only support can stop it. */}
      {change.cancellable === false && <p>{tt.market.resets.noCancel}</p>}
      <MarketProblem error={cancelling.error} />
      {change.cancellable !== false && <div className="actions">
        <button className="cta cta-inline" type="button" disabled={cancelling.busy} onClick={async () => (await asking.confirm(tl.resetConfirm, tl.resetCancel)) && cancelling.run(cancel)}>
          {cancelling.busy ? tl.resetCancelling : tl.resetCancel}
        </button>
        {asking.box}
      </div>}
    </div>
  );
}

function RequestCard({ r, k, onDeal, onChanged }: { r: InboxItem; k: ProfileKey; onDeal: () => void; onChanged: () => void }) {
  const tt = useT();
  const t = tt.market.inbox;
  const tl = tt.market.life;
  const declining = useRun();
  const discussing = useRun();
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  const open = ANSWERABLE.includes(r.status);
  const decline = async () => {
    const api = await market();
    await api.decline(r.handle, { profile_pk: k.pk, ...signDecline(NET.contractId, k, r.handle, Date.now(), reason) });
    setAsking(false);
    onChanged();
  };
  const discuss = async () => {
    const api = await market();
    await api.discuss(r.handle, { profile_pk: k.pk, ...signDiscuss(NET.contractId, k, r.handle, Date.now()) });
    onChanged();
  };
  return (
    <article className={open ? 'panel mk-req mk-req-open' : 'panel mk-req'}>
      <div className="mk-req-head">
        <span className={`mk-status mk-status-${r.status}`}>{t.status[r.status]}</span>
        <span className="mk-dim">
          {t.received} {dayName(r.created_at)}
        </span>
        <ReportLink kind="request" id={r.handle} className="mk-report-head" />
      </div>
      <p className="panel-title">{r.service?.title ?? t.general}</p>
      <BriefLines brief={r.brief} ai={r.ai_lines} />
      <dl className="mk-req-facts">
        {r.wanted_deadline && (
          <div>
            <dt>{t.wanted}</dt>
            <dd>{dayName(r.wanted_deadline)}</dd>
          </div>
        )}
        <div>
          <dt>{t.contact}</dt>
          <dd className="mk-req-contact">
            <span>
              {tt.market.contactKinds[r.client_contact.kind] ?? r.client_contact.kind}: <strong>{r.client_contact.value}</strong>
            </span>
            <CopyButton text={r.client_contact.value} />
          </dd>
        </div>
        {r.status === 'declined' && r.decline_reason && (
          <div>
            <dt>{tl.yourReason}</dt>
            <dd className="mk-pre">{r.decline_reason}</dd>
          </div>
        )}
      </dl>
      {r.closes_at && (r.status === 'open' || r.status === 'viewed') && <p className="hint">{tl.closesOnInbox(dayName(r.closes_at))}</p>}
      {r.status === 'deal_ready' && <p className="hint">{t.oneDeal}</p>}
      {open && !asking && (
        <>
          <MarketProblem error={discussing.error} />
          <div className="actions">
            <button className="cta cta-inline" type="button" onClick={onDeal}>
              {t.makeDeal}
            </button>
            {r.status !== 'discussing' && (
              <button className="btn-ghost" type="button" disabled={discussing.busy} onClick={() => discussing.run(discuss)}>
                {discussing.busy ? tl.discussing : tl.discuss}
              </button>
            )}
            <button className="btn-link btn-inline" type="button" onClick={() => setAsking(true)}>
              {t.decline}
            </button>
          </div>
        </>
      )}
      {open && asking && (
        // "No", with an optional reason the client sees.
        <div className="pay-form">
          <p className="hint">{t.declineConfirm}</p>
          <label className="field">
            <span className="field-label">{tl.reasonLabel}</span>
            <textarea value={reason} maxLength={LIMITS.declineReason} rows={2} onChange={(e) => setReason(e.target.value)} />
            <span className="hint">{tl.reasonHint}</span>
          </label>
          <MarketProblem error={declining.error} />
          <div className="actions">
            <button className="cta cta-inline" type="button" disabled={declining.busy} onClick={() => declining.run(decline)}>
              {declining.busy ? t.declining : tl.declineSend}
            </button>
            <button className="btn-ghost" type="button" disabled={declining.busy} onClick={() => setAsking(false)}>
              {tl.back}
            </button>
          </div>
        </div>
      )}
    </article>
  );
}

/** The brief, with the lines the AI helper wrote marked (when the client's browser sent them). */
function BriefLines({ brief, ai }: { brief: string; ai?: number[] }) {
  const t = useT().market.inbox;
  const marked = new Set(ai ?? []);
  if (marked.size === 0) return <p className="mk-pre mk-req-brief">{brief}</p>;
  return (
    <>
      <ul className="mk-brief-lines mk-req-brief">
        {brief.split('\n').map((line, i) =>
          marked.has(i) ? (
            <li key={i} className="mk-ai-line">
              <span className="mk-ai-mark" aria-hidden="true">
                ✦{' '}
              </span>
              <span className="sr-only">{t.aiLine}: </span>
              {line}
            </li>
          ) : (
            <li key={i}>{line}</li>
          ),
        )}
      </ul>
      <p className="hint">{t.aiLegend}</p>
    </>
  );
}

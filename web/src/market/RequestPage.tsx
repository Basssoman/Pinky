// `/r#<token>`: the client's request page .
// Status, the request itself, "Cancel" while no deal was made from it,
// and "Open the deal" once the creator made one. The deal link arrives
// encrypted to a key only this link can make.
//
// Before "Open the deal" this browser checks the creator's profile-key
// signature over (this request, the deal's key), against the key it pinned
// when the request was sent. A changed key or a bad
// signature: a big warning and no way to the deal from here.
import { useEffect, useMemo, useState } from 'react';
import { useT } from '../i18n';
import { ApiError } from '../lib/api';
import { NET } from '../lib/config';
import { sha256Hex } from '../lib/keys';
import {
  checkRequest,
  dealTokenFrom,
  keyFingerprint,
  localRequest,
  parseRequestPin,
  rememberCheckedCreator,
  requestLink,
  type RequestStatus,
  type RequestView,
} from '../lib/market';
import { navigate } from '../real/ctx';
import { CopyButton, Notice, useConfirm, useRun } from '../ui';
import { market, useTitle } from './ctx';
import { Avatar, dayName, Go, LoadState, MarketProblem } from './parts';
import { ReportLink } from './Report';

export function RequestPage({ token }: { token: string }) {
  const tt = useT();
  const t = tt.market.request;
  const handle = sha256Hex(token);
  const [view, setView] = useState<RequestView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [dealToken, setDealToken] = useState<string | null | undefined>(undefined);
  const [tick, setTick] = useState(0);
  const cancelling = useRun();
  const asking = useConfirm();
  const [justSent] = useState(() => {
    try {
      const h = sessionStorage.getItem('kept.requestJustSent');
      if (h === handle) sessionStorage.removeItem('kept.requestJustSent');
      return h === handle;
    } catch {
      return false;
    }
  });
  // The key pinned when this browser sent the request, or its fingerprint from the link.
  const [pin] = useState(() => {
    const local = localRequest(handle);
    let fp = parseRequestPin(window.location.hash);
    if (!fp && local?.profilePk) {
      try {
        fp = keyFingerprint(local.profilePk);
      } catch {
        fp = null;
      }
    }
    return { pk: local?.profilePk ?? null, fp };
  });
  const check = useMemo(() => (view ? checkRequest(NET.contractId, handle, view, pin) : null), [view, handle, pin]);
  // The deal page shows the creator only for the deal key checked here.
  useEffect(() => {
    if (!view || !check || !dealToken || check.key === 'changed' || check.deal !== 'ok' || !check.creatorPk) return;
    rememberCheckedCreator(sha256Hex(dealToken), {
      profileId: view.profile.profile_id,
      // The nickname the pinned key signed; profiles not saved since this check existed: the one shown here.
      nickname: check.nickname ?? view.profile.nickname,
      creatorPk: check.creatorPk,
    });
  }, [view, check, dealToken]);
  const missing = !view && error instanceof ApiError && error.status === 404;
  useTitle(missing ? `${t.notFoundTitle} — Pinky` : tt.market.titles.request);

  useEffect(() => {
    let alive = true;
    const read = () =>
      market()
        .then((api) => api.request(handle, token))
        .then(async (v) => {
          if (!alive) return;
          setView(v);
          setError(null);
          if (v.status === 'deal_ready') {
            const d = await dealTokenFrom(token, handle, v);
            if (alive) setDealToken(d);
          }
        })
        .catch((e) => alive && setError(e));
    void read();
    // the status changes when the creator answers: look again every 20 s while the page is visible
    const id = window.setInterval(() => !document.hidden && void read(), 20_000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [handle, token, tick]);

  if (!view && error instanceof ApiError && error.status === 404) {
    return <Notice title={t.notFoundTitle} lines={[t.notFoundLine]} />;
  }
  if (!view) {
    return (
      <main className="mk">
        <LoadState loading={!error} error={error} onRetry={() => setTick((x) => x + 1)} />
      </main>
    );
  }

  const nick = check?.nickname ?? view.profile.nickname;
  const link = requestLink(window.location.origin, token, pin.fp);
  const waiting: RequestStatus[] = ['open', 'viewed', 'discussing'];
  const keyChanged = check?.key === 'changed';
  const badDeal = view.status === 'deal_ready' && check?.deal === 'bad';
  const blocked = keyChanged || badDeal;
  const tone = blocked ? 'hero-warn' : view.status === 'deal_ready' ? 'hero-safe' : waiting.includes(view.status) ? 'hero-wait' : 'hero-warn';
  const tl = tt.market.life;
  const change = view.profile.recent_change;

  const cancel = async () => {
    const api = await market();
    await api.cancelRequest(handle, token);
    setTick((x) => x + 1);
  };

  return (
    <main className="mk">
      <div className="mk-narrow">
        <section className="terms screen" aria-labelledby="req-title">
          <h1 id="req-title">{keyChanged ? tl.keyChangedTitle : badDeal ? tl.badProofTitle : t.titles[view.status]}</h1>

          {/* A changed key or a bad signature: only the warning below, never "open it and pay". */}
          {!blocked && (
            <div className={`hero ${tone}`} role="status">
              <span className="hero-mark" aria-hidden="true" />
              <div>
                <p className="hero-line">{t.lines[view.status](nick)}</p>
                {view.closes_at && waiting.includes(view.status) && <p className="hint">{tl.closesOn(dayName(view.closes_at))}</p>}
              </div>
            </div>
          )}

          {blocked && (
            <div className="alert" role="alert">
              <p>
                <strong>{keyChanged ? tl.keyChangedLine : tl.badProofLine}</strong>
              </p>
            </div>
          )}
          {(view.profile.key_changing || change) && (
            <p className="hint mk-note">
              {view.profile.key_changing && tl.keyChanging} {change && tl.changed(change.what, change.days_ago)}
            </p>
          )}

          {view.status === 'deal_ready' && !blocked && (
            <div className="actions">
              {dealToken ? (
                <>
                  <p className="hint">{tl.checked(nick)}</p>
                  <button className="cta cta-inline" type="button" onClick={() => navigate(`/d#${dealToken}`)}>
                    {t.openDeal}
                  </button>
                </>
              ) : (
                dealToken === null && <p className="hint">{t.noDealLink}</p>
              )}
            </div>
          )}

          <div className={justSent ? 'panel mk-keep mk-keep-new' : 'panel mk-keep'}>
            <p className="panel-title">{t.keep}</p>
            <div className="address">
              <code>{link}</code>
              <CopyButton text={link} />
            </div>
            <p className="hint">{t.keepLine}</p>
          </div>

          <dl className="facts">
            <div>
              <dt>{t.creator}</dt>
              <dd>
                <Go to={`/creators/${view.profile.profile_id}`} className="mk-inline-who" onGo={navigate}>
                  <Avatar id={view.profile.profile_id} avatar={view.profile.avatar} size="sm" />
                  {nick}
                </Go>
              </dd>
            </div>
            <div>
              <dt>{t.service}</dt>
              <dd>{view.service?.title ?? t.general}</dd>
            </div>
            <div>
              <dt>{t.brief}</dt>
              <dd className="mk-pre">{view.brief}</dd>
            </div>
            {view.wanted_deadline && (
              <div>
                <dt>{t.wanted}</dt>
                <dd>{dayName(view.wanted_deadline)}</dd>
              </div>
            )}
            {view.status === 'declined' && view.decline_reason && (
              <div>
                <dt>{tl.reason}</dt>
                <dd className="mk-pre">{view.decline_reason}</dd>
              </div>
            )}
          </dl>

          <MarketProblem error={cancelling.error} />
          <div className="actions">
            {waiting.includes(view.status) && (
              <button className="btn-link btn-inline" type="button" disabled={cancelling.busy} onClick={async () => (await asking.confirm(t.cancelConfirm, t.cancel)) && cancelling.run(cancel)}>
                {cancelling.busy ? t.cancelling : t.cancel}
              </button>
            )}
            {asking.box}
            {view.status !== 'deal_ready' && (
              <Go to="/creators" className="btn-ghost" onGo={navigate}>
                {t.other}
              </Go>
            )}
          </div>
          <p className="mk-report-row">
            <ReportLink kind="profile" id={view.profile.profile_id} label={tt.market.report.creator} />
          </p>
        </section>
      </div>
    </main>
  );
}

export function BadRequestLink() {
  const t = useT().market.request;
  return <Notice title={t.badLinkTitle} lines={[t.badLinkLine]} />;
}

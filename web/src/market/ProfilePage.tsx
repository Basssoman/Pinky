// `/creators/:id`: a creator's public page: about,
// work links, services with "Order", the optional public contact,
// reviews (month only, no amounts, for privacy).
import { useState } from 'react';
import { useT } from '../i18n';
import { isKnownLink, LIMITS, profileIdOfKey, signReply, type Profile, type ProfileKey, type PublicReview, type Service } from '../lib/market';
import { getCtx, navigate } from '../real/ctx';
import { Notice, useRun } from '../ui';
import { market, useMarket, useProfileKey, useTitle } from './ctx';
import { Avatar, ContactBlock, Go, LoadState, MarketProblem, monthName, OutcomeLabel, PortfolioLink, Rating, Tags } from './parts';
import { ReportLink } from './Report';
import { ConfirmedAccounts } from './Accounts';
import { ApiError } from '../lib/api';

export function ProfilePage({ id }: { id: string }) {
  const tt = useT();
  const t = tt.market.profile;
  const { data, loading, error, reload } = useMarket((api) => api.profile(id), [id]);
  useTitle(data ? tt.market.titles.profile(data.nickname) : tt.market.titles.catalog);

  if (error instanceof ApiError && error.status === 404) {
    return (
      <Notice title={t.notFoundTitle} lines={[t.notFoundLine]}>
        <div className="actions">
          <Go to="/creators" className="btn-ghost" onGo={navigate}>
            {t.back}
          </Go>
        </div>
      </Notice>
    );
  }
  if (!data) {
    return (
      <main className="mk">
        <BackLink />
        <LoadState loading={loading} error={error} onRetry={reload} />
      </main>
    );
  }
  return <ProfileView p={data} />;
}

function BackLink() {
  const t = useT().market.profile;
  return (
    <Go to="/creators" className="mk-back" onGo={navigate}>
      <span aria-hidden="true">←</span> {t.back}
    </Go>
  );
}

function ProfileView({ p }: { p: Profile }) {
  const tt = useT();
  const t = tt.market.profile;
  const key = useProfileKey();
  const own = key !== null && profileIdOfKey(key) === p.profile_id;
  const order = (s?: Service) => navigate(`/creators/${p.profile_id}/order${s?.id ? `?service=${s.id}` : ''}`);

  return (
    <main className="mk">
      <BackLink />
      <div className="deal mk-profile">
        <section className="mk-profile-main" aria-labelledby="profile-title">
          <div className="mk-who">
            <Avatar id={p.profile_id} avatar={p.avatar} size="lg" />
            <div>
              <h1 id="profile-title">{p.nickname}</h1>
              <Tags categories={p.categories} />
            </div>
          </div>

          {/* A recent change of the key or contact, a key change by support in progress. */}
          {(p.key_changing || p.recent_change) && (
            <p className="hint mk-note" role="note">
              {p.key_changing && tt.market.life.keyChanging} {p.recent_change && tt.market.life.changed(p.recent_change.what, p.recent_change.days_ago)}
            </p>
          )}

          {own && (
            <div className="mk-own" role="status">
              <span>{t.yours}</span>
              <Go to="/profile" className="btn-ghost btn-sm" onGo={navigate}>
                {t.edit}
              </Go>
            </div>
          )}

          {p.bio && (
            <div className="mk-block">
              <h2>{t.about}</h2>
              <p className="mk-bio">{p.bio}</p>
            </div>
          )}

          {/* Accounts whose bio has this profile's code. */}
          <ConfirmedAccounts accounts={p.accounts} />

          {p.portfolio.length > 0 && (
            <div className="mk-block">
              <h2>{t.work}</h2>
              <ul className="mk-links">
                {p.portfolio.map((l, i) => (
                  <li key={l}>
                    <PortfolioLink link={l} known={p.portfolio_known?.[i]} />
                  </li>
                ))}
              </ul>
              {/* Only YouTube, Behance, X and Google Drive links open; others are text with their domain. */}
              {p.portfolio.some((l, i) => p.portfolio_known?.[i] === false || !isKnownLink(l)) && <p className="hint mk-dim">{t.linkText}</p>}
            </div>
          )}

          <div className="mk-block">
            <h2>{t.services}</h2>
            {p.services.length === 0 && <p className="hint">{t.noServices}</p>}
            <ul className="mk-services">
              {p.services.map((s) => (
                <li key={s.id ?? s.title} className="panel mk-service">
                  <div className="mk-service-text">
                    <p className="panel-title">{s.title}</p>
                    {s.description && <p className="mk-service-desc">{s.description}</p>}
                    <p className="mk-service-facts">
                      <strong>{tt.market.from(s.price_from_usdc)}</strong>
                      <span className="mk-dim"> · {tt.market.usually(s.delivery_days)}</span>
                    </p>
                  </div>
                  {!own && (
                    <button className="cta cta-inline" type="button" onClick={() => order(s)}>
                      {t.order}
                    </button>
                  )}
                </li>
              ))}
            </ul>
            {!own && (
              <div className="mk-general">
                <p className="hint">{t.generalLine}</p>
                <button className="btn-ghost" type="button" onClick={() => order()}>
                  {t.general}
                </button>
              </div>
            )}
          </div>

          <div className="mk-block">
            <h2>{t.reviews}</h2>
            <p className="hint">
              {t.reviewsLine} {tt.market.rules.windowLine}
            </p>
            {p.reviews.length === 0 ? (
              <p className="mk-empty mk-empty-sm">{t.noReviews}</p>
            ) : (
              <ul className="mk-reviews">
                {p.reviews.map((r, i) => (
                  <ReviewItem key={r.review_id ?? i} r={r} profileId={p.profile_id} ownerKey={own ? key : null} />
                ))}
              </ul>
            )}
          </div>
        </section>

        <aside className="summary summary-after mk-aside" aria-label={p.nickname}>
          <Rating avg={p.rating_avg} count={p.reviews_count} deals={p.finished_deals} />
          {p.services.length > 0 && (
            <p className="price mk-price">
              <span className="mk-from-word">{tt.market.fromWord}</span>
              <span className="amount amount-sm">{Math.min(...p.services.map((s) => s.price_from_usdc))}</span>
              <span className="currency">USDC</span>
            </p>
          )}

          <ContactBlock contacts={p.contacts} />

          {!own && (
            <button className="cta" type="button" onClick={() => order(p.services.length === 1 ? p.services[0] : undefined)}>
              {t.general}
            </button>
          )}
          {p.since_month && <p className="hint mk-dim">{tt.market.rules.since(monthName(p.since_month))}</p>}
          <p className="hint mk-dim">{t.updated(monthName(p.updated_month))}</p>
          {!own && <ReportLink kind="profile" id={p.profile_id} label={tt.market.report.creator} className="mk-report-aside" />}
        </aside>
      </div>
    </main>
  );
}

/** One review: stars, words, month, the outcome label and the creator's one answer. */
function ReviewItem({ r, profileId, ownerKey }: { r: PublicReview; profileId: string; ownerKey: ProfileKey | null }) {
  const tt = useT();
  const t = tt.market.rules;
  const [reply, setReply] = useState(r.reply ?? null);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const sending = useRun();

  const post = async () => {
    const body = signReply(getCtx().net.contractId, ownerKey!, r.review_id!, text, Date.now());
    const api = await market();
    const res = await api.replyReview(profileId, r.review_id!, body);
    setReply(res.review?.reply ?? { text: body.text, month: new Date().toISOString().slice(0, 7) });
    setOpen(false);
  };

  return (
    <li className="mk-review">
      <p className="mk-review-stars" aria-label={tt.market.review.stars(r.rating)}>
        <span aria-hidden="true">
          {'★'.repeat(r.rating)}
          <span className="mk-star-off">{'★'.repeat(5 - r.rating)}</span>
        </span>
      </p>
      {r.text && <p className="mk-review-text">{r.text}</p>}
      <p className="mk-dim mk-review-month">
        <OutcomeLabel r={r} /> {monthName(r.month)}
        {r.review_id && <ReportLink kind="review" id={r.review_id} />}
      </p>
      {reply && (
        <div className="mk-reply">
          <p className="mk-reply-who">{t.creatorAnswer}</p>
          <p className="mk-review-text">{reply.text}</p>
          {r.review_id && !ownerKey && (
            <p className="mk-dim mk-review-month">
              <ReportLink kind="reply" id={r.review_id} />
            </p>
          )}
        </div>
      )}
      {!reply && ownerKey && r.review_id && !open && (
        <div className="actions">
          <button className="btn-ghost btn-sm" type="button" onClick={() => setOpen(true)}>
            {t.reply}
          </button>
        </div>
      )}
      {!reply && ownerKey && r.review_id && open && (
        <form
          className="mk-reply-form"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) void sending.run(post);
          }}
        >
          <label className="field">
            <span className="field-label">{t.replyLabel}</span>
            <textarea rows={3} value={text} maxLength={LIMITS.reply} onChange={(e) => setText(e.target.value)} placeholder={t.replyPlaceholder} />
          </label>
          <p className="hint">{t.replyHint}</p>
          <MarketProblem error={sending.error} />
          <div className="actions">
            <button className="cta cta-inline" type="submit" disabled={sending.busy || !text.trim()}>
              {sending.busy ? t.replySending : t.replySend}
            </button>
            <button className="btn-link btn-inline" type="button" onClick={() => setOpen(false)}>
              {t.replyCancel}
            </button>
          </div>
        </form>
      )}
    </li>
  );
}

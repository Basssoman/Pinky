// The review block on the deal page, client side ("Reviews that
// cannot be faked", client path 6). Shown only when the deal came from a
// request to a profile, was fully paid and is finished on-chain (any outcome). Signed with this browser's CLIENT deal key; the server checks the
// key against the contract. Posting again with the same key changes it.
// It can be written or changed for 3 days after the deal ended, then
// it is locked; it carries the outcome label; the creator may answer once.
import { useEffect, useState } from 'react';
import { locale, useT } from '../i18n';
import type { LoadedDeal } from '../lib/flows';
import { LIMITS, reviewable, signReview, signReviewOpen, type PublicReview, type ReviewLink } from '../lib/market';
import { getCtx, navigate } from '../real/ctx';
import { useRun } from '../ui';
import { market } from './ctx';
import { Go, MarketProblem, OutcomeLabel } from './parts';

export function ReviewBlock({ d }: { d: LoadedDeal }) {
  const [link, setLink] = useState<ReviewLink | null>(null);
  const ok = reviewable(d);
  const dealId = d.deal?.id ?? null;
  const key = d.key;
  useEffect(() => {
    if (!ok) return;
    let alive = true;
    (async () => {
      const api = await market();
      let l = await api.reviewLink(d.handle, d.token);
      // The deal ended by itself: this first open (signed by this browser's client key) starts the 3 days.
      if (l.starts_on_open && key && dealId !== null) {
        try {
          await api.openReview(d.handle, d.token, signReviewOpen(getCtx().net.contractId, key, dealId, Date.now()));
          l = await api.reviewLink(d.handle, d.token);
        } catch {
          /* the window then runs to its latest end; the review still works */
        }
      }
      if (alive) setLink(l);
    })().catch(() => {
      /* no block when the server does not answer */
    });
    return () => {
      alive = false;
    };
  }, [ok, d.handle, d.token, key, dealId]);

  // This browser's own chain read decides (`ok`). The server's `can_review` may lag a few minutes behind the chain
  // (it re-reads it now and then); its POST always re-reads the chain, so a stale "false" must not hide the block.
  // `locked` (the 3 days are over) is final and does hide the form.
  if (!ok || !link?.linked || !link.profile_id) return null;
  return <ReviewForm d={d} link={link} profileId={link.profile_id} />;
}

/** "14 Nov 2026, 18:05" in the chosen language. */
function when(iso: string): string {
  const t = new Date(iso);
  return Number.isNaN(t.getTime())
    ? iso
    : t.toLocaleString(locale(), { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function Stars({ n }: { n: number }) {
  const t = useT().market.review;
  return (
    <p className="mk-review-stars" aria-label={t.stars(n)}>
      <span aria-hidden="true">
        {'★'.repeat(n)}
        <span className="mk-star-off">{'★'.repeat(5 - n)}</span>
      </span>
    </p>
  );
}

function ReviewForm({ d, link, profileId }: { d: LoadedDeal; link: ReviewLink; profileId: string }) {
  const tt = useT();
  const t = tt.market.review;
  const r = tt.market.rules;
  const existing: PublicReview | null = link.review ?? null;
  const [mine, setMine] = useState(existing);
  const [locked, setLocked] = useState(!!link.locked);
  const [editing, setEditing] = useState(existing === null && !link.locked);
  const [stars, setStars] = useState(existing?.rating ?? 0);
  const [text, setText] = useState(existing?.text ?? '');
  const [posted, setPosted] = useState(false);
  const [tried, setTried] = useState(false);
  const sending = useRun();
  const nick = link.nickname || null;
  // The label the review gets (from the server's chain read).
  const label = {
    outcome: existing?.outcome ?? link.outcome ?? undefined,
    refunded: existing?.refunded ?? link.outcome === 'refunded',
  };

  const post = async () => {
    const body = signReview(getCtx().net.contractId, d.key!, d.deal!.id, profileId, stars, text, Date.now());
    const api = await market();
    try {
      await api.postReview(d.handle, d.token, body);
    } catch (e) {
      if ((e as { code?: string }).code === 'review_locked') {
        setLocked(true);
        setEditing(false);
      }
      throw e;
    }
    setMine({ ...(mine ?? { month: new Date().toISOString().slice(0, 7) }), rating: stars, text: body.text });
    setEditing(false);
    setPosted(true);
  };

  const profileLink = (
    <Go to={`/creators/${profileId}`} className="nick" onGo={navigate}>
      {t.toProfile}
    </Go>
  );

  if (!editing && !mine) {
    // The 3 days ended without a review.
    return (
      <div className="panel mk-review-block">
        <p className="panel-title">{t.title}</p>
        <p className="hint">{r.lockedNone}</p>
        <div className="actions">{profileLink}</div>
      </div>
    );
  }

  if (!editing && mine) {
    return (
      <div className="panel mk-review-block">
        <p className="panel-title">{t.yours}</p>
        <Stars n={mine.rating} />
        {mine.text && <p className="mk-review-text">{mine.text}</p>}
        {label.outcome && (
          <p className="mk-review-month">
            <OutcomeLabel r={label} />
          </p>
        )}
        {mine.reply && (
          <div className="mk-reply">
            <p className="mk-reply-who">{r.creatorAnswer}</p>
            <p className="mk-review-text">{mine.reply.text}</p>
          </div>
        )}
        {posted && (
          <p className="saved-note" role="status">
            <span aria-hidden="true">✓</span> {t.posted}
          </p>
        )}
        <MarketProblem error={sending.error} />
        {locked ? <p className="hint">{r.locked}</p> : link.review_until && <p className="hint">{r.until(when(link.review_until))}</p>}
        <div className="actions">
          {!locked && (
            <button className="btn-ghost btn-sm" type="button" onClick={() => setEditing(true)}>
              {t.change}
            </button>
          )}
          {profileLink}
        </div>
        <p className="hint">{tt.deal.nextTime}</p>
      </div>
    );
  }

  const labelText =
    label.outcome === 'dispute' && label.refunded
      ? `${r.outcome.dispute} · ${tt.market.profile.refunded}`
      : label.outcome
        ? r.outcome[label.outcome]
        : null;

  return (
    <form
      className="panel mk-review-block"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        setTried(true);
        if (stars >= 1) void sending.run(post);
      }}
    >
      <p className="panel-title">{t.title}</p>
      <p className="hint">{nick ? t.lead(nick) : t.leadNoNick}</p>
      {labelText && <p className="hint">{r.labelLine(labelText)}</p>}
      <div className="stars" role="radiogroup" aria-label={t.rating}>
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={stars === n}
            aria-label={t.stars(n)}
            className={n <= stars ? 'star star-on' : 'star'}
            onClick={() => setStars(n)}
          >
            ★
          </button>
        ))}
      </div>
      {tried && stars < 1 && <span className="field-error">{t.pickStars}</span>}
      <label className="field">
        <span className="field-label">{t.text}</span>
        <textarea rows={3} value={text} maxLength={LIMITS.review} onChange={(e) => setText(e.target.value)} placeholder={t.textPlaceholder} />
      </label>
      <p className="hint">{link.review_until ? r.until(when(link.review_until)) : r.windowLine}</p>
      <MarketProblem error={sending.error} />
      <div className="actions">
        <button className="cta cta-inline" type="submit" disabled={sending.busy}>
          {sending.busy ? t.sending : mine ? t.save : t.send}
        </button>
        {mine && (
          <button className="btn-link btn-inline" type="button" onClick={() => setEditing(false)}>
            {tt.market.editor.back}
          </button>
        )}
      </div>
      <p className="hint">{tt.deal.nextTime}</p>
    </form>
  );
}

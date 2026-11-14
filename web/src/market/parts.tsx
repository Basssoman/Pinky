// Small pieces the marketplace pages share: the pixel picture of a profile,
// rating, category tags, "from" price, plain error lines, links and contacts.
import { useEffect, useState, type ReactNode } from 'react';
import { locale, tr, useLang, useT } from '../i18n';
import { marketAvatarEn } from '../i18n/market.en';
import { marketAvatarUk } from '../i18n/market.uk';
import { ApiError } from '../lib/api';
import { identicon, isKnownLink, linkDomain, outcomeOf, type Category, type Contact, type PublicReview } from '../lib/market';
import { Bitmap } from '../pixel';
import { explain } from '../ui';
import { avatarUrl } from './ctx';

/** The pixel pattern of a profile, made from its id: the picture when no photo was uploaded. */
export function Identicon({ id, size = 'md' }: { id: string; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <span className={`ident ident-${size}`} aria-hidden="true">
      <Bitmap rows={identicon(id)} />
    </span>
  );
}

/**
 * The profile's picture: the uploaded photo, served by our own API,
 * or the pixel pattern when there is none (or it fails to load). `src` shows a
 * picture that is not saved yet (the editor's preview).
 */
export function Avatar({ id, avatar, size = 'md', src }: { id: string; avatar?: string | null; size?: 'sm' | 'md' | 'lg'; src?: string }) {
  const url = src ?? (avatar ? avatarUrl(id, avatar) : '');
  const [failed, setFailed] = useState<string | null>(null);
  if (!url || failed === url) return <Identicon id={id} size={size} />;
  return (
    <span className={`ident ident-${size} ident-photo`} aria-hidden="true">
      <img src={url} alt="" loading="lazy" decoding="async" draggable={false} referrerPolicy="no-referrer" onError={() => setFailed(url)} />
    </span>
  );
}

/** Texts of the picture control: Ukrainian, else English (the other languages have no own lines yet). */
export function useAvatarTexts(): typeof marketAvatarEn {
  return useLang().code === 'uk' ? marketAvatarUk : marketAvatarEn;
}

export function Tags({ categories }: { categories: Category[] }) {
  const t = useT().market.categories;
  return (
    <ul className="mk-tags">
      {categories.map((c) => (
        <li key={c}>{t[c] ?? c}</li>
      ))}
    </ul>
  );
}

/**
 * How the deal behind a review ended: "Paid" / "Money went back
 * to the client" / "Dispute". A dispute the creator lost (got nothing) also
 * says the money went back.
 */
export function OutcomeLabel({ r }: { r: Pick<PublicReview, 'outcome' | 'refunded'> }) {
  const tt = useT().market;
  const o = outcomeOf(r);
  const text = o === 'dispute' && r.refunded ? `${tt.rules.outcome.dispute} · ${tt.profile.refunded}` : tt.rules.outcome[o];
  return (
    <span className={`mk-outcome mk-outcome-${o}`} title={tt.rules.outcomeLabel}>
      {text}
    </span>
  );
}

/** "★ 4.8 · 9 reviews", or "New on Pinky". */
export function Rating({ avg, count, deals }: { avg: number | null; count: number; deals: number }) {
  const t = useT().market;
  const parts: ReactNode[] = [];
  if (avg !== null && count > 0) {
    const a = avg.toFixed(1);
    parts.push(
      <span key="r" className="mk-rating" aria-label={t.ratingLabel(a, count)}>
        <span className="mk-star" aria-hidden="true">
          ★
        </span>
        <span aria-hidden="true">
          {a} <span className="mk-dim">({count})</span>
        </span>
      </span>,
    );
  }
  if (deals > 0) parts.push(<span key="d">{t.dealsDone(deals)}</span>);
  if (parts.length === 0) parts.push(<span key="n" className="mk-new">{t.newHere}</span>);
  return <p className="mk-meta">{parts}</p>;
}

/** "2026-11" → "November 2026" in the chosen language. */
export function monthName(month: string): string {
  const d = new Date(`${month}-01T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? month : d.toLocaleDateString(locale(), { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** "2026-12-01" → a short date in the chosen language. */
export function dayName(iso: string): string {
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString(locale(), { day: 'numeric', month: 'short', year: 'numeric', ...(iso.length === 10 ? { timeZone: 'UTC' } : {}) });
}

/** One plain sentence for a failed marketplace call. */
export function marketError(e: unknown): string {
  const t = tr().market.errors;
  if (e instanceof ApiError) {
    if (e.status === 0 || e.status >= 500) return t.unreachable;
    if (e.status === 429 || e.code === 'rate_limited' || e.code === 'daily_cap') return t.rateLimited;
    if (['signature_expired', 'replayed_request', 'expiry_too_far', 'stale_review'].includes(e.code)) return t.tryAgain;
    if (['not_open', 'request_closed', 'deal_created', 'declined', 'cancelled'].includes(e.code)) return t.notOpen;
    if (e.code === 'not_finished') return t.notFinished;
    if (e.code === 'review_locked') return tr().market.rules.lockedNone;
    if (e.code === 'already_replied') return tr().market.rules.alreadyReplied;
    // Never the server's raw English: one translated line.
    if (e.status === 400 || e.status === 403 || e.status === 413 || e.status === 415 || e.status === 422) return t.refused;
  }
  return explain(e);
}

export function MarketProblem({ error }: { error: unknown }) {
  useT();
  if (!error) return null;
  return (
    <p className="alert alert-inline" role="alert">
      {marketError(error)}
    </p>
  );
}

/** True once `on` has stayed true for `ms` (a fast answer never shows a placeholder). */
export function useDelayed(on: boolean, ms = 300): boolean {
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (!on) {
      setLate(false);
      return;
    }
    const id = window.setTimeout(() => setLate(true), ms);
    return () => window.clearTimeout(id);
  }, [on, ms]);
  return on && late;
}

export type SkeletonKind = 'cards' | 'page' | 'list';

/** Grey shapes where the content will be; no "Loading…" text on screen (screen readers still hear it). */
export function Skeleton({ kind }: { kind: SkeletonKind }) {
  const t = useT().market;
  const blocks =
    kind === 'cards' ? (
      <ul className="mk-grid">
        {[0, 1, 2].map((i) => (
          <li key={i} className="mk-skel-card">
            <span className="mk-skel mk-skel-ident" />
            <span className="mk-skel-lines">
              <span className="mk-skel mk-skel-line" />
              <span className="mk-skel mk-skel-line mk-skel-short" />
            </span>
          </li>
        ))}
      </ul>
    ) : kind === 'list' ? (
      <div className="mk-skel-list">
        {[0, 1].map((i) => (
          <span key={i} className="mk-skel mk-skel-panel" />
        ))}
      </div>
    ) : (
      <div className="mk-skel-page">
        <span className="mk-skel mk-skel-title" />
        <span className="mk-skel mk-skel-line" />
        <span className="mk-skel mk-skel-line mk-skel-short" />
        <span className="mk-skel mk-skel-panel" />
      </div>
    );
  return (
    <div className="mk-skeleton" aria-busy="true">
      <span className="sr-only" role="status">
        {t.loading}
      </span>
      {blocks}
    </div>
  );
}

/** First load of a section: a skeleton only when it takes longer than 300 ms; a failure with "Try again". */
export function LoadState({ loading, error, onRetry, kind = 'page' }: { loading: boolean; error: unknown; onRetry: () => void; kind?: SkeletonKind }) {
  const t = useT().market;
  const slow = useDelayed(loading);
  if (loading) return slow ? <Skeleton kind={kind} /> : null;
  if (!error) return null;
  return (
    <div className="mk-failed" role="alert">
      <p className="hint">{error instanceof ApiError && error.status !== 0 && error.status < 500 ? marketError(error) : t.loadFailed}</p>
      <button className="btn-ghost btn-sm" type="button" onClick={onRetry}>
        {t.retry}
      </button>
    </div>
  );
}

/** A link inside the site, without a page reload. */
export function Go({ to, className, children, onGo }: { to: string; className?: string; children: ReactNode; onGo: (to: string) => void }) {
  return (
    <a
      href={to}
      className={className}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        onGo(to);
      }}
    >
      {children}
    </a>
  );
}

/** "youtube.com/@name/videos", cut to 48 characters ("www." dropped). */
export function shortLink(l: string): string {
  try {
    const u = new URL(l);
    const path = u.pathname === '/' ? '' : u.pathname;
    const s = `${u.hostname.replace(/^www\./, '')}${path}`;
    return s.length > 48 ? `${s.slice(0, 46)}…` : s;
  } catch {
    return l;
  }
}

/**
 * A link the site does not open: plain text, its domain in bold first, so a
 * look-alike address is easy to see. It can still be selected and copied.
 */
export function LinkAsText({ link }: { link: string }) {
  const domain = linkDomain(link);
  const short = shortLink(link);
  if (!domain || !short.startsWith(domain)) return <span className="mk-link-text">{link}</span>;
  return (
    <span className="mk-link-text" title={link}>
      <strong>{domain}</strong>
      {short.slice(domain.length)}
    </span>
  );
}

/** One portfolio link: clickable only for a known host (the server's mark, when it sent one, must agree). */
export function PortfolioLink({ link, known }: { link: string; known?: boolean }) {
  if (known !== false && isKnownLink(link)) {
    return (
      <a href={link} target="_blank" rel="noopener noreferrer nofollow ugc">
        {shortLink(link)}
        <span aria-hidden="true"> ↗</span>
      </a>
    );
  }
  return <LinkAsText link={link} />;
}

/** A contact as text. Only an e-mail address is a link (mailto); any web address is plain text with its domain. */
export function ContactValue({ kind, value }: { kind: string; value: string }) {
  if (kind === 'email' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return <a href={`mailto:${value}`}>{value}</a>;
  if (linkDomain(value)) return <LinkAsText link={value} />;
  return <span className="mk-contact-value">{value}</span>;
}

/** The creator's public contact (optional): on the profile and on the request form. */
export function ContactBlock({ contacts }: { contacts: Contact[] }) {
  const tt = useT();
  const t = tt.market.profile;
  const asText = contacts.some((c) => linkDomain(c.value) !== null);
  return (
    <div className="mk-contact">
      <p className="field-label">{t.contact}</p>
      {contacts.length === 0 ? (
        <p className="hint">{t.noContact}</p>
      ) : (
        <>
          <dl className="mk-contacts">
            {contacts.map((c, i) => (
              <div key={i}>
                <dt>{tt.market.contactKinds[c.kind] ?? c.kind}</dt>
                <dd>
                  <ContactValue kind={c.kind} value={c.value} />
                </dd>
              </div>
            ))}
          </dl>
          <p className="hint">{t.contactLine}</p>
          {asText && <p className="hint mk-dim">{t.linkText}</p>}
        </>
      )}
    </div>
  );
}

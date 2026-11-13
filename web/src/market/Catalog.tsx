// `/creators`: the catalog. Category filter, search,
// creator cards: picture, name, categories, "from" price, deals done, rating.
import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import { CATEGORIES, keyFingerprint, myRequests, type Card, type Category } from '../lib/market';
import { navigate } from '../real/ctx';
import { market, useProfileKey, useTitle } from './ctx';
import { Avatar, Go, Identicon, LoadState, monthName, Rating, Tags } from './parts';

type Filter = Category | 'all';

function readFilter(): Filter {
  const c = new URLSearchParams(window.location.search).get('category');
  return CATEGORIES.includes(c as Category) ? (c as Category) : 'all';
}

export function Catalog() {
  const tt = useT();
  const t = tt.market.catalog;
  const key = useProfileKey();
  const [filter, setFilter] = useState<Filter>(readFilter);
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<Card[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [state, setState] = useState<{ loading: boolean; error: unknown }>({ loading: true, error: null });
  // The first answer arrived: from then on a new filter or search keeps the old cards on screen (dimmed) until the
  // next answer, so nothing flashes or jumps. `shownFor` = what the cards on screen answer.
  const [loaded, setLoaded] = useState(false);
  const [shownFor, setShownFor] = useState<{ filter: Filter; query: string }>({ filter, query: '' });
  const [tick, setTick] = useState(0);
  const [more, setMore] = useState(false);
  const mine = myRequests().slice(0, 5);
  useTitle(tt.market.titles.catalog);

  // search waits until typing stops
  useEffect(() => {
    const id = window.setTimeout(() => setQuery(q.trim()), 250);
    return () => window.clearTimeout(id);
  }, [q]);

  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    market()
      .then((api) => api.profiles({ category: filter === 'all' ? undefined : filter, q: query || undefined }))
      .then((r) => {
        if (!alive) return;
        setItems(r.items);
        setCursor(r.next_cursor);
        setShownFor({ filter, query });
        setLoaded(true);
        setState({ loading: false, error: null });
      })
      .catch((error) => alive && setState({ loading: false, error }));
    return () => {
      alive = false;
    };
  }, [filter, query, tick]);

  const pick = (f: Filter) => {
    setFilter(f);
    window.history.replaceState(null, '', f === 'all' ? '/creators' : `/creators?category=${f}`);
  };

  const loadMore = async () => {
    if (!cursor) return;
    setMore(true);
    try {
      const api = await market();
      const r = await api.profiles({ category: filter === 'all' ? undefined : filter, q: query || undefined, cursor });
      setItems((x) => [...x, ...r.items]);
      setCursor(r.next_cursor);
    } catch {
      /* the button stays; a second press tries again */
    } finally {
      setMore(false);
    }
  };

  const filters: Filter[] = ['all', ...CATEGORIES];

  return (
    <main className="mk">
      <section className="mk-head" aria-labelledby="catalog-title">
        <div className="mk-head-text">
          <h1 id="catalog-title">{t.title}</h1>
          <p className="lead mk-lead">{t.lead}</p>
          <ol className="mk-steps">
            {t.steps.map((s, i) => (
              <li key={s}>
                <span className="step-num">{i + 1}</span>
                {s}
              </li>
            ))}
          </ol>
        </div>
        <aside className="mk-you">
          {key ? (
            <>
              <Go to="/profile" className="btn-ghost" onGo={navigate}>
                {t.yourProfile}
              </Go>
              <Go to="/inbox" className="btn-ghost" onGo={navigate}>
                {t.inbox}
              </Go>
            </>
          ) : (
            <>
              <p className="hint">{t.youMake}</p>
              <Go to="/profile" className="btn-ghost" onGo={navigate}>
                {t.makeProfile}
              </Go>
            </>
          )}
        </aside>
      </section>

      <div className="mk-filters">
        <div className="chips" role="radiogroup" aria-label={t.filterLabel}>
          {filters.map((f) => (
            <button key={f} type="button" role="radio" aria-checked={filter === f} className="chip" onClick={() => pick(f)}>
              {f === 'all' ? t.all : tt.market.categories[f]}
            </button>
          ))}
        </div>
        <label className="field mk-search">
          <span className="sr-only">{t.searchLabel}</span>
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t.search} maxLength={60} />
        </label>
        {/* one fixed place, whatever the list below is doing */}
        <p className="hint mk-trust">{t.trust}</p>
      </div>

      {!loaded ? (
        <LoadState kind="cards" loading={state.loading} error={state.error} onRetry={() => setTick((x) => x + 1)} />
      ) : (
        <div className={state.loading ? 'mk-results mk-busy' : 'mk-results'} aria-busy={state.loading}>
          {state.error !== null && !state.loading && (
            <LoadState loading={false} error={state.error} onRetry={() => setTick((x) => x + 1)} />
          )}
          {items.length === 0 ? (
            <p className="mk-empty">{shownFor.filter === 'all' && !shownFor.query ? t.empty : t.emptyFilter}</p>
          ) : (
            <ul className="mk-grid">
              {items.map((c) => (
                <li key={c.profile_id}>
                  <CreatorCard c={c} />
                </li>
              ))}
            </ul>
          )}
          {cursor && (
            <div className="actions mk-more">
              <button className="btn-ghost" type="button" disabled={more} aria-busy={more} onClick={loadMore}>
                {t.more}
              </button>
            </div>
          )}
        </div>
      )}

      {mine.length > 0 && (
        <section className="mk-section" aria-labelledby="mine-title">
          <h2 id="mine-title">{t.myRequests}</h2>
          <ul className="mk-list">
            {mine.map((r) => (
              <li key={r.handle} className="mk-row">
                <Identicon id={r.profileId} size="sm" />
                <span className="mk-row-main">
                  <strong>{r.nickname}</strong>
                  {r.service && <span className="mk-dim"> · {r.service}</span>}
                </span>
                <Go to={`/r#${r.token}${r.profilePk ? `.${keyFingerprint(r.profilePk)}` : ''}`} className="btn-link" onGo={navigate}>
                  {t.openRequest}
                </Go>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}

function CreatorCard({ c }: { c: Card }) {
  const t = useT().market;
  return (
    <Go to={`/creators/${c.profile_id}`} className="mk-card" onGo={navigate}>
      <Avatar id={c.profile_id} avatar={c.avatar} />
      <span className="mk-card-body">
        <span className="mk-card-name">{c.nickname}</span>
        <Tags categories={c.categories} />
        <Rating avg={c.rating_avg} count={c.reviews_count} deals={c.finished_deals} />
        {c.since_month && <span className="mk-card-since">{t.rules.since(monthName(c.since_month))}</span>}
      </span>
      <span className={c.price_from_usdc !== null ? 'mk-card-price' : 'mk-card-price mk-card-price-chat'}>
        {c.price_from_usdc !== null ? t.from(c.price_from_usdc) : t.priceInChat}
      </span>
    </Go>
  );
}

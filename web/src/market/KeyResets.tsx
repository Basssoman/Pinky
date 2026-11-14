// Public log of profile key changes by support, like the
// dispute log on /disputes: month, profile and what happened. Never the code,
// the keys or the account (the server does not send them).
import { useT } from '../i18n';
import { navigate } from '../real/ctx';
import { useMarket, useTitle } from './ctx';
import { dayName, Go, monthName } from './parts';

export function KeyResetsPage() {
  const tt = useT();
  const t = tt.market.resets;
  useTitle(t.pageTitle);
  const log = useMarket((api) => api.keyResets(), []);

  return (
    <main className="home">
      <section className="home-section" aria-labelledby="resets-title">
        <h1 id="resets-title">{t.title}</h1>
        <p className="home-lead">{t.lead}</p>
        <p className="hint">{t.rules}</p>
      </section>
      <section className="home-section" aria-live="polite">
        {log.data === null && log.loading ? (
          <p className="hint" role="status">
            {t.loading}
          </p>
        ) : log.data === null ? (
          <p className="hint">{t.failed}</p>
        ) : log.data.items.length === 0 ? (
          <p className="hint">{t.none}</p>
        ) : (
          <dl className="facts">
            {log.data.items.map((e, i) => (
              <div key={i}>
                <dt>{monthName(e.month)}</dt>
                <dd>
                  {e.nickname ? (
                    <Go to={`/creators/${e.profile_id}`} className="nick" onGo={navigate}>
                      @{e.nickname}
                    </Go>
                  ) : (
                    t.hidden
                  )}
                  {': '}
                  {t.status[e.status]}
                  {e.status === 'pending' && e.effective_at ? ` (${t.until(dayName(e.effective_at))})` : ''}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </section>
    </main>
  );
}

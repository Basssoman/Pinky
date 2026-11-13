// "You have an unfinished deal — continue": a deal made in this
// browser whose key was not saved yet. The key and the terms were stored here
// the moment the deal was made, so the person goes back to the key step of the
// SAME deal instead of starting again. "Hide" only hides the
// reminder: the key stays in this browser, in case the client already has the link.
// A quiet "Show hidden deals (n)" brings hidden ones back.
import { useState } from 'react';
import { useT } from './i18n';
import { hiddenUnfinished, hideUnfinished, listLocalDeals, unfinishedDeals, unhideUnfinished } from './lib/local';
import { navigate } from './real/ctx';

function read() {
  try {
    const all = listLocalDeals();
    return { shown: unfinishedDeals(all, Date.now()).slice(0, 3), hidden: hiddenUnfinished(all, Date.now()) };
  } catch {
    return { shown: [], hidden: [] };
  }
}

export function UnfinishedDeals() {
  const t = useT().flow;
  const [deals, setDeals] = useState(read);
  if (!deals.shown.length && !deals.hidden.length) return null;
  const hide = (handle: string) => {
    hideUnfinished(handle);
    setDeals(read());
  };
  const showHidden = () => {
    for (const d of deals.hidden) unhideUnfinished(d.handle);
    setDeals(read());
  };
  if (!deals.shown.length) {
    return (
      <p className="unfinished-hidden">
        <button className="btn-link btn-inline" type="button" onClick={showHidden}>
          {t.showHidden(deals.hidden.length)}
        </button>
      </p>
    );
  }
  return (
    <div className="panel unfinished" role="region" aria-label={t.unfinishedTitle}>
      <p className="panel-title">{t.unfinishedTitle}</p>
      {deals.shown.map((d) => (
        <div className="unfinished-row" key={d.handle}>
          <p className="hint">{t.unfinishedLine(d.title || '…')}</p>
          <div className="unfinished-actions">
            <button className="cta cta-inline" type="button" onClick={() => navigate(`/d#${d.token}`)}>
              {t.continue}
            </button>
            <button className="btn-ghost" type="button" onClick={() => hide(d.handle)}>
              {t.hide}
            </button>
          </div>
        </div>
      ))}
      {deals.hidden.length > 0 && (
        <button className="btn-link btn-inline unfinished-more" type="button" onClick={showHidden}>
          {t.showHidden(deals.hidden.length)}
        </button>
      )}
    </div>
  );
}

// The personal link `/k#…` = the deal key. It looks different from the deal
// link: a big "Secret key" page. Opened in a browser that does NOT already hold
// this key → a full-screen warning first, because the usual reason is
// a scammer who sent it or asked for it. The owner restoring on a new device can
// still continue after confirming (real/KeyLink.tsx then stores the key here).
import { useState } from 'react';
import { useT } from './i18n';

export function KeyLinkPage(props: {
  held: boolean;
  title: string;
  onOpen: () => void;
  onLeave: () => void;
  /** Opening a Face ID link: waiting for the passkey, or why it did not open. */
  busy?: boolean;
  error?: string | null;
}) {
  const [mine, setMine] = useState(false);
  const t = useT().keylink;

  if (!props.held) {
    return (
      <main className="keylink keylink-warn" aria-labelledby="keylink-title">
        <p className="keylink-label">{t.label}</p>
        <h1 id="keylink-title">{t.warnTitle}</h1>
        <p className="lead">{t.warnLead}</p>
        <div className="actions">
          <button className="cta cta-inline" type="button" onClick={props.onLeave}>
            {t.close}
          </button>
        </div>

        <div className="keylink-own">
          <label className="check">
            <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} />
            {t.mine}
          </label>
          <button className="btn-ghost" type="button" disabled={!mine || props.busy} onClick={props.onOpen}>
            {t.openHere}
          </button>
        </div>
        {props.error && (
          <p className="hint notify-failed" role="alert">
            {props.error}
          </p>
        )}
      </main>
    );
  }

  return (
    <main className="keylink" aria-labelledby="keylink-title">
      <p className="keylink-label">{t.label}</p>
      <h1 id="keylink-title">{t.title}</h1>
      {props.title && <p className="lead">{props.title}</p>}
      <p className="hint">{t.never}</p>
      <div className="actions">
        <button className="cta cta-inline" type="button" disabled={props.busy} onClick={props.onOpen}>
          {t.open}
        </button>
      </div>
      {props.error && (
        <p className="hint notify-failed" role="alert">
          {props.error}
        </p>
      )}
    </main>
  );
}

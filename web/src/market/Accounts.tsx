// Verified accounts. In the editor: the creator adds a
// YouTube channel / X account / Behance profile, gets a code for it, puts the
// code in the bio, presses "Check". The site reads the bio (X: our team looks
// by hand). On the profile: "Account confirmed: @handle". The code stays in
// the bio: the site looks again from time to time and the mark goes without it.
// Every call is signed by the profile key in this browser.
import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import { ApiError } from '../lib/api';
import { NET } from '../lib/config';
import { profileIdOfKey, signAccountAdd, signAccountCheck, signAccountRemove, signAccountsRead, type OwnAccount, type ProfileKey, type PublicAccount } from '../lib/market';
import { CopyButton, useConfirm, useRun } from '../ui';
import { market } from './ctx';
import { MarketProblem } from './parts';

type CheckNote = 'found' | 'notFound' | 'byHand';

export function AccountsSection({ k, exists }: { k: ProfileKey; exists: boolean }) {
  const t = useT().market.accounts;
  const id = profileIdOfKey(k);
  const [items, setItems] = useState<OwnAccount[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [url, setUrl] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, CheckNote>>({});
  const adding = useRun();
  const checking = useRun();
  const removing = useRun();
  const asking = useConfirm();

  useEffect(() => {
    if (!exists) return;
    let alive = true;
    setFailed(false);
    market()
      .then((api) => api.accounts(id, { profile_pk: k.pk, ...signAccountsRead(NET.contractId, k, Date.now()) }))
      .then((r) => alive && setItems(r.items))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [exists, id, k]);

  const [busyId, setBusyId] = useState<string | null>(null);
  // Keeps the place of an account in the list (a new one goes last).
  const upsert = (a: OwnAccount) =>
    setItems((list) => {
      const l = list ?? [];
      return l.some((x) => x.account_id === a.account_id) ? l.map((x) => (x.account_id === a.account_id ? a : x)) : [...l, a];
    });

  const add = async () => {
    setProblem(null);
    const link = url.trim();
    const api = await market();
    try {
      const r = await api.addAccount(id, { profile_pk: k.pk, ...signAccountAdd(NET.contractId, k, link, Date.now()) });
      upsert(r.account);
      setUrl('');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'bad_account') return setProblem(t.badUrl);
      if (e instanceof ApiError && e.code === 'too_many_accounts') return setProblem(t.tooMany);
      throw e;
    }
  };

  const check = async (a: OwnAccount) => {
    setBusyId(a.account_id);
    try {
      const api = await market();
      const r = await api.checkAccount(id, a.account_id, { profile_pk: k.pk, ...signAccountCheck(NET.contractId, k, a.account_id, Date.now()) });
      upsert(r.account);
      setNotes((n) => ({ ...n, [a.account_id]: r.result === 'found' ? 'found' : r.result === 'absent' ? 'notFound' : 'byHand' }));
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (a: OwnAccount) => {
    const api = await market();
    await api.removeAccount(id, a.account_id, { profile_pk: k.pk, ...signAccountRemove(NET.contractId, k, a.account_id, Date.now()) });
    setItems((list) => (list ?? []).filter((x) => x.account_id !== a.account_id));
  };

  return (
    <section className="mk-section" aria-labelledby="accounts-title">
      <div className="panel mk-accounts">
        <h2 id="accounts-title" className="panel-title">
          {t.title}
        </h2>
        <p className="hint">{t.lead}</p>
        {!exists ? (
          <p className="hint">{t.saveFirst}</p>
        ) : (
          <>
            {failed && <p className="hint">{t.loadFailed}</p>}
            {items && items.length > 0 && (
              <ul className="mk-account-list">
                {items.map((a) => (
                  <li key={a.account_id} className="mk-account">
                    <p className="mk-account-head">
                      <span>
                        {t.platform[a.platform]} · <span className="nick">{a.handle}</span>
                      </span>
                      <span className={`mk-status mk-acc-${a.status}`}>{t.status[a.status]}</span>
                    </p>
                    {a.status !== 'confirmed' && (
                      <div className="mk-account-code">
                        <span className="hint">{t.codeLabel}</span>
                        <code>{a.code}</code>
                        <CopyButton text={a.code} />
                      </div>
                    )}
                    {notes[a.account_id] && (
                      <p className={notes[a.account_id] === 'found' ? 'saved-note' : 'hint'} role="status">
                        {t[notes[a.account_id]]}
                      </p>
                    )}
                    {a.status === 'review' && !notes[a.account_id] && <p className="hint">{t.byHand}</p>}
                    <div className="actions">
                      {a.status !== 'confirmed' && (
                        <button className="btn-ghost btn-sm" type="button" disabled={checking.busy} onClick={() => void checking.run(() => check(a))}>
                          {busyId === a.account_id ? t.checking : t.check}
                        </button>
                      )}
                      <button
                        className="btn-link btn-inline"
                        type="button"
                        disabled={removing.busy}
                        onClick={async () => (await asking.confirm(t.removeConfirm, t.remove)) && removing.run(() => remove(a))}
                      >
                        {t.remove}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <MarketProblem error={checking.error ?? removing.error} />
            {(items?.length ?? 0) < 3 && (
              <form
                className="mk-account-add"
                noValidate
                onSubmit={(e) => {
                  e.preventDefault();
                  if (url.trim()) void adding.run(add);
                }}
              >
                <label className="field">
                  <span className="field-label">{t.urlLabel}</span>
                  <input type="url" inputMode="url" value={url} maxLength={300} placeholder={t.urlPlaceholder} onChange={(e) => setUrl(e.target.value)} />
                </label>
                {problem && <span className="field-error">{problem}</span>}
                <MarketProblem error={adding.error} />
                <div className="actions">
                  <button className="btn-ghost btn-sm" type="submit" disabled={adding.busy || !url.trim()}>
                    {adding.busy ? t.adding : t.add}
                  </button>
                </div>
              </form>
            )}
            <p className="hint">{t.keep}</p>
          </>
        )}
        {/* The reset code is never asked for unless the owner wrote to support. */}
        <p className="hint mk-note">{t.never}</p>
        {asking.box}
      </div>
    </section>
  );
}

/** On the public profile: "Account confirmed: @handle" (control of the account, not authorship of every work). */
export function ConfirmedAccounts({ accounts }: { accounts?: PublicAccount[] }) {
  const t = useT().market.accounts;
  if (!accounts?.length) return null;
  return (
    <div className="mk-block">
      <h2>{t.publicTitle}</h2>
      <ul className="mk-links mk-confirmed">
        {accounts.map((a) => (
          <li key={a.url}>
            <span className="mk-check" aria-hidden="true">
              ✓{' '}
            </span>
            <a href={a.url} target="_blank" rel="noopener noreferrer nofollow">
              {t.mark(a.handle)} · {t.platform[a.platform]}
              <span aria-hidden="true"> ↗</span>
            </a>
          </li>
        ))}
      </ul>
      <p className="hint">{t.markHint}</p>
    </div>
  );
}

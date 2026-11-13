// "Save your key": the ONE key screen per party per deal.
// Downloading the key file is enough proof; copying the link needs a paste-back.
// The key was made in this browser and is never sent anywhere: `link` carries it.
// ONE personal link: the plain link (= the key) or, once the
// deal is protected with Face ID, the Face ID link; the key file then also
// holds the backup key, so it opens the deal without the passkey.
import { useState } from 'react';
import { useT } from './i18n';
import { keyFileText, saveTextFile } from './keyFile';
import type { LocalDeal } from './lib/local';
import { ownLink, type Sealed } from './lib/passkey';
import { PasskeyProtect } from './PasskeyProtect';
import { TelegramNotify } from './TelegramNotify';
import { Problem } from './ui';

export function KeyStep(props: {
  /** The personal link (= the key). */
  link: string;
  /** What the deal is, for the key file. */
  title: string;
  /** Second line of the key file: "Role: creator" or "With: …". */
  who: string;
  /** Short tag for the file name. */
  tag: string;
  role?: 'client' | 'creator';
  next?: string;
  onDone: () => void;
  busy?: boolean;
  error?: unknown;
  /** The person saved it earlier (e.g. the page was reloaded before the next step). */
  alreadySaved?: boolean;
  /** This party's deal (real pages only): offers Face ID protection and Telegram notifications. */
  own?: Pick<LocalDeal, 'role' | 'handle' | 'seed' | 'token'> & { sealed?: Sealed };
  /** The deal record changed (protected with the passkey): re-read it. */
  onProtected?: () => void;
}) {
  const { onDone, role = 'client', link, own } = props;
  const tt = useT();
  const t = tt.key;
  const f = tt.flow;
  const sealed = Boolean(own?.sealed);
  const oneLink = own ? ownLink(window.location.origin, own) : link;
  const fileName = t.fileName(role, props.tag);
  const [saved, setSaved] = useState<'none' | 'file' | 'link' | 'before'>(props.alreadySaved ? 'before' : 'none');
  const [relinked, setRelinked] = useState(false);
  const [showLink, setShowLink] = useState(false);
  const [pasted, setPasted] = useState('');
  const [copied, setCopied] = useState(false);

  const download = () => {
    saveTextFile(fileName, own ? keyFileText(tt, props.title, props.who, own) : t.file(props.title, props.who, link).join('\n'));
    setSaved('file');
    setRelinked(false);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(oneLink);
      setCopied(true);
    } catch {
      setCopied(false); // clipboard blocked: the link is still shown to copy by hand
    }
  };

  const onPaste = (value: string) => {
    setPasted(value);
    // With Face ID the link alone is not a backup: the key file is (it opens the deal without the passkey).
    if (!sealed && value.trim() === oneLink) setSaved('link');
  };

  // Protecting changes the personal link: what was saved before is the old link, so save the file again.
  const protectedNow = () => {
    if (saved !== 'none') {
      setSaved('none');
      setRelinked(true);
    }
    setPasted('');
    setCopied(false);
    props.onProtected?.();
  };

  return (
    <section className="terms screen" aria-labelledby="key-title">
      <h1 id="key-title">{t.title}</h1>
      <p className="lead">
        {role === 'creator' ? t.leadCreator : t.leadClient} {t.leadRest}
      </p>

      {/* Optional, before saving: then the file holds the final link. */}
      {own && <PasskeyProtect own={own} onChange={protectedNow} />}

      <div className="actions">
        <button className="cta cta-inline" type="button" onClick={download}>
          {saved === 'file' ? t.downloadAgain : t.download}
        </button>
        {!showLink && (
          <button className="btn-ghost" type="button" onClick={() => setShowLink(true)}>
            {t.copyInstead}
          </button>
        )}
      </div>

      {relinked && (
        <p className="hint" role="status">
          {f.relinked}
        </p>
      )}
      {saved === 'file' && (
        <p className="saved-note" role="status">
          <span aria-hidden="true">✓</span> {t.savedAs(fileName)}
        </p>
      )}
      {saved === 'before' && (
        <p className="saved-note" role="status">
          <span aria-hidden="true">✓</span> {t.savedBefore}
        </p>
      )}

      {showLink && (
        <div className="link-box">
          <p className="field-label">{t.yourLink}</p>
          <div className="address">
            <code>{oneLink}</code>
            <button className="btn-ghost btn-sm" type="button" onClick={copy}>
              {copied ? t.copied : t.copy}
            </button>
          </div>
          {sealed ? (
            <p className="hint">{f.protectedSaveFile}</p>
          ) : (
            <label className="field">
              <span className="field-label">{t.pasteBack}</span>
              <input
                type="text"
                value={pasted}
                onChange={(e) => onPaste(e.target.value)}
                placeholder="https://…/k#…"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
          )}
          {saved === 'link' && (
            <p className="saved-note" role="status">
              <span aria-hidden="true">✓</span> {t.linkSaved}
            </p>
          )}
        </div>
      )}

      <p className="hint">{t.keepIt(role === 'creator' ? 'client' : 'creator')}</p>

      {/* Optional Telegram notifications; hidden when the server has no bot or in the demo. */}
      {own && <TelegramNotify local={own} />}

      <Problem error={props.error} />
      <p className="next-step">{role === 'creator' ? f.nextCreator : f.nextClient}</p>
      <div className="actions">
        <button className="cta cta-inline" type="button" disabled={saved === 'none' || props.busy} onClick={onDone}>
          {props.busy ? t.oneMoment : (props.next ?? t.continueToPay)}
        </button>
        {saved === 'none' && <p className="hint">{t.saveFirst}</p>}
      </div>
    </section>
  );
}

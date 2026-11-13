// "Protect with Face ID / fingerprint" and the
// "Unlock your deal" screen. Shown only where the browser can do passkeys with
// PRF. The key file never changes: it stays the way in without the passkey.
import { useEffect, useRef, useState } from 'react';
import { useT } from './i18n';
import { FileKeyError, keyFromFile } from './keyFile';
import { isLocked, rememberUnlocked, type LocalDeal, type Role } from './lib/local';
import {
  browserMemo,
  browserWebAuthn,
  fakeWebAuthn,
  passkeySupport,
  PasskeyError,
  protectKey,
  unlockKey,
  type Sealed,
  type WebAuthnLike,
} from './lib/passkey';
import { getCtx } from './real/ctx';
import { useRun } from './ui';

/** Development only: `?passkey=fake` uses pretend passkeys (no Face ID), to look at the screens. */
const DEV_FAKE = import.meta.env.DEV && typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('passkey') === 'fake';
let wa: WebAuthnLike | null = null;
const webAuthn = (): WebAuthnLike => (wa ??= DEV_FAKE ? fakeWebAuthn().wa : browserWebAuthn());
const rpId = () => window.location.hostname;

let supportOnce: Promise<boolean> | null = null;
export function usePasskeySupport(): boolean {
  const [ok, setOk] = useState(false);
  useEffect(() => {
    let alive = true;
    supportOnce ??= DEV_FAKE ? Promise.resolve(true) : passkeySupport();
    void supportOnce.then((v) => alive && setOk(v));
    return () => {
      alive = false;
    };
  }, []);
  return ok;
}

export function passkeyMessage(e: unknown, t: ReturnType<typeof useT>['passkey']): string {
  if (e instanceof PasskeyError) return e.code === 'cancelled' ? t.cancelled : e.code === 'unsupported' ? t.unsupported : t.wrong;
  return t.failed;
}

type Own = Pick<LocalDeal, 'role' | 'handle' | 'seed' | 'token'> & { sealed?: Sealed };

/** The block on the key step and the deal page. `onChange` re-reads the deal from the store. */
export function PasskeyProtect({ own, onChange, onDownload }: { own: Own; onChange: () => void; onDownload?: () => void }) {
  const supported = usePasskeySupport();
  const t = useT().passkey;
  const run = useRun();
  // Shown at once after protecting (also on the example pages, which store nothing).
  const [justSealed, setJustSealed] = useState<Sealed | null>(null);
  const sealed = own.sealed ?? justSealed;
  if (!sealed && !supported) return null;

  if (sealed) {
    return (
      <div className="notify">
        <div>
          <p className="notify-title">
            <span aria-hidden="true">✓</span> {t.on}
          </p>
          <p className="hint">{t.onHint}</p>
        </div>
        {onDownload && (
          <button className="btn-ghost" type="button" onClick={onDownload}>
            {t.downloadFile}
          </button>
        )}
      </div>
    );
  }

  const protect = () =>
    run.run(async () => {
      const ctx = getCtx();
      const sealed = await protectKey(webAuthn(), browserMemo(), rpId(), own);
      const cur = ctx.store.get(own.handle);
      // Only now the plain key leaves this browser's storage (it stays in memory for this page).
      if (cur && cur.seed === own.seed) ctx.store.put({ ...cur, sealed });
      setJustSealed(sealed);
      onChange();
    });

  return (
    <div className="notify">
      <div>
        <p className="notify-title">{t.title}</p>
        <p className="hint">{t.hint}</p>
        {run.error !== null && (
          <p className="hint notify-failed" role="alert">
            {passkeyMessage(run.error, t)}
          </p>
        )}
      </div>
      <button className="btn-ghost" type="button" disabled={run.busy} onClick={protect}>
        {run.busy ? t.working : t.protect}
      </button>
    </div>
  );
}

/** Face ID / fingerprint -> the key, kept in memory for this page. Nothing is changed on failure. */
export async function unlockOwn(own: Pick<LocalDeal, 'role' | 'token' | 'handle'> & { sealed: Sealed }): Promise<string> {
  const seed = await unlockKey(webAuthn(), rpId(), own.sealed, own.role, own.token);
  rememberUnlocked(own.handle, seed);
  return seed;
}

/**
 * The two ways into a protected deal (one personal link for everyone):
 * Face ID / fingerprint, or the key file. `onOpened` gets the key; nothing is
 * stored or changed when either way fails.
 */
export function OpenChoice(props: {
  sealed: Sealed;
  role: Role;
  token: string;
  handle: string;
  onOpened: (seed: string) => void;
}) {
  const t = useT().passkey;
  const supported = usePasskeySupport();
  const run = useRun();
  const file = useRef<HTMLInputElement>(null);
  const err = run.error;
  const text =
    err instanceof FileKeyError ? (err.code === 'wrong' ? t.fileWrong : t.fileUnreadable) : err !== null ? passkeyMessage(err, t) : null;
  const want = { role: props.role, token: props.token, pk: props.sealed.pk };
  return (
    <>
      <div className="actions">
        {supported && (
          <button
            className="cta cta-inline"
            type="button"
            disabled={run.busy}
            onClick={() => run.run(async () => props.onOpened(await unlockOwn({ ...props, sealed: props.sealed })))}
          >
            {run.busy ? t.working : t.unlock}
          </button>
        )}
        <button className={supported ? 'btn-ghost' : 'cta cta-inline'} type="button" disabled={run.busy} onClick={() => file.current?.click()}>
          {t.openFile}
        </button>
        <input
          ref={file}
          type="file"
          accept=".txt,text/plain"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) {
              void run.run(async () => {
                const seed = await keyFromFile(f, want);
                rememberUnlocked(props.handle, seed);
                props.onOpened(seed);
              });
            }
          }}
        />
      </div>
      {text && (
        <p className="hint notify-failed" role="alert">
          {text}
        </p>
      )}
    </>
  );
}

/** The deal page of a protected deal before it is opened on this page: Face ID or the key file. */
export function UnlockScreen({ own, onUnlocked }: { own: LocalDeal; onUnlocked: () => void }) {
  const t = useT().passkey;
  return (
    <main className="keylink" aria-labelledby="unlock-title">
      <p className="keylink-label">{t.label}</p>
      <h1 id="unlock-title">{t.lockedTitle}</h1>
      {own.title && <p className="lead">{own.title}</p>}
      <p className="hint">{t.lockedLead}</p>
      <OpenChoice sealed={own.sealed!} role={own.role} token={own.token} handle={own.handle} onOpened={() => onUnlocked()} />
      <p className="hint">{t.orFile}</p>
    </main>
  );
}

export { isLocked };

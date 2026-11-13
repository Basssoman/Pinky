// `/profile`: the creator's own profile. First visit:
// make a profile key in this browser → save the recovery file (like deal
// keys, KeyStep.tsx) → the form. Later: edit, or hide the profile.
// `/p#p1.<seed>`: the recovery link from that file; it puts the key into a
// browser only after the person confirms it is theirs (like `/k#…`).
import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n';
import { ApiError } from '../lib/api';
import { NET } from '../lib/config';
import { keyFromSeed } from '../lib/keys';
import {
  CATEGORIES,
  cleanProfile,
  CONTACT_KINDS,
  LIMITS,
  newProfileKey,
  parseProfileRecovery,
  profileIdOf,
  profileIdOfKey,
  profileProblems,
  profileRecoveryLink,
  serviceProblems,
  signProfileWrite,
  storeProfileKey,
  type Category,
  type ProfileFields,
  type ProfileKey,
} from '../lib/market';
import { AvatarFileError, bytesToBase64, prepareAvatar, signAvatar } from '../lib/marketAvatar';
import { PixelSelect } from '../PixelSelect';
import { navigate } from '../real/ctx';
import { CopyButton, Notice, useConfirm, useRun } from '../ui';
import { market, useProfileKey, useTitle } from './ctx';
import { Avatar, dayName, Go, Identicon, LoadState, MarketProblem, marketError, useAvatarTexts } from './parts';

export function EditorPage() {
  const tt = useT();
  const key = useProfileKey();
  const [restoring, setRestoring] = useState(false);
  useTitle(tt.market.titles.editor);
  if (!key) {
    return restoring ? <Restore onBack={() => setRestoring(false)} /> : <Intro onRestore={() => setRestoring(true)} />;
  }
  if (!key.saved) return <SaveKey k={key} />;
  return <ProfileForm k={key} />;
}

// ---------------------------------------------------------------- first visit

function Intro({ onRestore }: { onRestore: () => void }) {
  const t = useT().market.editor;
  return (
    <main className="mk">
      <section className="mk-narrow terms screen" aria-labelledby="intro-title">
        <h1 id="intro-title">{t.introTitle}</h1>
        <p className="lead">{t.introLead}</p>
        <ul className="mk-points">
          {t.introPoints.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
        <div className="actions">
          <button className="cta cta-inline" type="button" onClick={() => storeProfileKey(newProfileKey())}>
            {t.create}
          </button>
          <button className="btn-ghost" type="button" onClick={onRestore}>
            {t.restore}
          </button>
        </div>
      </section>
    </main>
  );
}

function Restore({ onBack }: { onBack: () => void }) {
  const t = useT().market.editor;
  const [text, setText] = useState('');
  const [bad, setBad] = useState(false);
  const use = (raw: string) => {
    const seed = parseProfileRecovery(raw);
    if (!seed) return setBad(true);
    const k = keyFromSeed(seed);
    storeProfileKey({ seed: k.seed, pk: k.pk, saved: true, createdAt: Date.now() });
  };
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > 20_000) return setBad(true);
    use(await f.text());
  };
  return (
    <main className="mk">
      <section className="mk-narrow terms screen" aria-labelledby="restore-title">
        <h1 id="restore-title">{t.restoreTitle}</h1>
        <p className="lead">{t.restoreLead}</p>
        <div className="pay-form">
          <label className="field">
            <span className="field-label">{t.restoreFile}</span>
            <input className="file-input" type="file" accept=".txt,text/plain" onChange={(e) => void onFile(e.target.files?.[0])} />
          </label>
          <label className="field">
            <span className="field-label">{t.restorePaste}</span>
            <input
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setBad(false);
              }}
              placeholder="https://…/p#p1.…"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          {bad && (
            <p className="alert alert-inline" role="alert">
              {t.restoreBad}
            </p>
          )}
          <div className="actions">
            <button className="cta cta-inline" type="button" disabled={!text.trim()} onClick={() => use(text)}>
              {t.restoreUse}
            </button>
            <button className="btn-ghost" type="button" onClick={onBack}>
              {t.back}
            </button>
          </div>
        </div>
      </section>
    </main>
  );
}

/** Download = enough proof; copying the link needs a paste-back (same rule as deal keys). */
function SaveKey({ k }: { k: ProfileKey }) {
  const t = useT().market.editor;
  const link = profileRecoveryLink(window.location.origin, k.seed);
  const [saved, setSaved] = useState<'none' | 'file' | 'link'>('none');
  const [showLink, setShowLink] = useState(false);
  const [pasted, setPasted] = useState('');
  const [copied, setCopied] = useState(false);

  return (
    <main className="mk">
      <section className="mk-narrow terms screen" aria-labelledby="pkey-title">
        <div className="mk-who mk-who-sm">
          <Identicon id={profileIdOf(k.pk)} size="sm" />
          <span className="keylink-label">{t.keyHere}</span>
        </div>
        <h1 id="pkey-title">{t.keyTitle}</h1>
        <p className="lead">{t.keyLead}</p>

        <div className="actions">
          <button
            className="cta cta-inline"
            type="button"
            onClick={() => {
              downloadRecovery(t.file(link).join('\n'), t.fileName);
              setSaved('file');
            }}
          >
            {saved === 'file' ? t.downloadAgain : t.download}
          </button>
          {!showLink && (
            <button className="btn-ghost" type="button" onClick={() => setShowLink(true)}>
              {t.copyInstead}
            </button>
          )}
        </div>
        {saved === 'file' && (
          <p className="saved-note" role="status">
            <span aria-hidden="true">✓</span> {t.savedAs(t.fileName)}
          </p>
        )}

        {showLink && (
          <div className="link-box">
            <p className="field-label">{t.yourLink}</p>
            <div className="address">
              <code>{link}</code>
              <button
                className="btn-ghost btn-sm"
                type="button"
                onClick={() =>
                  navigator.clipboard.writeText(link).then(
                    () => setCopied(true),
                    () => setCopied(false),
                  )
                }
              >
                {copied ? t.copied : t.copy}
              </button>
            </div>
            <label className="field">
              <span className="field-label">{t.pasteBack}</span>
              <input
                type="text"
                value={pasted}
                onChange={(e) => {
                  setPasted(e.target.value);
                  if (e.target.value.trim() === link) setSaved('link');
                }}
                placeholder="https://…/p#…"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            {saved === 'link' && (
              <p className="saved-note" role="status">
                <span aria-hidden="true">✓</span> {t.linkSaved}
              </p>
            )}
          </div>
        )}

        <div className="actions">
          <button className="cta cta-inline" type="button" disabled={saved === 'none'} onClick={() => storeProfileKey({ ...k, saved: true })}>
            {t.next}
          </button>
          {saved === 'none' && <p className="hint">{t.saveFirst}</p>}
        </div>
      </section>
    </main>
  );
}

function downloadRecovery(text: string, name: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------- the form

type ServiceDraft = { id?: string; title: string; description: string; price: string; days: string };
type Draft = Omit<ProfileFields, 'services'> & { services: ServiceDraft[] };

const EMPTY: Draft = { nickname: '', bio: '', categories: [], portfolio: [], contacts: [], services: [] };

function toFields(d: Draft): ProfileFields {
  return cleanProfile({
    ...d,
    services: d.services.map((s) => ({
      ...(s.id ? { id: s.id } : {}),
      title: s.title,
      description: s.description,
      price_from_usdc: /^\d+$/.test(s.price.trim()) ? Number(s.price) : NaN,
      delivery_days: /^\d+$/.test(s.days.trim()) ? Number(s.days) : NaN,
    })),
  });
}

function fromFields(f: ProfileFields): Draft {
  return {
    ...f,
    services: f.services.map((s) => ({ id: s.id, title: s.title, description: s.description, price: String(s.price_from_usdc), days: String(s.delivery_days) })),
  };
}

/** One line when the profile saved but the picture did not. */
function pictureSaveError(e: unknown, ta: ReturnType<typeof useAvatarTexts>): string {
  if (e instanceof ApiError) {
    if (e.status === 413) return ta.errSaveReason(ta.errBig);
    if (e.status === 415) return ta.errSaveReason(ta.errType);
    if (e.code === 'bad_image') return ta.errSaveReason(ta.errUnreadable);
    if (e.status === 0 || e.status >= 500) return ta.errSave;
  }
  return ta.errSaveReason(marketError(e));
}

/**
 * The owner of an older profile lost its key. They make a new
 * key here (the usual way), then send support its code instead of making a
 * new profile. Support checks a code in the bio of an account the profile
 * links to; 72 h later the old profile belongs to this key.
 */
function LostKey({ k, onCheck }: { k: ProfileKey; onCheck: () => void }) {
  const tl = useT().market.life;
  return (
    <details className="panel mk-note">
      <summary className="panel-title">{tl.lostTitle}</summary>
      <p className="hint">{tl.lostLine}</p>
      <p className="field-label">{tl.lostCode}</p>
      <div className="address">
        <code>{k.pk}</code>
        <CopyButton text={k.pk} />
      </div>
      <div className="actions">
        <button className="btn-ghost btn-sm" type="button" onClick={onCheck}>
          {tl.lostCheck}
        </button>
      </div>
    </details>
  );
}

/** A picture chosen in the editor, not saved yet; or "remove the saved one". */
type PicturePending = { kind: 'new'; blob: Blob; url: string } | { kind: 'remove' } | null;

function ProfileForm({ k }: { k: ProfileKey }) {
  const tt = useT();
  const t = tt.market.editor;
  const ta = useAvatarTexts();
  const id = profileIdOfKey(k);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [exists, setExists] = useState(false);
  /** Support is moving an older profile to this key (null = no). */
  const [moving, setMoving] = useState<{ status: string; effective_at: string | null } | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [tick, setTick] = useState(0);
  const [tried, setTried] = useState(false);
  const [done, setDone] = useState<'saved' | 'hidden' | null>(null);
  const saving = useRun();
  const hiding = useRun();
  const asking = useConfirm();
  /** The saved picture's version (null = the pixel pattern). */
  const [picture, setPicture] = useState<string | null>(null);
  const [pending, setPending] = useState<PicturePending>(null);
  const [picError, setPicError] = useState<string | null>(null);
  const [picBusy, setPicBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  // The preview lives in this browser only (an object URL); freed when replaced or on leaving.
  useEffect(() => {
    const url = pending?.kind === 'new' ? pending.url : null;
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [pending]);

  useEffect(() => {
    let alive = true;
    setLoadError(null);
    market()
      .then((api) => api.profile(id))
      .then((p) => {
        if (!alive) return;
        setMoving(null);
        setDraft(fromFields(p));
        setPicture(p.avatar ?? null);
        setExists(true);
      })
      .catch(async (e) => {
        if (!alive) return;
        if (e instanceof ApiError && e.status === 404) {
          // After a key reset by support this key writes an OLDER profile (its id is not the hash of the key).
          if (!k.profileId) {
            try {
              const found = await (await market()).profileByKey(k.pk);
              if (!alive) return;
              if (found.profile_id) {
                storeProfileKey({ ...k, profileId: found.profile_id });
                return;
              }
              setMoving(found.pending ? { status: found.pending.status, effective_at: found.pending.effective_at } : null);
            } catch {
              if (alive) setMoving(null);
            }
          }
          setDraft((d) => d ?? EMPTY);
          setExists(false);
        } else setLoadError(e);
      });
    return () => {
      alive = false;
    };
  }, [id, tick, k]);

  if (moving) {
    const tl = tt.market.life;
    return (
      <Notice title={tl.movingTitle} lines={[moving.status === 'pending' && moving.effective_at ? tl.movingOn(dayName(moving.effective_at)) : tl.movingWaitCheck]}>
        <div className="actions">
          <button className="btn-ghost" type="button" onClick={() => setTick((x) => x + 1)}>
            {tl.lostCheck}
          </button>
        </div>
      </Notice>
    );
  }

  if (!draft) {
    return (
      <main className="mk">
        <LoadState loading={!loadError} error={loadError} onRetry={() => setTick((x) => x + 1)} />
      </main>
    );
  }

  const fields = toFields(draft);
  const p = profileProblems(fields);
  const ok = p.size === 0;
  const set = (patch: Partial<Draft>) => {
    setDraft({ ...draft, ...patch });
    setDone(null);
  };
  const err = (k: Parameters<typeof p.has>[0], text: string) => (tried && p.has(k) ? <span className="field-error">{text}</span> : null);

  const save = async () => {
    const api = await market();
    const profile = toFields(draft);
    await api.putProfile(id, { profile_pk: k.pk, profile, ...signProfileWrite(NET.contractId, k, profile, Date.now()) });
    setDone('saved');
    setExists(true);
    // The picture goes after the profile (the server needs the profile first).
    if (pending) {
      try {
        if (pending.kind === 'new') {
          const bytes = new Uint8Array(await pending.blob.arrayBuffer());
          const r = await api.putAvatar(id, { profile_pk: k.pk, image: bytesToBase64(bytes), ...signAvatar(NET.contractId, k, bytes, Date.now()) });
          setPicture(r.avatar);
        } else {
          await api.removeAvatar(id, { profile_pk: k.pk, ...signAvatar(NET.contractId, k, 'remove', Date.now()) });
          setPicture(null);
        }
        setPending(null);
        setPicError(null);
      } catch (e) {
        setPicError(pictureSaveError(e, ta));
      }
    }
    // read it back: the server gives new services their ids
    try {
      setDraft(fromFields(await api.profile(id)));
    } catch {
      /* the saved form stays as it is */
    }
  };

  const hide = async () => {
    const api = await market();
    await api.hideProfile(id, { profile_pk: k.pk, ...signProfileWrite(NET.contractId, k, { delete: true }, Date.now()) });
    setDone('hidden');
    setExists(false);
  };

  const pick = async (f: File | undefined) => {
    if (!f) return;
    setPicError(null);
    setPicBusy(true);
    try {
      const blob = await prepareAvatar(f);
      setPending({ kind: 'new', blob, url: URL.createObjectURL(blob) });
      setDone(null);
    } catch (e) {
      const p = e instanceof AvatarFileError ? e.problem : 'unreadable';
      setPicError(p === 'type' ? ta.errType : p === 'big' ? ta.errBig : ta.errUnreadable);
    } finally {
      setPicBusy(false);
    }
  };
  const shown = pending?.kind === 'new' ? 'new' : pending?.kind === 'remove' ? 'none' : picture ? 'saved' : 'none';

  const toggleCat = (c: Category) =>
    set({ categories: draft.categories.includes(c) ? draft.categories.filter((x) => x !== c) : draft.categories.length >= 3 ? draft.categories : [...draft.categories, c] });

  return (
    <main className="mk">
      <div className="mk-narrow mk-editor">
        <section className="terms screen" aria-labelledby="edit-title">
          <div className="mk-who">
            <Avatar id={id} avatar={pending?.kind === 'remove' ? null : picture} src={pending?.kind === 'new' ? pending.url : undefined} size="lg" />
            <div>
              <h1 id="edit-title">{exists ? t.editTitle : t.newTitle}</h1>
              <p className="lead">{t.formLead}</p>
            </div>
          </div>

          {!exists && !k.profileId && <LostKey k={k} onCheck={() => setTick((x) => x + 1)} />}

          <form
            className="pay-form"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              setTried(true);
              if (ok) void saving.run(save);
            }}
          >
            <div className="field mk-pic">
              <span className="field-label" id="pic-label">
                {ta.label}
              </span>
              <input
                ref={fileInput}
                className="sr-only"
                type="file"
                accept="image/jpeg,image/png,image/webp"
                tabIndex={-1}
                aria-hidden="true"
                onChange={(e) => {
                  void pick(e.target.files?.[0]);
                  e.target.value = '';
                }}
              />
              <div className="mk-pic-row" role="group" aria-labelledby="pic-label">
                <button className="btn-ghost btn-sm" type="button" disabled={picBusy} onClick={() => fileInput.current?.click()}>
                  {shown === 'none' ? ta.upload : ta.change}
                </button>
                {shown !== 'none' && (
                  <button className="btn-link" type="button" onClick={() => setPending(picture ? { kind: 'remove' } : null)}>
                    {ta.remove}
                  </button>
                )}
                {pending && picture && (
                  <button className="btn-link" type="button" onClick={() => setPending(null)}>
                    {ta.undo}
                  </button>
                )}
              </div>
              {picError ? (
                <span className="field-error" role="alert">
                  {picError}
                </span>
              ) : pending ? (
                <span className="hint mk-pic-pending" role="status">
                  {pending.kind === 'new' ? ta.pending : ta.pendingRemove}
                </span>
              ) : (
                <span className="hint">{ta.hint}</span>
              )}
            </div>

            <label className="field">
              <span className="field-label">{t.nickname}</span>
              <input value={draft.nickname} maxLength={LIMITS.nickname[1]} onChange={(e) => set({ nickname: e.target.value })} autoComplete="nickname" />
              {err('nickname', t.errNickname) ?? <span className="hint">{t.nicknameHint}</span>}
            </label>

            <div className="field">
              <span className="field-label" id="cats-label">
                {t.categories}
              </span>
              <div className="chips" role="group" aria-labelledby="cats-label">
                {CATEGORIES.map((c) => (
                  <button key={c} type="button" className="chip" aria-pressed={draft.categories.includes(c)} onClick={() => toggleCat(c)}>
                    {tt.market.categories[c]}
                  </button>
                ))}
              </div>
              {err('categories', t.errCategories) ?? <span className="hint">{t.categoriesHint}</span>}
            </div>

            <label className="field">
              <span className="field-label">{t.bio}</span>
              <textarea rows={4} value={draft.bio} maxLength={LIMITS.bio} onChange={(e) => set({ bio: e.target.value })} placeholder={t.bioPlaceholder} />
              {err('bio', t.errBio)}
            </label>

            <fieldset className="field mk-fieldset">
              <legend className="field-label">{t.portfolio}</legend>
              <span className="hint">{t.portfolioHint}</span>
              {draft.portfolio.map((l, i) => (
                <div className="mk-line" key={i}>
                  <input
                    value={l}
                    maxLength={LIMITS.link}
                    inputMode="url"
                    aria-label={`${t.portfolio} ${i + 1}`}
                    placeholder="https://"
                    onChange={(e) => set({ portfolio: draft.portfolio.map((x, j) => (j === i ? e.target.value : x)) })}
                  />
                  <button className="btn-link" type="button" onClick={() => set({ portfolio: draft.portfolio.filter((_, j) => j !== i) })}>
                    {t.remove}
                  </button>
                </div>
              ))}
              {err('portfolio', t.errPortfolio)}
              {draft.portfolio.length < LIMITS.portfolio && (
                <button className="btn-ghost btn-sm mk-add" type="button" onClick={() => set({ portfolio: [...draft.portfolio, ''] })}>
                  + {t.addLink}
                </button>
              )}
            </fieldset>

            <fieldset className="field mk-fieldset">
              <legend className="field-label">{t.contacts}</legend>
              <span className="hint">{t.contactsHint}</span>
              {draft.contacts.map((c, i) => (
                <div className="mk-line" key={i}>
                  <PixelSelect
                    value={c.kind}
                    label={tt.market.order.contactKind}
                    onChange={(v) => set({ contacts: draft.contacts.map((x, j) => (j === i ? { ...x, kind: v } : x)) })}
                    options={CONTACT_KINDS.map((kk) => ({ value: kk, label: tt.market.contactKinds[kk] }))}
                  />
                  <input
                    value={c.value}
                    maxLength={LIMITS.contact}
                    aria-label={tt.market.order.contactValue}
                    placeholder={tt.market.contactPlaceholders[c.kind]}
                    onChange={(e) => set({ contacts: draft.contacts.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })}
                  />
                  <button className="btn-link" type="button" onClick={() => set({ contacts: draft.contacts.filter((_, j) => j !== i) })}>
                    {t.remove}
                  </button>
                </div>
              ))}
              {err('contacts', t.errContacts)}
              {draft.contacts.length < LIMITS.contacts && (
                <button className="btn-ghost btn-sm mk-add" type="button" onClick={() => set({ contacts: [...draft.contacts, { kind: 'telegram', value: '' }] })}>
                  + {t.addContact}
                </button>
              )}
            </fieldset>

            <fieldset className="field mk-fieldset">
              <legend className="field-label">{t.services}</legend>
              <span className="hint">{t.servicesHint}</span>
              {draft.services.map((s, i) => {
                const bad = tried && serviceProblems(fields.services[i]).length > 0;
                const put = (patch: Partial<ServiceDraft>) => set({ services: draft.services.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
                return (
                  <div className={bad ? 'panel mk-svc-edit mk-bad' : 'panel mk-svc-edit'} key={s.id ?? `new-${i}`}>
                    <label className="field">
                      <span className="field-label mk-sub">{t.serviceTitle}</span>
                      <input value={s.title} maxLength={LIMITS.serviceTitle} placeholder={t.serviceTitlePlaceholder} onChange={(e) => put({ title: e.target.value })} />
                    </label>
                    <label className="field">
                      <span className="field-label mk-sub">{t.serviceDescription}</span>
                      <textarea rows={3} value={s.description} maxLength={LIMITS.serviceDescription} onChange={(e) => put({ description: e.target.value })} />
                    </label>
                    <div className="field-row">
                      <label className="field">
                        <span className="field-label mk-sub">{t.priceFrom}</span>
                        <input inputMode="numeric" value={s.price} placeholder="100" onChange={(e) => put({ price: e.target.value })} />
                      </label>
                      <label className="field">
                        <span className="field-label mk-sub">{t.deliveryDays}</span>
                        <input inputMode="numeric" value={s.days} placeholder="7" onChange={(e) => put({ days: e.target.value })} />
                      </label>
                    </div>
                    {bad && <span className="field-error">{t.errService}</span>}
                    <button className="btn-link mk-svc-remove" type="button" onClick={() => set({ services: draft.services.filter((_, j) => j !== i) })}>
                      {t.removeService}
                    </button>
                  </div>
                );
              })}
              {draft.services.length < LIMITS.services && (
                <button
                  className="btn-ghost btn-sm mk-add"
                  type="button"
                  onClick={() => set({ services: [...draft.services, { title: '', description: '', price: '', days: '' }] })}
                >
                  + {t.addService}
                </button>
              )}
            </fieldset>

            <MarketProblem error={saving.error} />
            {done === 'saved' && (
              <div className="hero hero-safe" role="status">
                <span className="hero-mark" aria-hidden="true" />
                <div>
                  <p className="hero-line">{t.saved}</p>
                  <p className="mk-done-links">
                    <Go to={`/creators/${id}`} className="nick" onGo={navigate}>
                      {t.view}
                    </Go>
                    {' · '}
                    <Go to="/inbox" className="nick" onGo={navigate}>
                      {t.toInbox}
                    </Go>
                  </p>
                </div>
              </div>
            )}
            {done === 'hidden' && (
              <p className="saved-note" role="status">
                {t.hidden}
              </p>
            )}
            <div className="actions">
              <button className="cta cta-inline" type="submit" disabled={saving.busy}>
                {saving.busy ? t.saving : t.save}
              </button>
              {exists && done !== 'saved' && (
                <Go to={`/creators/${id}`} className="btn-ghost" onGo={navigate}>
                  {t.view}
                </Go>
              )}
              {tried && !ok && <span className="field-error">{t.fixFields}</span>}
            </div>
          </form>
        </section>

        <section className="mk-section mk-danger" aria-label={t.keyHere}>
          <div className="panel">
            <p className="panel-title">{t.keyHere}</p>
            <div className="actions">
              <button
                className="btn-ghost btn-sm"
                type="button"
                onClick={() => downloadRecovery(t.file(profileRecoveryLink(window.location.origin, k.seed)).join('\n'), t.fileName)}
              >
                {t.saveKeyAgain}
              </button>
            </div>
            {exists && (
              <>
                <p className="hint">{t.hideLine}</p>
                <MarketProblem error={hiding.error} />
                <div className="actions">
                  <button className="btn-link btn-inline" type="button" disabled={hiding.busy} onClick={async () => (await asking.confirm(t.hideConfirm, t.hide)) && hiding.run(hide)}>
                    {hiding.busy ? t.hiding : t.hide}
                  </button>
                  {asking.box}
                </div>
              </>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}

// ---------------------------------------------------------------- `/p#p1.…`

export function RecoveryLinkPage() {
  const tt = useT();
  const t = tt.market.recovery;
  const current = useProfileKey();
  const [seed] = useState(() => parseProfileRecovery(window.location.hash));
  useTitle(tt.market.titles.recovery);
  // The key leaves the address bar and the history at once.
  useEffect(() => {
    if (seed) window.history.replaceState(null, '', '/p');
  }, [seed]);
  if (!seed) return <Notice title={t.badTitle} lines={[t.badLine]} />;
  const k = keyFromSeed(seed);
  const use = () => {
    storeProfileKey({ seed: k.seed, pk: k.pk, saved: true, createdAt: Date.now() });
    navigate('/profile', true);
  };
  if (current?.seed === seed) {
    return (
      <Notice title={t.same} lines={[]}>
        <div className="actions">
          <button className="cta cta-inline" type="button" onClick={() => navigate('/profile', true)}>
            {t.toProfile}
          </button>
        </div>
      </Notice>
    );
  }
  const other = current !== null;
  return (
    <Notice tone={other ? 'warn' : 'plain'} title={other ? t.otherTitle : t.title} lines={other ? [t.otherLine] : [t.lead]}>
      <div className="mk-who mk-who-sm">
        <Identicon id={profileIdOf(k.pk)} size="sm" />
      </div>
      <div className="actions">
        <button className="cta cta-inline" type="button" onClick={use}>
          {other ? t.replace : t.use}
        </button>
        <button className="btn-ghost" type="button" onClick={() => navigate('/', true)}>
          {t.leave}
        </button>
      </div>
    </Notice>
  );
}

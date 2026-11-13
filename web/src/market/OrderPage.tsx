// `/creators/:id/order?service=…`: the request form.
// No budget field. The client's contact is required. The
// request link `/r#<token>` is made here; the server gets only its hash.
import { useEffect, useState } from 'react';
import { locale, useLang, useT } from '../i18n';
import { ApiError } from '../lib/api';
import { PixelSelect } from '../PixelSelect';
import { sha256Hex } from '../lib/keys';
import { newToken } from '../lib/local';
import { CONTACT_KINDS, keyFingerprint, LIMITS, rememberRequest, requestBoxPub, type ContactKind, type Profile } from '../lib/market';
import { navigate } from '../real/ctx';
import { Notice, useRun } from '../ui';
import { market, useMarket, useTitle } from './ctx';
import { Avatar, Go, LoadState, MarketProblem, marketError } from './parts';

const GENERAL = '';

export function OrderPage({ id }: { id: string }) {
  const tt = useT();
  const { data, loading, error, reload } = useMarket((api) => api.profile(id), [id]);
  useTitle(tt.market.titles.order);
  if (error instanceof ApiError && error.status === 404) {
    return <Notice title={tt.market.profile.notFoundTitle} lines={[tt.market.profile.notFoundLine]} />;
  }
  if (!data) {
    return (
      <main className="mk">
        <LoadState loading={loading} error={error} onRetry={reload} />
      </main>
    );
  }
  return <OrderForm p={data} />;
}

/** Max request text for the AI helper (same as the server). */
export const BRIEF_AI_MAX = 600;

/**
 * AI brief helper: one shot, no chat. The client's own words in
 * the brief field go to our server, which asks a private model on NEAR AI for
 * an acceptance checklist; the answer replaces the field, the client edits it
 * (or brings their text back). Hidden when the server has no NEAR AI key.
 * The "checked" line shows only when our server verified this answer.
 */
function BriefHelper({ brief, setBrief, serviceTitle }: { brief: string; setBrief: (s: string) => void; serviceTitle?: string }) {
  const tt = useT();
  const t = tt.market.brief;
  const lang = useLang();
  const [enabled, setEnabled] = useState(false);
  const [mine, setMine] = useState<string | null>(null);
  const [verified, setVerified] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const run = useRun();

  useEffect(() => {
    let alive = true;
    market()
      .then((api) => api.briefStatus())
      .then((s) => alive && setEnabled(s.enabled === true))
      .catch(() => {
        /* no answer = no button */
      });
    return () => {
      alive = false;
    };
  }, []);

  if (!enabled) return null;

  const ask = async () => {
    const text = brief.trim();
    setProblem(null);
    if ([...text].length < 3) return setProblem(t.tooShort);
    if ([...text].length > BRIEF_AI_MAX) return setProblem(t.tooLong(BRIEF_AI_MAX));
    try {
      const api = await market();
      const r = await api.brief({ request: text, ...(serviceTitle ? { service_title: serviceTitle } : {}), lang: lang.code });
      setMine(brief);
      setBrief(r.checklist.slice(0, LIMITS.brief));
      // One plain line when our server verified the answer (no NVIDIA detail).
      setVerified(r.verified === true);
    } catch (e) {
      setProblem(e instanceof ApiError && (e.status === 429 || e.status === 400) ? marketError(e) : t.failed);
    }
  };

  if (mine !== null) {
    return (
      <div className="mk-ai mk-ai-done" role="status">
        <p className="hint">{t.done}</p>
        {verified && (
          <p className="mk-ai-checked">
            <span aria-hidden="true">✓</span> {t.checked}
          </p>
        )}
        <button
          className="btn-link btn-inline"
          type="button"
          onClick={() => {
            setBrief(mine);
            setMine(null);
            setVerified(false);
          }}
        >
          {t.undo}
        </button>
      </div>
    );
  }

  return (
    <div className="mk-ai">
      <button className="btn-ghost btn-sm" type="button" disabled={run.busy} onClick={() => void run.run(ask)}>
        <span aria-hidden="true">✦ </span>
        {run.busy ? t.busy : t.button}
      </button>
      <p className="hint">{t.line}</p>
      {problem && (
        <p className="alert alert-inline" role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}

function tomorrow(): string {
  const d = new Date(Date.now() + 24 * 3600_000);
  return d.toISOString().slice(0, 10);
}

const DAY_MS = 24 * 3600_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * "Needed by" without the system date picker: our own two
 * lists, month then day, from tomorrow to a year ahead (the server's range).
 * Dates are UTC days, like the rest of the request. "" = no date.
 */
function DayPick({ value, onChange, labelledBy }: { value: string; onChange: (v: string) => void; labelledBy: string }) {
  const t = useT().market.order;
  useLang();
  const first = tomorrow();
  const last = iso(new Date(Date.now() + 365 * DAY_MS));
  const months: string[] = [];
  for (let m = first.slice(0, 7); m <= last.slice(0, 7); ) {
    months.push(m);
    const d = new Date(`${m}-01T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + 1);
    m = iso(d).slice(0, 7);
  }
  const month = value.slice(0, 7);
  const daysOf = (m: string) => {
    const out: string[] = [];
    for (let d = new Date(`${m}-01T00:00:00Z`); iso(d).startsWith(m); d = new Date(d.getTime() + DAY_MS)) {
      const day = iso(d);
      if (day >= first && day <= last) out.push(day);
    }
    return out;
  };
  const monthName = (m: string) =>
    new Date(`${m}-01T00:00:00Z`).toLocaleDateString(locale(), { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const dayName = (d: string) =>
    new Date(`${d}T00:00:00Z`).toLocaleDateString(locale(), { day: 'numeric', weekday: 'short', timeZone: 'UTC' });
  const pickMonth = (m: string) => {
    if (!m) return onChange('');
    const days = daysOf(m);
    const same = days.find((d) => d.slice(8) === value.slice(8));
    onChange(same ?? days[0]);
  };
  return (
    <div className="mk-daypick">
      <PixelSelect
        value={month}
        labelledBy={labelledBy}
        onChange={pickMonth}
        options={[{ value: '', label: t.deadlineNone }, ...months.map((m) => ({ value: m, label: monthName(m) }))]}
      />
      {value && (
        <PixelSelect value={value} label={t.deadlineDay} onChange={onChange} options={daysOf(month).map((d) => ({ value: d, label: dayName(d) }))} />
      )}
    </div>
  );
}

function OrderForm({ p }: { p: Profile }) {
  const tt = useT();
  const t = tt.market.order;
  const initial = new URLSearchParams(window.location.search).get('service') ?? GENERAL;
  const [serviceId, setServiceId] = useState(p.services.some((s) => s.id === initial) ? initial : p.services.length ? (p.services[0].id ?? GENERAL) : GENERAL);
  const [brief, setBrief] = useState('');
  const [deadline, setDeadline] = useState('');
  const [kind, setKind] = useState<ContactKind>('telegram');
  const [contact, setContact] = useState('');
  const [tried, setTried] = useState(false);
  const sending = useRun();

  const service = p.services.find((s) => s.id === serviceId) ?? null;
  const problems = {
    brief: !brief.trim() ? t.errBrief : brief.length > LIMITS.brief ? t.errBriefLong : null,
    contact: !contact.trim() || contact.length > LIMITS.contact ? t.errContact : null,
    deadline: deadline && deadline < tomorrow() ? t.errDeadline : null,
  };
  const ok = !problems.brief && !problems.contact && !problems.deadline;
  const err = (k: keyof typeof problems) => (tried && problems[k] ? <span className="field-error">{problems[k]}</span> : null);

  const send = async () => {
    const token = newToken();
    const handle = sha256Hex(token);
    const api = await market();
    const sent = await api.createRequest({
      handle,
      profile_id: p.profile_id,
      ...(service?.id ? { service_id: service.id } : {}),
      brief: brief.trim(),
      ...(deadline ? { wanted_deadline: deadline } : {}),
      client_contact: { kind, value: contact.trim() },
      client_box_pk: requestBoxPub(token),
    });
    // Pin the creator's profile key now; "deal ready" and the nickname are checked against it later.
    const pinned = typeof sent.profile_pk === 'string' ? sent.profile_pk : undefined;
    let fp: string | null = null;
    try {
      fp = pinned ? keyFingerprint(pinned) : null;
    } catch {
      fp = null;
    }
    rememberRequest({
      token,
      handle,
      profileId: p.profile_id,
      nickname: p.nickname,
      service: service?.title ?? null,
      createdAt: Date.now(),
      ...(fp ? { profilePk: pinned } : {}),
    });
    try {
      sessionStorage.setItem('kept.requestJustSent', handle);
    } catch {
      /* only changes a highlight */
    }
    navigate(`/r#${token}${fp ? `.${fp}` : ''}`);
  };

  const options = [...p.services.map((s) => ({ id: s.id ?? '', title: s.title })), { id: GENERAL, title: t.general }];

  return (
    <main className="mk">
      <Go to={`/creators/${p.profile_id}`} className="mk-back" onGo={navigate}>
        <span aria-hidden="true">←</span> {p.nickname}
      </Go>
      <div className="deal">
        <section className="terms screen" aria-labelledby="order-title">
          <h1 id="order-title">{t.title(p.nickname)}</h1>
          <p className="lead">{t.lead}</p>

          <form
            className="pay-form"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              setTried(true);
              if (ok) void sending.run(send);
            }}
          >
            {p.services.length > 0 && (
              <div className="field">
                <span className="field-label" id="svc-label">
                  {t.service}
                </span>
                <div className="mk-options" role="radiogroup" aria-labelledby="svc-label">
                  {options.map((o) => (
                    <button
                      key={o.id || 'general'}
                      type="button"
                      role="radio"
                      aria-checked={serviceId === o.id}
                      className="chip mk-option"
                      onClick={() => setServiceId(o.id)}
                    >
                      {o.title}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <label className="field">
              <span className="field-label">{t.brief}</span>
              <textarea rows={6} value={brief} maxLength={LIMITS.brief} onChange={(e) => setBrief(e.target.value)} placeholder={t.briefPlaceholder} />
              {err('brief') ?? (brief.length > LIMITS.brief - 200 && <span className="hint">{t.left(LIMITS.brief - brief.length)}</span>)}
            </label>
            <BriefHelper brief={brief} setBrief={setBrief} serviceTitle={service?.title} />

            <div className="field mk-date">
              <span className="field-label" id="mk-deadline">{t.deadline}</span>
              <DayPick value={deadline} onChange={setDeadline} labelledBy="mk-deadline" />
              {err('deadline')}
            </div>

            <fieldset className="field mk-fieldset">
              <legend className="field-label">{t.contact}</legend>
              <div className="field-row mk-contact-row">
                <div className="field">
                  <span className="field-label mk-sub" id="mk-contact-kind">{t.contactKind}</span>
                  <PixelSelect
                    value={kind}
                    labelledBy="mk-contact-kind"
                    onChange={setKind}
                    options={CONTACT_KINDS.map((k) => ({ value: k, label: tt.market.contactKinds[k] }))}
                  />
                </div>
                <label className="field">
                  <span className="field-label mk-sub">{t.contactValue}</span>
                  <input
                    value={contact}
                    maxLength={LIMITS.contact}
                    onChange={(e) => setContact(e.target.value)}
                    placeholder={tt.market.contactPlaceholders[kind]}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
              </div>
              {err('contact')}
              <span className="hint">{t.contactNote(p.nickname)}</span>
            </fieldset>

            <p className="hint mk-note">{t.noPrice}</p>

            <MarketProblem error={sending.error} />
            <div className="actions">
              <button className="cta cta-inline" type="submit" disabled={sending.busy}>
                {sending.busy ? t.sending : t.send}
              </button>
              {tried && !ok && <span className="field-error">{t.fixFields}</span>}
            </div>
          </form>
        </section>

        <aside className="summary summary-after mk-aside" aria-label={t.asking}>
          <div className="mk-who mk-who-sm">
            <Avatar id={p.profile_id} avatar={p.avatar} size="sm" />
            <span className="mk-card-name">{p.nickname}</span>
          </div>
          <p className="from">{t.asking}</p>
          <p className="summary-title">{service ? service.title : t.anything}</p>
          {service && (
            <>
              <p className="price mk-price">
                <span className="mk-from-word">{tt.market.fromWord}</span>
                <span className="amount amount-sm">{service.price_from_usdc}</span>
                <span className="currency">USDC</span>
              </p>
              <p className="hint">{tt.market.usually(service.delivery_days)}</p>
              {service.description && <p className="hint mk-service-desc">{service.description}</p>}
            </>
          )}
        </aside>
      </div>
    </main>
  );
}

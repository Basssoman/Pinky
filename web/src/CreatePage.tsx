// Creator: make a deal → save the creator key (right at creation) → send the
// client link; the link can be cancelled while nobody accepted it.
// Limits match the server: title ≤ 200, description ≤ 5000, revisions 0..100,
// 1..2,000 USDC, delivery 1..90 days, review 3..90 days,
// link valid ≤ 7 days, and never longer than the contract allows
// (the test contract allows 1 hour). "The work" + "You get" are sent as one description.
// The form only collects the terms; sealing and sending them is lib/flows.ts createDeal.
import { useEffect, useState, type ReactNode } from 'react';
import { DAY, fmtDate, days, span } from './deal';
import { tr, useT } from './i18n';
import { rich } from './i18n/rich';
import { Steps } from './Steps';
import { LINK_DAYS, LINK_MAX, linkChoices, type Limits, type LinkChoice } from './lib/limits';
import type { LocalDeal } from './lib/local';
import { TelegramNotify } from './TelegramNotify';
import { Chips, Problem, useRun } from './ui';

const FEE = 0.03;

export type Terms = {
  title: string;
  work: string;
  gets: string;
  revisions: string;
  price: string;
  deliveryDays: string;
  reviewDays: string;
  linkDays: LinkChoice;
};

const EMPTY: Terms = {
  title: '',
  work: '',
  gets: '',
  revisions: '2',
  price: '',
  deliveryDays: '14',
  reviewDays: '3',
  linkDays: '3',
};

// The form is kept in this browser while it is filled in, so leaving the page loses nothing.
const DRAFT = 'kept.draft';

export function loadDraft(): Partial<Terms> | null {
  try {
    const d = JSON.parse(window.localStorage.getItem(DRAFT) ?? 'null') as Record<string, unknown> | null;
    if (!d || typeof d !== 'object') return null;
    const out: Partial<Terms> = {};
    for (const k of Object.keys(EMPTY) as (keyof Terms)[]) if (typeof d[k] === 'string') (out as Record<string, string>)[k] = d[k] as string;
    if (out.linkDays && !([...LINK_DAYS, LINK_MAX] as string[]).includes(out.linkDays)) delete out.linkDays;
    return out;
  } catch {
    return null;
  }
}

export function saveDraft(t: Terms): void {
  try {
    if (t.title.trim() || t.work.trim() || t.gets.trim() || t.price.trim()) window.localStorage.setItem(DRAFT, JSON.stringify(t));
  } catch {
    /* blocked storage: the form still works */
  }
}

/** The deal was made from the draft: it is gone, so the same draft never makes a second deal. */
export function clearDraft(): void {
  try {
    window.localStorage.removeItem(DRAFT);
  } catch {
    /* nothing to clean */
  }
}

function intIn(v: string, min: number, max: number) {
  if (!/^\d+$/.test(v.trim())) return false;
  const n = Number(v);
  return n >= min && n <= max;
}

function problems(t: Terms) {
  const e = tr().create;
  const p: Partial<Record<keyof Terms, string>> = {};
  if (!t.title.trim()) p.title = e.errTitle;
  else if (t.title.length > 200) p.title = e.errTitleLong;
  if (!t.work.trim()) p.work = e.errWork;
  if (t.work.length + t.gets.length > 4800) p.work = e.errWorkLong;
  if (!intIn(t.revisions, 0, 100)) p.revisions = e.errRevisions;
  const price = Number(t.price);
  if (!/^\d+(\.\d{1,2})?$/.test(t.price.trim()) || price < 1 || price > 2000) p.price = e.errPrice;
  if (!intIn(t.deliveryDays, 1, 90)) p.deliveryDays = e.errDelivery;
  if (!intIn(t.reviewDays, 3, 90)) p.reviewDays = e.errReview;
  return p;
}

/** Step 1 of "New deal": the form. `onCreate` seals the terms and moves on (or rejects with the reason). */
export function CreatePage(props: {
  onCreate: (terms: Terms) => Promise<void> | void;
  /** Starting values, e.g. from a marketplace request (the creator still sets the final ones). */
  initial?: Partial<Terms>;
  /** A line above the form, e.g. "From a request". */
  note?: ReactNode;
  /** Every change of the form (to keep the draft). */
  onDraft?: (t: Terms) => void;
  /** The contract's limits; undefined = not known (all choices, no pay time shown). */
  limits?: Limits;
}) {
  const [terms, setTermsState] = useState<Terms>(() => ({ ...EMPTY, ...props.initial }));
  const setTerms = (t: Terms) => {
    setTermsState(t);
    props.onDraft?.(t);
  };
  // A link choice the contract does not allow (an old draft, the default before the limits
  // were read) becomes the nicest allowed one.
  const { options, preferred } = linkChoices(props.limits);
  const linkOk = options.includes(terms.linkDays);
  useEffect(() => {
    if (!linkOk) setTermsState((t) => ({ ...t, linkDays: preferred }));
  }, [linkOk, preferred]);
  return (
    <>
      <Steps current={0} flow="create" />
      <main className="deal">
        <TermsForm
          terms={terms}
          setTerms={setTerms}
          onCreate={() => props.onCreate(linkOk ? terms : { ...terms, linkDays: preferred })}
          note={props.note}
          limits={props.limits}
        />
        <Preview terms={terms} />
      </main>
    </>
  );
}

function TermsForm(props: {
  terms: Terms;
  setTerms: (t: Terms) => void;
  onCreate: () => Promise<void> | void;
  note?: ReactNode;
  limits?: Limits;
}) {
  const { terms: t } = props;
  const { options: linkOptions, preferred } = linkChoices(props.limits);
  const maxLinkMs = props.limits?.maxLinkMs ?? null;
  const payWithinMs = props.limits?.payWithinMs ?? null;
  const c = useT().create;
  const [tried, setTried] = useState(false);
  const creating = useRun();
  const p = problems(t);
  const ok = Object.keys(p).length === 0;
  const set = (k: keyof Terms) => (v: string) => props.setTerms({ ...t, [k]: v });
  const err = (k: keyof Terms) => (tried && p[k] ? <span className="field-error">{p[k]}</span> : null);

  const price = Number(t.price);
  const net = price >= 1 ? (price * (1 - FEE)).toFixed(2) : null;

  return (
    <section className="terms screen" aria-labelledby="create-title">
      <h1 id="create-title">{c.title}</h1>
      <p className="lead">{c.lead}</p>
      {props.note}

      <form
        className="pay-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          setTried(true);
          if (ok) void creating.run(props.onCreate);
        }}
      >
        <label className="field">
          <span className="field-label">{c.jobName}</span>
          <input value={t.title} onChange={(e) => set('title')(e.target.value)} maxLength={200} placeholder={c.jobNamePlaceholder} />
          {err('title')}
        </label>

        <label className="field">
          <span className="field-label">{c.work}</span>
          <textarea rows={4} value={t.work} onChange={(e) => set('work')(e.target.value)} placeholder={c.workPlaceholder} />
          {err('work')}
        </label>

        <label className="field">
          <span className="field-label">{c.gets}</span>
          <textarea rows={2} value={t.gets} onChange={(e) => set('gets')(e.target.value)} placeholder={c.getsPlaceholder} />
          <span className="hint">{c.getsHint}</span>
        </label>

        <div className="field-row">
          <label className="field">
            <span className="field-label">{c.revisions}</span>
            <input inputMode="numeric" value={t.revisions} onChange={(e) => set('revisions')(e.target.value)} />
            {err('revisions')}
          </label>
          <label className="field">
            <span className="field-label">{c.price}</span>
            <input inputMode="decimal" value={t.price} onChange={(e) => set('price')(e.target.value)} placeholder="300" />
            {err('price')}
          </label>
        </div>
        {net && !p.price && (
          <p className="hint fee-note">{rich(c.feeNote, { net: <strong>{net} USDC</strong> })}</p>
        )}

        <div className="field-row">
          <label className="field">
            <span className="field-label">{c.deliveryDays}</span>
            <input inputMode="numeric" value={t.deliveryDays} onChange={(e) => set('deliveryDays')(e.target.value)} />
            {err('deliveryDays')}
          </label>
          <label className="field">
            <span className="field-label">{c.reviewDays}</span>
            <input inputMode="numeric" value={t.reviewDays} onChange={(e) => set('reviewDays')(e.target.value)} />
            {err('reviewDays')}
          </label>
        </div>

        <Chips
          label={c.linkWorks}
          options={linkOptions}
          value={linkOptions.includes(t.linkDays) ? t.linkDays : preferred}
          onChange={set('linkDays')}
          name={(d) => (d === LINK_MAX ? span(maxLinkMs ?? DAY) : days(Number(d)))}
        />
        <span className="hint chips-hint">
          {c.linkHint}
          {payWithinMs !== null && payWithinMs > 0 && ` ${c.payWithin(payWithinMs)}`}
        </span>

        <Problem error={creating.error} />
        <div className="actions">
          <button className="cta cta-inline" type="submit" disabled={creating.busy}>
            {creating.busy ? c.sealing : c.submit}
          </button>
          {tried && !ok && <span className="field-error">{c.fixFields}</span>}
        </div>
      </form>
    </section>
  );
}

/** Right column: how the client will see it. */
export function Preview({ terms: t }: { terms: Terms }) {
  const tt = useT();
  const c = tt.create;
  const price = problems(t).price ? '—' : t.price;
  return (
    <aside className="summary summary-after" aria-label={c.clientSeesLabel}>
      <p className="from">{c.clientSees}</p>
      <p className="summary-title">{t.title.trim() || c.jobName}</p>
      <p className="price">
        <span className="amount amount-sm">{price}</span>
        <span className="currency">USDC</span>
      </p>
      <dl className="summary-facts">
        <div>
          <dt>{c.delivery}</dt>
          <dd>{intIn(t.deliveryDays, 1, 90) ? tt.units.afterPayment(Number(t.deliveryDays) * DAY) : '—'}</dd>
        </div>
        <div>
          <dt>{c.review}</dt>
          <dd>{intIn(t.reviewDays, 3, 90) ? days(Number(t.reviewDays)) : '—'}</dd>
        </div>
        <div>
          <dt>{c.revisionsShort}</dt>
          <dd>{intIn(t.revisions, 0, 100) ? t.revisions : '—'}</dd>
        </div>
      </dl>
    </aside>
  );
}

/** Step 3: the client link, while nobody accepted it yet. The link can be cancelled. */
export function Share(props: {
  link: string;
  expires: Date;
  /** Short code of the creator's key; the client sees the same one on the deal page. */
  code: string;
  cancelled: boolean;
  onCancel: () => Promise<void> | void;
  /** The creator's deal (real pages): Telegram notifications are offered here too. */
  own?: Pick<LocalDeal, 'role' | 'handle' | 'seed' | 'token'>;
}) {
  const cancelling = useRun();
  const tt = useT();
  const c = tt.create;
  const f = tt.flow;
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(props.link);
      setCopied(true);
    } catch {
      setCopied(false); // clipboard blocked: the link is shown to copy by hand
    }
  };

  if (props.cancelled) {
    return (
      <section className="terms screen" aria-labelledby="share-title">
        <h1 id="share-title">{c.cancelledTitle}</h1>
        <p className="lead">{c.cancelledLead}</p>
      </section>
    );
  }
  if (props.expires.getTime() <= Date.now()) {
    return (
      <section className="terms screen" aria-labelledby="share-title">
        <h1 id="share-title">{c.stoppedTitle}</h1>
        <p className="lead">{c.stoppedLead(fmtDate(props.expires))}</p>
      </section>
    );
  }

  return (
    <section className="terms screen" aria-labelledby="share-title">
      <h1 id="share-title">{c.shareTitle}</h1>
      <p className="lead">{c.shareLead}</p>

      <div className="panel">
        <p className="field-label">{c.clientLink}</p>
        <div className="address">
          <code>{props.link}</code>
        </div>
        <div className="actions">
          <button className="cta cta-inline share-copy" type="button" onClick={copy}>
            {copied ? `✓ ${f.shareCopied}` : f.shareCopy}
          </button>
        </div>
        <p className="hint">{c.worksUntil(fmtDate(props.expires))}</p>
        <p className="hint">{rich(c.yourCode, { code: <span className="code">{props.code}</span> })}</p>
      </div>

      <div className="panel">
        <p className="panel-title">{f.nextTitle}</p>
        <ol className="next-list">
          <li>{f.next1}</li>
          <li>{f.next2}</li>
          <li>{f.next3}</li>
        </ol>
      </div>

      {props.own && <TelegramNotify local={props.own} />}

      <div className="hero hero-wait" role="status">
        <span className="hero-mark" aria-hidden="true" />
        <div>
          <p className="hero-big">{c.waiting}</p>
          <p className="hero-line">{c.waitingLine}</p>
        </div>
      </div>

      <Problem error={cancelling.error} />
      <div className="actions">
        <button className="btn-link btn-inline" type="button" disabled={cancelling.busy} onClick={() => cancelling.run(props.onCancel)}>
          {cancelling.busy ? c.cancelling : c.cancelLink}
        </button>
      </div>
    </section>
  );
}

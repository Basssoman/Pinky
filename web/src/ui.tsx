// Small shared UI pieces.
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { tr, useT, type Dict } from './i18n';
import { ApiError, type ActCall } from './lib/api';
import { ChainError } from './lib/chain';
import { ActionError, DealError } from './lib/flows';
import { QuoteError } from './lib/quote';
import { addressHint } from './lib/tokens';

export function Chips<T extends string>(props: {
  label: string;
  options: readonly T[];
  value: T;
  onChange: (v: T) => void;
  name?: (v: T) => string;
}) {
  const id = `chips-${useId()}`;
  return (
    <div className="field">
      <span className="field-label" id={id}>
        {props.label}
      </span>
      <div className="chips" role="radiogroup" aria-labelledby={id}>
        {props.options.map((o) => (
          <button
            key={o}
            type="button"
            role="radio"
            aria-checked={props.value === o}
            className="chip"
            onClick={() => props.onChange(o)}
          >
            {props.name ? props.name(o) : o}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Our own "are you sure?" box in the site style, instead of the system
 * `window.confirm()`. `confirm(question, yes)` resolves
 * true on "yes"; Escape, "Go back" or a click outside the box resolve false.
 * Render `box` anywhere in the page.
 */
export function useConfirm() {
  const [ask, setAsk] = useState<{ text: string; yes: string; resolve: (ok: boolean) => void } | null>(null);
  const confirm = useCallback(
    (text: string, yes: string) => new Promise<boolean>((resolve) => setAsk({ text, yes, resolve })),
    [],
  );
  const done = (ok: boolean) => {
    ask?.resolve(ok);
    setAsk(null);
  };
  return { confirm, box: ask ? <ConfirmBox text={ask.text} yes={ask.yes} onDone={done} /> : null };
}

function ConfirmBox({ text, yes, onDone }: { text: string; yes: string; onDone: (ok: boolean) => void }) {
  const t = useT().ui;
  const ref = useRef<HTMLDialogElement>(null);
  const textId = useId();
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal(); // modal: focus stays inside, Escape closes, the page behind is inert
    return () => d?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="confirm"
      aria-labelledby={textId}
      onCancel={(e) => {
        e.preventDefault();
        onDone(false);
      }}
      onClick={(e) => e.target === ref.current && onDone(false)}
    >
      {/* the dialog itself has no padding, so a click on it (not on this box) is a click outside */}
      <div className="confirm-box">
        <p id={textId} className="confirm-text">
          {text}
        </p>
        <div className="confirm-actions">
          <button className="cta cta-inline" type="button" onClick={() => onDone(true)}>
            {yes}
          </button>
          <button className="btn-ghost" type="button" autoFocus onClick={() => onDone(false)}>
            {t.confirmBack}
          </button>
        </div>
      </div>
    </dialog>
  );
}

/** The current time, re-read every `everyMs` while the page is open. */
export function useNow(everyMs = 30_000, now: () => number = Date.now) {
  const [t, setT] = useState(now);
  useEffect(() => {
    setT(now());
    const id = window.setInterval(() => setT(now()), everyMs);
    return () => window.clearInterval(id);
  }, [everyMs, now]);
  return t;
}

/** Runs one async action at a time and keeps its "working" and "failed" state for the screen. */
export function useRun() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const running = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const run = useCallback(async (fn: () => Promise<unknown> | unknown) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      if (alive.current) setError(e);
    } finally {
      running.current = false;
      if (alive.current) setBusy(false);
    }
  }, []);
  return { run, busy, error, clear: () => setError(null) };
}

/** Placeholder for an address field: an address shape (`0x…`, `bc1…`) or, where it is words, in the chosen language. */
export function hintFor(networkCode: string): string {
  const t = tr().addressHint;
  const h = addressHint(networkCode);
  return h === 'Your Solana address' ? t.solana : h === 'UQ… or EQ…' ? t.ton : h === 'Your address' ? t.any : h;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The browser's own checks of a deal (lib/flows.ts DealError), in the chosen language. */
function dealMessage(m: string, t: Dict['errors']['deal']): string {
  const fixed: Record<string, string> = {
    'the offer is not readable': t.offerUnreadable,
    'the offer has the wrong fields': t.offerFields,
    'the offer has a bad creator key': t.offerCreatorKey,
    'the offer has a fee above 3%': t.offerFee,
    'the terms are not readable': t.termsUnreadable,
    'the terms do not match what the creator signed': t.termsMismatch,
    'the creator signature on the terms is not valid': t.termsSignature,
    'the deal on-chain has another creator key': t.chainCreatorKey,
    'the deal on-chain does not match the signed terms': t.chainMismatch,
    'this deal link is not known': t.notKnown,
    'the deal is not on-chain': t.notOnChain,
    'the key in this browser is not the creator key of this deal': t.notCreatorKey,
    'the client has not accepted this deal yet': t.notJoined,
    'the creator cancelled this link': t.linkCancelled,
    'this link was already used by someone else': t.linkUsed,
    'this link has expired': t.linkExpired,
    'this browser has no key for this deal': t.noKey,
    'this deal belongs to another key': t.otherKey,
    'this deal can no longer be paid': t.cantPay,
    'it is too late to agree on a split for this deal': t.tooLateSplit,
    'this proposal cannot be accepted from this browser': t.cantAcceptProposal,
    'a withdrawal is already on its way': t.withdrawOnWay,
    'there is nothing to withdraw': t.nothingToWithdraw,
  };
  if (m in fixed) return fixed[m];
  const field = /^the offer has a bad (\w+)$/.exec(m);
  if (field) return t.offerBadField(field[1]);
  const role = /^this browser does not hold the (client|creator) key of this deal$/.exec(m);
  if (role) return t.noRoleKey(role[1] as 'client' | 'creator');
  return m;
}

/** Turns any failure into one plain sentence for the person, in the chosen language. */
export function explain(e: unknown): string {
  const t = tr().errors;
  if (e instanceof QuoteError) {
    switch (e.code) {
      case 'signature':
        return t.quoteSignature;
      case 'mismatch':
        return t.quoteMismatch;
      case 'stale':
        return t.quoteStale;
      case 'too_late':
        return t.quoteTooLate;
      case 'dry':
        return t.quoteDry;
    }
  }
  if (e instanceof DealError) return `${cap(dealMessage(e.message, t.deal))}.`;
  if (e instanceof ChainError) return t.chain;
  if (e instanceof ActionError || e instanceof ApiError) {
    const m = e.message;
    switch (e.code) {
      case 'unreachable':
        return t.unreachable;
      case 'rate_limited':
        return t.rateLimited;
      case 'daily_cap':
        return t.dailyCap;
      case 'low_balance':
      case 'relayer_out_of_funds':
        return t.paused;
      case 'relayer_timeout':
        return t.relayerTimeout;
      case 'deadline_passed':
        return t.deadlinePassed;
      case 'oneclick_error':
      case 'unsupported_quote':
        return t.swapRefused;
      case 'too_late':
        return t.payTooLate;
      case 'cancel_pending':
        return t.cancelPending;
      case 'nothing_to_withdraw':
        return t.nothingToWithdraw;
      case 'withdraw_in_progress':
        return t.withdrawInProgress;
      case 'duplicate':
        return t.duplicate;
      case 'already_joined':
        return t.alreadyJoined;
      case 'amount_too_small':
        return t.amountTooSmall;
      case 'offer_expired':
        return `${cap(t.deal.linkExpired)}.`;
      case 'revoked':
        return `${cap(t.deal.linkCancelled)}.`;
      case 'not_joined':
        return `${cap(t.deal.notJoined)}.`;
      case 'unknown_deal':
      case 'not_found':
        return `${cap(t.deal.notKnown)}.`;
      case 'wrong_key':
      case 'invalid_signature':
        return t.wrongKey;
      case 'stale_request':
      case 'signature_expired':
      case 'replayed_request':
        return t.outOfDate;
      case 'too_early':
        return t.tooEarly;
      case 'deal_live':
        return t.dealLive;
      case 'join_in_progress':
        return t.duplicate;
    }
    if (e.code === 'error' && /^HTTP 5\d\d$/.test(m)) return t.unreachable;
    // The contract's own words (relayed by the server, codes precheck_failed / contract_rejected).
    if (/delivery deadline has passed/.test(m)) return t.deliveryPassed;
    if (/review period is over/.test(m)) return t.reviewOver;
    if (/may still be paying|getting a payment address/.test(m)) return t.mayBePaying;
    if (/destination account does not exist/.test(m)) return t.noAccount;
    if (/timer is over|signature expired/.test(m)) return t.tooLateReload;
    // Never the server's raw English: one translated line per kind of refusal.
    if (['wrong_state', 'precheck_failed', 'contract_rejected', 'chain_mismatch', 'deal_over', 'note_locked'].includes(e.code)) return t.movedOn;
    if (['bad_request', 'bad_offer', 'bad_fee', 'terms_mismatch', 'bad_signature_encoding', 'offer_taken', 'handle_taken'].includes(e.code)) return t.refused;
    if (e instanceof ApiError && e.status >= 400 && e.status < 500) return t.refused;
    return t.didntGoThrough;
  }
  return t.generic;
}

export function CopyButton({ text, label }: { text: string; label?: string }) {
  const t = useT().ui;
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false); // clipboard blocked: the text is still shown to copy by hand
    }
  };
  return (
    <button className="btn-ghost btn-sm" type="button" onClick={copy}>
      {copied ? t.copied : (label ?? t.copy)}
    </button>
  );
}

/**
 * "Server not responding? Send it yourself": the action
 * is already signed by the deal key, and the contract takes it from any NEAR
 * account, so the person can send it without us.
 */
export function SendYourself({ call, network }: { call: ActCall; network: string }) {
  const t = useT().ui;
  const args = JSON.stringify(call.args);
  const deposit = call.deposit === '0' ? '0 NEAR' : '0.00225 NEAR';
  const gas = call.gas === '150000000000000' ? '150 Tgas' : '30 Tgas';
  const command = `near contract call-function as-transaction ${call.contract_id} ${call.method_name} json-args '${args}' prepaid-gas '${gas}' attached-deposit '${deposit}' sign-as YOUR-ACCOUNT.near network-config ${network} sign-with-keychain send`;
  return (
    <div className="panel">
      <p className="panel-title">{t.selfTitle}</p>
      <p className="hint">{t.selfHint}</p>
      <p className="field-label">{t.contract}</p>
      <div className="address">
        <code>{call.contract_id}</code>
        <CopyButton text={call.contract_id} />
      </div>
      <p className="field-label">{t.method(call.method_name)}</p>
      <div className="address">
        <code>{args}</code>
        <CopyButton text={args} />
      </div>
      <p className="field-label">{t.command}</p>
      <div className="address">
        <code>{command}</code>
        <CopyButton text={command} />
      </div>
      <p className="hint">{t.gasNote(gas, deposit)}</p>
    </div>
  );
}

/** One failed action: what happened, and the way around our server when that helps. */
export function Problem({ error, network = 'mainnet' }: { error: unknown; network?: string }) {
  useT(); // redraw the sentence when the language changes
  if (!error) return null;
  return (
    <>
      <p className="alert alert-inline" role="alert">
        {explain(error)}
      </p>
      {error instanceof ActionError && error.serverDown && <SendYourself call={error.call} network={network} />}
    </>
  );
}

/** Full-page message for a deal that can't be shown (not found, changed, used, cancelled). */
export function Notice(props: { title: string; lines: string[]; tone?: 'warn' | 'plain'; children?: ReactNode }) {
  // The tab says what went wrong, not just "Deal". A page that
  // sets its own title in an effect still wins (parent effects run after this one).
  useEffect(() => {
    document.title = `${props.title} — Pinky`;
  }, [props.title]);
  return (
    <main className={props.tone === 'warn' ? 'keylink keylink-warn' : 'keylink'} aria-labelledby="notice-title">
      <h1 id="notice-title">{props.title}</h1>
      {props.lines.map((l) => (
        <p key={l} className="lead">
          {l}
        </p>
      ))}
      {props.children}
    </main>
  );
}

// "Your deal": the page both sides open with their saved key after payment.
// Shows where the money is, the timers, and only the actions this key can take.
// This file only draws and collects input: real deals get everything from the
// chain and the signed terms (real/StatusReal.tsx), the example deal from demo/.
// Texts: i18n/ `deal`.
import { useState, type ReactNode } from 'react';
import { afterFee, fmtDate, left, revisionsText, splitOf, usd, type DealInfo } from './deal';
import { tr, useT } from './i18n';
import { rich } from './i18n/rich';
import type { Coin } from './lib/tokens';
import { Settle } from './Settle';
import { Problem, useRun } from './ui';
import { Withdraw, type WithdrawChoice } from './Withdraw';

export type Role = 'client' | 'creator';
export type DealState =
  | 'unpaid'
  | 'cancelled'
  | 'expired'
  | 'funded'
  | 'late'
  | 'delivered'
  | 'disputed'
  | 'settled'
  | 'released'
  | 'refunded';

/** How a closed deal ended (for the wording). */
export type Ending = 'accepted' | 'auto' | 'arbiter' | 'agreed' | 'timeout' | 'by_creator' | 'late' | null;

export interface StatusDates {
  paidAt: Date | null;
  deliverBy: Date | null;
  deliveredAt: Date | null;
  reviewEnd: Date | null;
  /** End of the dispute time (then 50/50). */
  splitAt: Date | null;
  payBy: Date | null;
}

export interface DisputeReason {
  point: string;
  pointText: string;
  text: string;
}

export interface StatusView {
  info: DealInfo;
  role: Role;
  state: DealState;
  d: StatusDates;
  ending: Ending;
  /** Creator's share in percent when the money was split. */
  splitPct: number;
  /** What each side got when the deal closed (USDC base units). */
  creatorGot: bigint;
  clientGot: bigint;
  /** This key's money right now, from the chain: withdrawable, on its way, already sent. */
  mine: { payout: bigint; pending: boolean; withdrawn: bigint };
  /** A timer ran out and anyone may finish the deal. */
  timerOver: boolean;
  /** The other side's open split proposal. */
  incoming: { pct: number; expires: Date } | null;
  /** This side's open split proposal. */
  myProposal: { pct: number; expires: Date } | null;
  /** The delivered files link: undefined = still loading, null = none readable. */
  delivery: { link: string } | null | undefined;
  dispute: { pointLabel: string; text: string } | null | undefined;
  /** Coins a payout can go to; null while loading. */
  coins: Coin[] | null;
  /** Current time (ms), on the chain's clock. */
  now: number;
  /** Review stars after a paid deal: only where reviews exist. */
  showReview: boolean;
  /** `near` CLI network for the "send it yourself" command. */
  network?: string;
}

export interface StatusActions {
  onPay?: () => void;
  onDeliver: (link: string, files: File[], onProgress: (done: number, total: number) => void) => Promise<void> | void;
  onCheckFiles: (files: File[], onProgress: (done: number, total: number) => void) => Promise<boolean> | boolean;
  onAccept: () => Promise<void> | void;
  /** `splitPct` = the creator's share the client proposes with the dispute, or null. */
  onDispute: (reason: DisputeReason, splitPct: number | null) => Promise<void> | void;
  onRefund: () => Promise<void> | void;
  onCancel: () => Promise<void> | void;
  onPropose: (creatorPct: number) => Promise<void> | void;
  onRevokeProposal: () => Promise<void> | void;
  onAcceptProposal: () => Promise<void> | void;
  onFinishTimer: () => Promise<void> | void;
  onWithdraw: (choice: WithdrawChoice) => Promise<void> | void;
}

const LIVE: DealState[] = ['funded', 'late', 'delivered', 'disputed'];

function termsPoints(info: DealInfo) {
  const t = tr();
  return [
    { id: 'work', label: t.points.work, text: info.task },
    ...(info.deliverable ? [{ id: 'get', label: t.points.get, text: info.deliverable }] : []),
    { id: 'revisions', label: t.points.revisions, text: revisionsText(info.revisions) },
    { id: 'deadline', label: t.points.deadline, text: t.units.afterPayment(info.deliveryMs) },
  ];
}

const when = (d: Date | null, now: number) => (d ? fmtDate(d, now) : tr().units.theDeadline);

/** `review`: the marketplace review block (real deals from a request); the example deal uses `showReview`. */
export function DealStatus({ view: v, actions: a, review }: { view: StatusView; actions: StatusActions; review?: ReactNode }) {
  const { info, role, state } = v;
  const t = useT().deal;
  const [panel, setPanel] = useState<'none' | 'settle' | 'dispute'>('none');

  const stage = state === 'funded' || state === 'late' ? 'funded' : state === 'delivered' ? 'delivered' : 'disputed';
  const canSettle =
    state === 'funded' || state === 'late' || state === 'disputed' || (state === 'delivered' && role === 'creator');
  const unfunded = role === 'client' && v.mine.payout > 0n && (state === 'unpaid' || LIVE.includes(state));
  const closed = !LIVE.includes(state) && state !== 'unpaid';

  return (
    <main className="deal">
      <section className="terms screen" aria-labelledby="deal-status-title">
        <p className="from">
          {role === 'client' && !info.creator
            ? rich(t.withCode, { code: <span className="code">{info.creatorCode}</span> })
            : role === 'client'
              ? rich(t.with, {
                  nick: (
                    <a href={info.creator!.profileUrl} className="nick">
                      @{info.creator!.nick}
                    </a>
                  ),
                })
              : t.asCreator}
        </p>
        <h1 id="deal-status-title">{info.title}</h1>

        <Hero v={v} />

        {v.timerOver && (state === 'unpaid' || state === 'delivered' || state === 'disputed') && (
          <TimerOver state={state} onFinish={a.onFinishTimer} network={v.network} />
        )}

        {role === 'creator' && state === 'unpaid' && !info.creator && (
          <div className="panel code-check">
            <p className="panel-title">{t.codesTitle}</p>
            <dl className="split-result">
              <div>
                <dt>{t.yourCode}</dt>
                <dd className="code">{info.creatorCode}</dd>
              </div>
              <div>
                <dt>{t.clientsCode}</dt>
                <dd className="code">{info.clientCode ?? '—'}</dd>
              </div>
            </dl>
            <p className="hint">{t.codesHint}</p>
          </div>
        )}

        {unfunded && (
          <div className="notice" role="note">
            <p className="notice-title">{t.leftoverTitle(usd(v.mine.payout))}</p>
            <p>{state === 'unpaid' ? t.leftoverUnpaid : t.leftoverLive}</p>
          </div>
        )}
        {unfunded && <Withdraw amount={usd(v.mine.payout)} coins={v.coins} onWithdraw={a.onWithdraw} network={v.network} />}
        {role === 'client' && v.mine.pending && !closed && <Withdraw amount="" coins={v.coins} pending onWithdraw={a.onWithdraw} />}

        {v.incoming && LIVE.includes(state) && (
          <Incoming
            v={v}
            onAccept={a.onAcceptProposal}
            onCounter={() => setPanel(role === 'client' && state === 'delivered' ? 'dispute' : 'settle')}
          />
        )}

        {role === 'creator' && state === 'funded' && <Deliver v={v} onDeliver={a.onDeliver} />}
        {role === 'client' && (state === 'delivered' || state === 'disputed') && <Delivered v={v} onCheck={a.onCheckFiles} />}

        <Actions v={v} a={a} onSettle={() => setPanel('settle')} onDispute={() => setPanel('dispute')} />

        {((panel === 'settle' && canSettle) || (v.myProposal && LIVE.includes(state))) && (
          <Settle
            info={info}
            role={role}
            stage={stage}
            deadline={v.d.deliverBy}
            mine={v.myProposal}
            onPropose={a.onPropose}
            onRevoke={a.onRevokeProposal}
            onClose={() => setPanel('none')}
            network={v.network}
          />
        )}
        {panel === 'dispute' && state === 'delivered' && role === 'client' && (
          <DisputeForm v={v} onClose={() => setPanel('none')} onSend={a.onDispute} />
        )}

        {closed && v.mine.payout > 0n && (
          <Withdraw amount={usd(v.mine.payout)} coins={v.coins} onWithdraw={a.onWithdraw} network={v.network} />
        )}
        {closed && v.mine.payout === 0n && v.mine.pending && <Withdraw amount="" coins={v.coins} pending onWithdraw={a.onWithdraw} />}
        {closed && v.mine.payout === 0n && !v.mine.pending && v.mine.withdrawn > 0n && (
          <div className="panel">
            <p className="panel-title">{t.withdrawn}</p>
            <p className="hint">{t.withdrawnText(usd(v.mine.withdrawn))}</p>
          </div>
        )}
        {v.showReview && role === 'client' && state === 'released' && <ReviewPrompt />}
        {review}
      </section>

      <Timeline v={v} />
    </main>
  );
}

/** A timer ran out: anyone may finish the deal (`POST …/timeout`). */
function TimerOver(props: { state: DealState; onFinish: () => Promise<void> | void; network?: string }) {
  const finishing = useRun();
  const t = useT().deal;
  const text =
    props.state === 'delivered'
      ? { title: t.reviewOver, line: t.reviewOverLine, btn: t.reviewOverBtn }
      : props.state === 'disputed'
        ? { title: t.disputeOver, line: t.disputeOverLine, btn: t.disputeOverBtn }
        : { title: t.payOver, line: t.payOverLine, btn: t.payOverBtn };
  return (
    <div className="panel panel-offer">
      <p className="panel-title">{text.title}</p>
      <p className="hint">
        {text.line} {t.anyoneCanFinish}
      </p>
      <Problem error={finishing.error} network={props.network} />
      <div className="actions">
        <button className="cta cta-inline" type="button" disabled={finishing.busy} onClick={() => finishing.run(props.onFinish)}>
          {finishing.busy ? t.finishing : text.btn}
        </button>
      </div>
    </div>
  );
}

function Hero({ v }: { v: StatusView }) {
  const { info, role, state, d, now } = v;
  const t = useT().deal;
  const until = (date: Date | null) => (date ? t.until(fmtDate(date, now), left(date, now)) : tr().units.theDeadline);

  let tone: 'safe' | 'wait' | 'warn' = 'safe';
  let big = '';
  let lines: string[] = [];

  if (state === 'unpaid') {
    tone = 'warn';
    big = role === 'creator' ? t.noMoneyCreator : t.notPaid;
    lines = role === 'creator' ? [t.noFilesYet] : [d.payBy ? t.payBy(until(d.payBy)) : t.payNoDate];
  } else if (state === 'funded') {
    big = role === 'creator' ? t.moneyCreator : t.moneyClient;
    lines =
      role === 'creator'
        ? [t.deliverBy(until(d.deliverBy)), t.safeToStart]
        : [t.workDueBy(until(d.deliverBy)), t.linkAppears];
  } else if (state === 'late') {
    tone = 'warn';
    big = t.late;
    lines =
      role === 'client'
        ? [t.lateClient(when(d.deliverBy, now)), t.lateClientLine]
        : [t.lateCreator(when(d.deliverBy, now)), t.lateCreatorLine];
  } else if (state === 'delivered') {
    tone = 'wait';
    big = role === 'client' ? t.delivered : t.deliveredCreator;
    lines =
      role === 'client'
        ? [t.checkBy(until(d.reviewEnd)), t.checkByLine]
        : [t.reviewsUntil(until(d.reviewEnd)), t.reviewsUntilLine];
  } else if (state === 'disputed') {
    tone = 'warn';
    big = t.disputeOpen;
    lines = [
      ...(v.dispute
        ? [t.unmet(v.dispute.pointLabel, v.dispute.text)]
        : v.dispute === null
          ? [role === 'client' ? t.youOpened : t.clientOpened]
          : []),
      t.arbiterChecks(when(d.splitAt, now)),
    ];
  } else if (state === 'expired') {
    tone = 'warn';
    big = t.closedUnpaid;
    lines =
      role === 'client'
        ? [t.expiredClient(info.payWithinMs), t.expiredClientLine]
        : [t.expiredCreator(info.payWithinMs), t.expiredCreatorLine];
  } else if (state === 'cancelled') {
    tone = 'warn';
    big = t.cancelled;
    lines = role === 'client' ? [t.cancelledClient, t.arrivesBack] : [t.cancelledCreator];
  } else if (state === 'settled') {
    const pct = v.splitPct;
    const share = role === 'creator' ? t.shareCreator(pct) : t.shareClient(100 - pct);
    big =
      role === 'creator'
        ? t.yours(usd(v.creatorGot))
        : v.mine.payout > 0n
          ? t.yoursToWithdraw(usd(v.clientGot))
          : t.cameBack(usd(v.clientGot));
    lines = [
      v.ending === 'timeout' ? t.splitTimeout(share) : v.ending === 'arbiter' ? t.splitArbiter(share) : t.splitAgreed(share),
      t.closed,
    ];
  } else if (state === 'released') {
    big = role === 'creator' ? t.yours(usd(v.creatorGot)) : t.paidToCreator;
    const why =
      v.ending === 'auto'
        ? role === 'creator'
          ? t.whyAutoCreator
          : t.whyAutoClient
        : v.ending === 'arbiter'
          ? role === 'creator'
            ? t.whyArbiterCreator
            : t.whyArbiterClient
          : v.ending === 'agreed'
            ? t.whyAgreedFull
            : role === 'creator'
              ? t.whyAcceptedCreator
              : t.whyAcceptedClient;
    lines = [role === 'creator' ? `${why} ${t.feeTaken}` : `${why} ${t.done}`];
  } else if (state === 'refunded') {
    big = role === 'client' ? t.moneyBack : t.moneyWentBack;
    const why =
      v.ending === 'arbiter'
        ? role === 'client'
          ? t.refundArbiterClient
          : t.refundArbiterCreator
        : v.ending === 'agreed'
          ? t.refundAgreed
          : '';
    lines =
      role === 'client' ? [t.refundClient(why, usd(v.clientGot), v.mine.payout > 0n)] : [t.refundCreator(why)];
  }

  return (
    <div className={`hero hero-${tone}`} role="status">
      <span className="hero-mark" aria-hidden="true" />
      <div>
        <p className="hero-big">{big}</p>
        {lines.map((l) => (
          <p key={l} className="hero-line">
            {l}
          </p>
        ))}
      </div>
    </div>
  );
}

function Actions(props: { v: StatusView; a: StatusActions; onSettle: () => void; onDispute: () => void }) {
  const { role, state, network } = props.v;
  const t = useT().deal;
  const acting = useRun();
  const problem = <Problem error={acting.error} network={network} />;

  if (role === 'creator' && state === 'unpaid') {
    return (
      <>
        {problem}
        <div className="actions">
          <button className="btn-ghost" type="button" disabled={acting.busy} onClick={() => acting.run(props.a.onCancel)}>
            {acting.busy ? t.cancelling : t.cancelDeal}
          </button>
          <span className="hint">{t.onlyBeforePay}</span>
        </div>
      </>
    );
  }
  if (role === 'client' && state === 'unpaid' && props.a.onPay && !props.v.timerOver) {
    return (
      <div className="actions">
        <button className="cta cta-inline" type="button" onClick={props.a.onPay}>
          {t.payNow}
        </button>
      </div>
    );
  }
  if (role === 'client' && state === 'delivered') {
    return (
      <>
        {problem}
        <div className="actions">
          <button className="cta cta-inline" type="button" disabled={acting.busy} onClick={() => acting.run(props.a.onAccept)}>
            {acting.busy ? t.accepting : t.acceptWork}
          </button>
          <button className="btn-ghost" type="button" disabled={acting.busy} onClick={props.onDispute}>
            {t.openDispute}
          </button>
        </div>
      </>
    );
  }
  if (role === 'client' && state === 'late') {
    return (
      <>
        {problem}
        <div className="actions">
          <button className="cta cta-inline" type="button" disabled={acting.busy} onClick={() => acting.run(props.a.onRefund)}>
            {acting.busy ? t.gettingBack : t.getBack}
          </button>
          <button className="btn-ghost" type="button" onClick={props.onSettle}>
            {t.workItOut}
          </button>
        </div>
      </>
    );
  }
  if (state === 'funded' || state === 'late' || state === 'disputed' || (state === 'delivered' && role === 'creator')) {
    return (
      <>
        {problem}
        <div className="actions">
          <button className="btn-ghost" type="button" onClick={props.onSettle}>
            {t.workItOut}
          </button>
          {role === 'creator' && state === 'funded' && (
            <button className="btn-link btn-inline" type="button" disabled={acting.busy} onClick={() => acting.run(props.a.onRefund)}>
              {acting.busy ? t.refunding : t.refundClientBtn}
            </button>
          )}
        </div>
      </>
    );
  }
  return null;
}

const pct = (done: number, total: number) => (total > 0 ? Math.min(100, Math.floor((done / total) * 100)) : 100);

/** Creator: final files link + a fingerprint of the files. */
function Deliver({ v, onDeliver }: { v: StatusView; onDeliver: StatusActions['onDeliver'] }) {
  const [link, setLink] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [read, setRead] = useState<number | null>(null);
  const sending = useRun();
  const t = useT().deal;

  const go = () =>
    sending.run(async () => {
      setRead(0);
      try {
        await onDeliver(link.trim(), files, (done, total) => setRead(pct(done, total)));
      } finally {
        setRead(null);
      }
    });

  return (
    <div className="panel">
      <p className="panel-title">{t.deliverTitle}</p>
      <p className="hint">{t.deliverHint(when(v.d.deliverBy, v.now))}</p>
      <div className="pay-form">
        <label className="field">
          <span className="field-label">{t.filesLink}</span>
          <input
            type="url"
            value={link}
            onChange={(e) => setLink(e.target.value)}
            placeholder={t.filesLinkPlaceholder}
            autoComplete="off"
            spellCheck={false}
          />
          <span className="hint">{t.filesLinkHint}</span>
        </label>
        <label className="field">
          <span className="field-label">{t.sameFiles}</span>
          <input className="file-input" type="file" multiple onChange={(e) => setFiles(Array.from(e.target.files ?? []))} />
          <span className="hint">{files.length ? t.filesReady(files.length) : t.filesStay}</span>
        </label>
        <Problem error={sending.error} network={v.network} />
        <div className="actions">
          <button
            className="cta cta-inline"
            type="button"
            disabled={!/^https?:\/\/\S+\.\S+/.test(link.trim()) || files.length === 0 || sending.busy}
            onClick={go}
          >
            {sending.busy ? (read !== null && read < 100 ? t.reading(read) : t.delivering) : t.deliverBtn}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Client: the files link and the "do the files match" check. */
function Delivered({ v, onCheck }: { v: StatusView; onCheck: StatusActions['onCheckFiles'] }) {
  const [checked, setChecked] = useState<'none' | 'reading' | 'match' | 'other'>('none');
  const [read, setRead] = useState(0);
  const t = useT().deal;
  const link = v.delivery?.link ?? '';
  const openable = /^https?:\/\//i.test(link);

  const check = async (files: File[]) => {
    if (!files.length) return setChecked('none');
    setChecked('reading');
    setRead(0);
    try {
      setChecked((await onCheck(files, (done, total) => setRead(pct(done, total)))) ? 'match' : 'other');
    } catch {
      setChecked('none');
    }
  };

  return (
    <div className="panel">
      <p className="panel-title">{t.files}</p>
      {v.delivery === undefined ? (
        <p className="hint" role="status">
          {t.loadingLink}
        </p>
      ) : v.delivery === null ? (
        <p className="alert alert-inline" role="alert">
          {t.cantRead}
        </p>
      ) : (
        <>
          <div className="address">
            <code>{link}</code>
            {openable && (
              <a className="btn-ghost btn-sm" href={link} target="_blank" rel="noopener noreferrer">
                {t.open}
              </a>
            )}
          </div>
          {v.state === 'delivered' && v.d.reviewEnd ? (
            <p className="hint">{t.downloadBefore(fmtDate(v.d.reviewEnd, v.now))}</p>
          ) : (
            <p className="hint">{t.downloadNow}</p>
          )}

          <label className="dropzone">
            <input type="file" multiple onChange={(e) => void check(Array.from(e.target.files ?? []))} />
            {checked === 'match' ? (
              <span className="saved-note">{t.filesMatch}</span>
            ) : checked === 'other' ? (
              <span>{t.filesOther}</span>
            ) : checked === 'reading' ? (
              <span>{t.reading(read)}</span>
            ) : (
              <span>{t.chooseFiles}</span>
            )}
          </label>
        </>
      )}
    </div>
  );
}

/** Client dispute: pick the unmet point of the sealed terms, optional split. */
function DisputeForm({ v, onClose, onSend }: { v: StatusView; onClose: () => void; onSend: StatusActions['onDispute'] }) {
  const { info } = v;
  const t = useT().deal;
  const points = termsPoints(info);
  const [point, setPoint] = useState('');
  const [why, setWhy] = useState('');
  const [split, setSplit] = useState(false);
  const [creatorPct, setCreatorPct] = useState(50);
  const sending = useRun();

  const send = () =>
    sending.run(() => {
      const p = points.find((x) => x.id === point)!;
      return onSend({ point: p.id, pointText: `${p.label}: ${p.text}`, text: why.trim() }, split ? creatorPct : null);
    });

  return (
    <div className="panel">
      <div className="panel-head">
        <p className="panel-title">{t.disputeTitle}</p>
        <button className="btn-link btn-close" type="button" onClick={onClose}>
          {t.close}
        </button>
      </div>
      <p className="hint">{t.disputeHint}</p>

      <fieldset className="points">
        <legend className="field-label">{t.whatUnmet}</legend>
        {points.map((p) => (
          <label key={p.id} className={`point ${point === p.id ? 'point-on' : ''}`}>
            <input type="radio" name="point" value={p.id} checked={point === p.id} onChange={() => setPoint(p.id)} />
            <span>
              <strong>{p.label}</strong>
              <span>{p.text}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <label className="field">
        <span className="field-label">{t.whatWrong}</span>
        <textarea rows={3} value={why} maxLength={1500} onChange={(e) => setWhy(e.target.value)} />
      </label>

      <label className="check">
        <input type="checkbox" checked={split} onChange={(e) => setSplit(e.target.checked)} />
        {t.alsoSplit}
      </label>
      {split && (
        <label className="field split">
          <span className="field-label">{t.splitLine(creatorPct, usd(splitOf(info, creatorPct).clientBack))}</span>
          <input type="range" min={0} max={100} step={5} value={creatorPct} onChange={(e) => setCreatorPct(Number(e.target.value))} />
        </label>
      )}

      <p className="alert alert-inline">{t.disputeRule(info.disputeMs)}</p>

      <Problem error={sending.error} network={v.network} />
      <div className="actions">
        <button className="cta cta-inline" type="button" disabled={!point || why.trim().length < 10 || sending.busy} onClick={send}>
          {sending.busy ? t.opening : t.openDisputeBtn}
        </button>
      </div>
    </div>
  );
}

/** A split proposed by the other side with its own countdown.
 *  Accepting signs the same split and closes the deal; after delivery the client
 *  accepting the creator's proposal does NOT open a dispute, but a client
 *  counter-proposal does. */
function Incoming(props: { v: StatusView; onAccept: () => Promise<void> | void; onCounter: () => void }) {
  const { info, role, state, incoming, now } = props.v;
  const t = useT().deal;
  const accepting = useRun();
  if (!incoming) return null;
  const fromCreator = role === 'client';
  const counterOpensDispute = role === 'client' && state === 'delivered';
  const s = splitOf(info, incoming.pct);
  return (
    <div className="panel panel-offer">
      <p className="panel-title">
        {fromCreator ? t.proposes(info.creator ? `@${info.creator.nick}` : null) : t.clientProposes}
      </p>
      <dl className="split-result">
        <div>
          <dt>{fromCreator ? t.creatorGets : t.youGet}</dt>
          <dd>
            {usd(s.creatorNet)} USDC <span>{t.pctAfterFee(incoming.pct)}</span>
          </dd>
        </div>
        <div>
          <dt>{fromCreator ? t.youGetBack : t.clientGetsBack}</dt>
          <dd>{usd(s.clientBack)} USDC</dd>
        </div>
      </dl>
      <p className="hint">{t.answerBy(fmtDate(incoming.expires, now), left(incoming.expires, now))}</p>
      {counterOpensDispute && <p className="hint">{t.counterOpens}</p>}
      <Problem error={accepting.error} network={props.v.network} />
      <div className="actions">
        <button className="cta cta-inline" type="button" disabled={accepting.busy} onClick={() => accepting.run(props.onAccept)}>
          {accepting.busy ? t.signing : t.acceptSplit}
        </button>
        <button className="btn-ghost" type="button" disabled={accepting.busy} onClick={props.onCounter}>
          {t.proposeOther}
        </button>
      </div>
    </div>
  );
}

/** Client after a paid deal: review prompt + the "next time through a deal too" hint. */
function ReviewPrompt() {
  const [stars, setStars] = useState(0);
  const t = useT().deal;
  return (
    <div className="panel">
      <p className="panel-title">{t.reviewTitle}</p>
      <p className="hint">{t.reviewHint}</p>
      <div className="stars" role="radiogroup" aria-label={t.rating}>
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={stars === n}
            aria-label={t.stars(n)}
            className={n <= stars ? 'star star-on' : 'star'}
            onClick={() => setStars(n)}
          >
            ★
          </button>
        ))}
      </div>
      <p className="hint">{t.nextTime}</p>
    </div>
  );
}

/** Right column: the deal's path, where it is now. */
function Timeline({ v }: { v: StatusView }) {
  const { info, state, d, now } = v;
  const tt = useT();
  const t = tt.deal;
  const refunded = state === 'refunded';
  const settled = state === 'settled';
  const price = usd(info.amount);
  const day = (date: Date | null, fallback: string) => (date ? fmtDate(date, now) : fallback);

  if (state === 'expired' || state === 'cancelled') {
    return (
      <aside className="summary summary-after" aria-label={t.progress}>
        <p className="price">
          <span className="amount amount-sm">{price}</span>
          <span className="currency">USDC</span>
        </p>
        <ol className="path timeline">
          <li>
            <span className="dot" aria-hidden="true" />
            <strong>{t.notPaidStep}</strong>
            <span>{state === 'cancelled' ? t.cancelledByCreator : d.payBy ? t.payByWas(fmtDate(d.payBy, now)) : t.payRanOut}</span>
          </li>
          <li className="now">
            <span className="dot" aria-hidden="true" />
            <strong>{t.dealClosed}</strong>
            <span>{t.nothingToPay}</span>
          </li>
        </ol>
      </aside>
    );
  }
  const wasDelivered = d.deliveredAt !== null;
  const steps = [
    { title: t.paid, note: state === 'unpaid' ? t.notYet : day(d.paidAt, t.yes) },
    {
      // While the creator is still working, don't say "delivered".
      title: !wasDelivered && (state === 'funded' || state === 'late') ? t.workInProgress : t.workDelivered,
      note:
        state === 'late'
          ? t.dueMissed(day(d.deliverBy, t.earlier))
          : wasDelivered
            ? fmtDate(d.deliveredAt!, now)
            : state === 'refunded' || settled
              ? t.notDelivered
              : state === 'unpaid'
                ? tt.units.afterPayment(info.deliveryMs)
                : t.due(day(d.deliverBy, t.soon)),
    },
    {
      title:
        state === 'disputed'
          ? t.dispute
          : settled
            ? v.ending === 'timeout'
              ? t.disputeTimeOver
              : v.ending === 'arbiter'
                ? t.arbiterDecision
                : t.agreedSplit
            : t.review,
      note: settled
        ? v.ending === 'timeout'
          ? t.noDecision
          : v.ending === 'arbiter'
            ? t.arbiterSplit
            : t.bothSigned
        : state === 'disputed'
          ? t.splitIfNo(day(d.splitAt, tt.units.theDeadline))
          : state === 'delivered'
            ? t.untilDay(day(d.reviewEnd, tt.units.theDeadline))
            : tt.units.afterDelivery(info.reviewMs),
    },
    settled
      ? { title: t.splitTitle(v.splitPct, 100 - v.splitPct), note: t.backToClient(usd(v.clientGot)) }
      : refunded
        ? { title: t.moneyBackStep, note: t.amountUsdc(price) }
        : { title: t.creatorPaid, note: t.afterFee(usd(afterFee(info.amount, info.feeBps)), info.feeBps / 100) },
  ];
  const at: Record<DealState, number> = {
    unpaid: 0,
    cancelled: 0,
    expired: 0,
    funded: 1,
    late: 1,
    delivered: 2,
    disputed: 2,
    settled: 4,
    released: 4,
    refunded: 4,
  };
  const cur = at[state];

  return (
    <aside className="summary summary-after" aria-label={t.progress}>
      <p className="price">
        <span className="amount amount-sm">{price}</span>
        <span className="currency">USDC</span>
      </p>
      <ol className="path timeline">
        {steps.map((s, i) => (
          <li key={s.title} className={i < cur ? 'done' : i === cur ? 'now' : undefined}>
            <span className="dot" aria-hidden="true" />
            <strong>{s.title}</strong>
            <span>{s.note}</span>
          </li>
        ))}
      </ol>
    </aside>
  );
}

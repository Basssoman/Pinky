// "Work it out": both sides agree on a split without the arbiter.
// Rules shown here: talks don't stop the deadline; a proposal lives 24 h.
// After delivery the CLIENT proposes only inside the dispute form.
// A proposal is one side's signature over the split; with both signatures the
// contract settles the deal (lib/flows.ts proposeSettle / acceptSettle).
import { useState } from 'react';
import { fmtDate, left, splitOf, usd, type DealInfo } from './deal';
import { useT } from './i18n';
import { Problem, useRun } from './ui';

export function Settle(props: {
  info: DealInfo;
  role: 'client' | 'creator';
  stage: 'funded' | 'delivered' | 'disputed';
  /** The delivery deadline (shown while the work is not delivered yet). */
  deadline: Date | null;
  /** This side's open proposal, if any. */
  mine: { pct: number; expires: Date } | null;
  onPropose: (creatorPct: number) => Promise<void> | void;
  /** Takes the proposal back. */
  onRevoke: () => Promise<void> | void;
  onClose: () => void;
  network?: string;
}) {
  const { info, mine } = props;
  const [creatorPct, setCreatorPct] = useState(50);
  const sending = useRun();
  const t = useT().settle;
  const s = splitOf(info, creatorPct);

  if (mine) {
    return (
      <div className="panel">
        <p className="panel-title">{t.sent(mine.pct)}</p>
        <p className="hint">
          {t.sentHint(fmtDate(mine.expires), left(mine.expires))}
          {props.stage === 'funded' && props.deadline && t.stillDue(fmtDate(props.deadline))}
        </p>
        <Problem error={sending.error} network={props.network} />
        <div className="actions">
          <button className="btn-ghost" type="button" disabled={sending.busy} onClick={() => sending.run(props.onRevoke)}>
            {sending.busy ? t.takingBack : t.withdraw}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <p className="panel-title">{t.title}</p>
        <button className="btn-link btn-close" type="button" onClick={props.onClose}>
          {t.close}
        </button>
      </div>
      <p className="hint">{t.hint}</p>

      <label className="field split">
        <span className="field-label">{t.creatorGetsPct(creatorPct)}</span>
        <input
          type="range"
          min={0}
          max={100}
          step={5}
          value={creatorPct}
          onChange={(e) => setCreatorPct(Number(e.target.value))}
        />
      </label>

      <dl className="split-result">
        <div>
          <dt>{props.role === 'creator' ? t.youGet : t.creatorGets}</dt>
          <dd>
            {usd(s.creatorNet)} USDC <span>{t.afterFee}</span>
          </dd>
        </div>
        <div>
          <dt>{props.role === 'client' ? t.youGetBack : t.clientGetsBack}</dt>
          <dd>{usd(s.clientBack)} USDC</dd>
        </div>
      </dl>

      <Problem error={sending.error} network={props.network} />
      <div className="actions">
        <button className="cta cta-inline" type="button" disabled={sending.busy} onClick={() => sending.run(() => props.onPropose(creatorPct))}>
          {sending.busy ? t.sending : t.send}
        </button>
      </div>
    </div>
  );
}

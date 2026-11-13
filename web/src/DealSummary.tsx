// Compact reminder of what is being paid for, next to the key and payment steps.
import { dealDates, fmtDate, left, usd, type DealInfo } from './deal';
import { useT } from './i18n';
import { rich } from './i18n/rich';

export function DealSummary(props: {
  info: DealInfo;
  /** When the time to pay ends (known once the client accepted). */
  payBy: Date | null;
  paid: boolean;
  /** Real deals: the work-due date from the chain once paid. */
  deliverBy?: Date | null;
}) {
  const { info, payBy, paid } = props;
  const tt = useT();
  const t = tt.summary;
  const deliverBy = props.deliverBy ?? dealDates(info).deliverBy;

  return (
    <aside className="summary" aria-label={t.label}>
      <p className="from">
        {info.creator
          ? rich(t.with, {
              nick: (
                <a href={info.creator.profileUrl} className="nick">
                  @{info.creator.nick}
                </a>
              ),
            })
          : rich(t.withCode, { code: <span className="code">{info.creatorCode}</span> })}
      </p>
      <p className="summary-title">{info.title}</p>
      <p className="price">
        <span className="amount amount-sm">{usd(info.amount)}</span>
        <span className="currency">USDC</span>
      </p>
      <dl className="summary-facts">
        {paid ? (
          <>
            <div>
              <dt>{t.payment}</dt>
              <dd className="summary-ok">{t.inSafe}</dd>
            </div>
            <div>
              <dt>{t.workDue}</dt>
              <dd>{fmtDate(deliverBy)}</dd>
            </div>
          </>
        ) : (
          <>
            <div>
              <dt>{t.delivery}</dt>
              <dd>{tt.units.afterPayment(info.deliveryMs)}</dd>
            </div>
            <div>
              <dt>{t.payBy}</dt>
              <dd>{payBy ? t.payByLeft(fmtDate(payBy), left(payBy)) : t.afterAccept(info.payWithinMs)}</dd>
            </div>
          </>
        )}
      </dl>
    </aside>
  );
}

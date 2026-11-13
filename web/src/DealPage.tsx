// Client deal page: what the client sees after opening the creator's deal link.
// A deal made from a request shows the creator's profile; a direct deal shows
// only the creator code and a big notice. "Before you pay" turns yellow
// for a short review or a long lock and has a calendar
// button. The terms shown here were checked by this browser (lib/flows.ts loadDeal).
import { DAY, dealDates, fmtDate, revisionsText, usd, type DealInfo } from './deal';
import { tr, useT } from './i18n';
import { rich } from './i18n/rich';
import { Problem } from './ui';

const SHORT_REVIEW_MS = 3 * DAY; // at the minimum: easy to miss if you're away
const LONG_LOCK_MS = 30 * DAY;

function icsDate(d: Date) {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

const CRLF = String.fromCharCode(13, 10); // calendar files need CR LF line ends

function downloadReminders(deliverBy: Date, reviewEnd: Date) {
  const t = tr().ics;
  // `uid` is the same in every language, so a calendar sees the same event.
  const ev = (d: Date, uid: string, title: string, text: string) =>
    [
      'BEGIN:VEVENT',
      `UID:${icsDate(d)}-${uid}@kept`,
      `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`,
      `DTSTART;VALUE=DATE:${icsDate(d)}`,
      `SUMMARY:${title}`,
      `DESCRIPTION:${text}`,
      'END:VEVENT',
    ].join(CRLF);
  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Pinky//Deal reminders//EN',
    ev(deliverBy, 'Keptworkdue', t.workDue, t.workDueText),
    ev(reviewEnd, 'Keptreviewendsifdeliveredontime', t.reviewEnds, t.reviewEndsText),
    'END:VCALENDAR',
  ].join(CRLF);
  const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = t.fileName;
  a.click();
  URL.revokeObjectURL(url);
}

export function DealPage(props: {
  info: DealInfo;
  onAccept: () => void;
  /** Real deals: the link stops working at this time. */
  linkExpires?: Date;
  busy?: boolean;
  error?: unknown;
}) {
  const { info, onAccept } = props;
  const tt = useT();
  const t = tt.offer;
  const { deliverBy, reviewEnd, lockedUntil } = dealDates(info);
  const shortReview = info.reviewMs <= SHORT_REVIEW_MS;
  const longLock = lockedUntil.getTime() - Date.now() > LONG_LOCK_MS;
  const price = usd(info.amount);

  return (
    <main className="deal">
      <section className="terms" aria-labelledby="deal-title">
        <p className="from">
          {info.creator
            ? rich(t.from, {
                nick: (
                  <a href={info.creator.profileUrl} className="nick">
                    @{info.creator.nick}
                  </a>
                ),
              })
            : rich(t.fromCode, { code: <span className="code">{info.creatorCode}</span> })}
        </p>
        <h1 id="deal-title">{info.title}</h1>
        <p className="mobile-price">{t.mobilePrice(price, info.deliveryMs)}</p>

        {!info.creator && (
          <div className="notice" role="note">
            <p className="notice-title">{t.noProfileTitle}</p>
            <p>{t.noProfileText}</p>
          </div>
        )}

        <p className="seal">
          <span className="seal-mark" aria-hidden="true" />
          {t.seal}
        </p>

        <dl className="facts">
          <div>
            <dt>{tt.points.work}</dt>
            <dd>{info.task}</dd>
          </div>
          {info.deliverable && (
            <div>
              <dt>{tt.points.get}</dt>
              <dd>{info.deliverable}</dd>
            </div>
          )}
          <div>
            <dt>{tt.points.revisions}</dt>
            <dd>{revisionsText(info.revisions)}</dd>
          </div>
          <div>
            <dt>{tt.points.deadline}</dt>
            <dd>{t.deadline(info.deliveryMs, fmtDate(deliverBy))}</dd>
          </div>
          <div>
            <dt>{tt.create.review}</dt>
            <dd>{t.review(info.reviewMs)}</dd>
          </div>
        </dl>
      </section>

      <aside className="pay" aria-label={t.payLabel}>
        <p className="price">
          <span className="amount">{price}</span>
          <span className="currency">USDC</span>
        </p>
        <p className="price-note">{t.anyCoin}</p>

        <ol className="path" aria-label={t.pathLabel}>
          <li>
            <span className="dot" aria-hidden="true" />
            <strong>{t.path1}</strong>
            <span>{t.path1Note}</span>
          </li>
          <li className="safe">
            <span className="dot" aria-hidden="true" />
            <strong>{t.path2}</strong>
            <span>{t.path2Note}</span>
          </li>
          <li>
            <span className="dot" aria-hidden="true" />
            <strong>{t.path3}</strong>
            <span>{t.path3Note(info.reviewMs)}</span>
          </li>
        </ol>

        <div className={shortReview || longLock ? 'before before-warn' : 'before'}>
          <h2>{t.beforeTitle}</h2>
          {shortReview && <p className="before-alert">{t.shortReview(info.reviewMs)}</p>}
          {longLock && <p className="before-alert">{t.longLock(fmtDate(lockedUntil))}</p>}
          <ul>
            <li>{t.beforeFees}</li>
            <li>{t.beforeLate(fmtDate(deliverBy))}</li>
            <li>{t.beforeDispute(fmtDate(lockedUntil))}</li>
          </ul>
          <button className="btn-link btn-inline before-cal" type="button" onClick={() => downloadReminders(deliverBy, reviewEnd)}>
            {t.calendar}
          </button>
        </div>

        <button className="cta" type="button" onClick={onAccept} disabled={props.busy}>
          {t.accept}
        </button>
        <Problem error={props.error} />
        <p className="cta-note">
          {t.ctaNote(info.payWithinMs)}
          {props.linkExpires && t.linkUntil(fmtDate(props.linkExpires))}
        </p>
      </aside>
    </main>
  );
}

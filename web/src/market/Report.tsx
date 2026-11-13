// "Report": a quiet link on creator profiles, reviews,
// creators' answers and requests. It opens our own small form (no sign-in,
// no key): a reason, an optional note, then "Thanks, we'll check it". The
// server stores it for the Pinky team (and our bot tells the team's chat).
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../i18n';
import { ApiError } from '../lib/api';
import { LIMITS } from '../lib/market';
import type { ReportKind, ReportReason } from '../lib/marketApi';
import { useRun } from '../ui';
import { market } from './ctx';
import { marketError } from './parts';

const REASONS: ReportReason[] = ['scam', 'link', 'offensive', 'other'];

/** The link that opens the form. `label` overrides the word (e.g. "Report this creator"). */
export function ReportLink({ kind, id, label, className }: { kind: ReportKind; id: string; label?: string; className?: string }) {
  const t = useT().market.report;
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={`mk-report-link${className ? ` ${className}` : ''}`} aria-haspopup="dialog" onClick={() => setOpen(true)}>
        {label ?? t.link}
      </button>
      {/* in <body>: the link sits inside text (a <p>), and the form must look the same everywhere */}
      {open && createPortal(<ReportDialog kind={kind} id={id} onClose={() => setOpen(false)} />, document.body)}
    </>
  );
}

function ReportDialog({ kind, id, onClose }: { kind: ReportKind; id: string; onClose: () => void }) {
  const t = useT().market.report;
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const reasonId = useId();
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [text, setText] = useState('');
  const [done, setDone] = useState(false);
  const [missing, setMissing] = useState(false);
  const sending = useRun();
  const len = [...text].length;

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal(); // focus stays inside, Escape closes, the page behind is inert
    return () => d?.close();
  }, []);

  const send = async () => {
    const api = await market();
    const note = text.trim();
    await api.report({ kind, target_id: id, reason: reason!, ...(note ? { text: note } : {}) });
    setDone(true);
  };

  const gone = sending.error instanceof ApiError && sending.error.status === 404;

  return (
    <dialog
      ref={ref}
      className="confirm mk-report"
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => e.target === ref.current && onClose()}
    >
      {done ? (
        <div className="confirm-box" role="status">
          <h2 id={titleId} className="mk-report-title">
            {t.thanks}
          </h2>
          <p className="hint mk-report-hint">{t.thanksLine}</p>
          <div className="confirm-actions">
            <button className="cta cta-inline" type="button" autoFocus onClick={onClose}>
              {t.close}
            </button>
          </div>
        </div>
      ) : (
        <form
          className="confirm-box"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (!reason) {
              setMissing(true);
              return;
            }
            if (len <= LIMITS.report) void sending.run(send);
          }}
        >
          <h2 id={titleId} className="mk-report-title">
            {t.titles[kind]}
          </h2>
          <p className="hint mk-report-hint">{t.lead}</p>

          <div className="field">
            <span className="field-label" id={reasonId}>
              {t.reason}
            </span>
            <div className="mk-options" role="radiogroup" aria-labelledby={reasonId} aria-invalid={missing && !reason}>
              {REASONS.map((r) => (
                <button
                  key={r}
                  type="button"
                  role="radio"
                  aria-checked={reason === r}
                  className="chip mk-option"
                  onClick={() => {
                    setReason(r);
                    setMissing(false);
                  }}
                >
                  {t.reasons[r]}
                </button>
              ))}
            </div>
            {missing && !reason && (
              <span className="field-error" role="alert">
                {t.pickReason}
              </span>
            )}
          </div>

          <label className="field">
            <span className="field-label">{t.details}</span>
            <textarea rows={3} value={text} maxLength={LIMITS.report} onChange={(e) => setText(e.target.value)} placeholder={t.detailsPlaceholder} />
            {len > LIMITS.report - 100 && <span className="hint">{t.left(Math.max(0, LIMITS.report - len))}</span>}
          </label>
          <p className="hint mk-report-hint">{t.privacy}</p>

          {sending.error !== null && sending.error !== undefined && (
            <p className="alert alert-inline" role="alert">
              {gone ? t.gone : marketError(sending.error)}
            </p>
          )}
          <div className="confirm-actions">
            <button className="cta cta-inline" type="submit" disabled={sending.busy || gone}>
              {sending.busy ? t.sending : t.send}
            </button>
            <button className="btn-ghost" type="button" onClick={onClose}>
              {t.cancel}
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}

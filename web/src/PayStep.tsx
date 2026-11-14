// Payment: pick coin + network, give a refund address, get a one-time deposit address
// (1Click quote), then follow the status until the money is in the safe.
// This file only draws: the address it shows already passed every browser-side check
// (real/PayReal.tsx), and "in the safe" comes from the chain, not from our server.
import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { dealDates, fmtDate, usd, type DealInfo } from './deal';
import { useT } from './i18n';
import { coinsOn, networksOf, type Coin, type CoinNetwork } from './lib/tokens';
import { CopyButton, hintFor, Problem, useRun, useTopOnStep } from './ui';

export type PayStatus = 'waiting' | 'received' | 'converting' | 'done' | 'short' | 'failed' | 'expired';

export interface PayQuoteView {
  coin: string;
  network: string;
  /** Exact amount to send, in the coin. */
  amount: string;
  /** Network and swap fees in USDC, when known. */
  fees: string | null;
  address: string;
  /** Some networks need a memo with the payment. */
  memo: string | null;
  /** Send before this time (ms). */
  deadline: number;
}

function useTick(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now()); // start from the real time, not the time the page opened
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [active]);
  return now;
}

function Qr({ text }: { text: string }) {
  const label = useT().pay.qrLabel;
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (ref.current) {
      QRCode.toCanvas(ref.current, text, { width: 152, margin: 1 }).catch(() => {});
    }
  }, [text]);
  return <canvas ref={ref} className="qr" aria-label={label} role="img" />;
}

export function PayStep(props: {
  info: DealInfo;
  /** null while the list is loading. */
  coins: Coin[] | null;
  quote: PayQuoteView | null;
  /** Where the payment is; "expired" is worked out here from the deadline. */
  status: Exclude<PayStatus, 'expired'>;
  /** Asks for a payment address; rejects with the reason when there is none to show. */
  onGetAddress: (coin: Coin, network: CoinNetwork, refund: string) => Promise<void> | void;
  /** "Pay with another coin": forget the current address. */
  onChange: () => void;
  onOpenDeal: () => void;
  /** Work-due date once paid (from the chain for real deals). */
  deliverBy?: Date | null;
  /** Show the two key codes to compare in chat (deals without a profile). */
  showCodes: boolean;
  /** Clock offset to the chain time, ms. */
  skewMs?: number;
}) {
  const { info, quote, onOpenDeal } = props;
  const coins = props.coins ?? [];
  const [symbol, setSymbol] = useState('');
  const [code, setCode] = useState('');
  const [refund, setRefund] = useState('');
  const getting = useRun();
  const t = useT().pay;
  const now = useTick(quote !== null && props.status === 'waiting') + (props.skewMs ?? 0);

  // Network first, then the coins on it. `code` holds the picked network's name.
  const nets = networksOf(coins);
  const netName = (nets.find((n) => n.name === code) ?? nets[0])?.name ?? '';
  const onNet = coinsOn(coins, netName);
  const coin = onNet.find((c) => c.symbol === symbol) ?? onNet[0];
  const network = coin?.networks.find((n) => n.name === netName);

  const secondsLeft = quote ? Math.max(0, Math.floor((quote.deadline - now) / 1000)) : 0;
  const shown: PayStatus = quote && props.status === 'waiting' && secondsLeft === 0 ? 'expired' : props.status;
  // Coin form → payment address → "money is in the safe": each starts at the top.
  useTopOnStep(props.status === 'done' ? 'done' : quote ? 'address' : 'form');

  if (props.status === 'done') return <Done info={info} deliverBy={props.deliverBy ?? null} onOpen={onOpenDeal} />;

  const getAddress = () => {
    if (coin && network) void getting.run(() => props.onGetAddress(coin, network, refund.trim()));
  };

  return (
    <section className="terms screen" aria-labelledby="pay-title">
      <h1 id="pay-title">{t.title(usd(info.amount))}</h1>
      <p className="lead">{t.lead}</p>

      {props.showCodes && !quote && <CodeCheck info={info} />}

      {!quote ? (
        props.coins === null ? (
          <p className="hint" role="status">
            {t.loadingCoins}
          </p>
        ) : !coin || !network ? (
          <p className="alert alert-inline" role="alert">
            {t.coinsFailed}
          </p>
        ) : (
          <div className="pay-form">
            <div className="field">
              <span className="field-label" id="network-label">
                {t.network}
              </span>
              <div className="chips" role="radiogroup" aria-labelledby="network-label">
                {nets.map((n) => (
                  <button
                    key={n.name}
                    type="button"
                    role="radio"
                    aria-checked={netName === n.name}
                    className="chip"
                    onClick={() => setCode(n.name)}
                  >
                    {n.name}
                  </button>
                ))}
              </div>
            </div>

            <div className="field">
              <span className="field-label" id="coin-label">
                {t.coin}
              </span>
              <div className="chips" role="radiogroup" aria-labelledby="coin-label">
                {onNet.map((c) => (
                  <button
                    key={c.symbol}
                    type="button"
                    role="radio"
                    aria-checked={coin.symbol === c.symbol}
                    className="chip"
                    onClick={() => setSymbol(c.symbol)}
                  >
                    {c.symbol}
                  </button>
                ))}
              </div>
            </div>

            <label className="field">
              <span className="field-label">{t.refundOn(network.name)}</span>
              <input
                type="text"
                value={refund}
                onChange={(e) => setRefund(e.target.value)}
                placeholder={hintFor(network.code)}
                autoComplete="off"
                spellCheck={false}
              />
              <span className="hint">{t.refundHint}</span>
            </label>

            <Problem error={getting.error} />
            <div className="actions">
              <button
                className="cta cta-inline"
                type="button"
                disabled={refund.trim().length < 2 || getting.busy}
                onClick={getAddress}
              >
                {getting.busy ? t.getting : t.getAddress}
              </button>
            </div>
          </div>
        )
      ) : (
        <Invoice
          quote={quote}
          status={shown}
          secondsLeft={secondsLeft}
          onNew={props.onChange}
          onChange={props.onChange}
        />
      )}
    </section>
  );
}

function Invoice(props: {
  quote: PayQuoteView;
  status: PayStatus;
  secondsLeft: number;
  onNew: () => void;
  onChange: () => void;
}) {
  const { quote, status, secondsLeft } = props;
  const mm = String(Math.floor(secondsLeft / 60)).padStart(2, '0');
  const ss = String(secondsLeft % 60).padStart(2, '0');
  const sending = status === 'waiting';
  const t = useT().pay;

  const steps: { key: PayStatus; title: string; note: string }[] = [
    { key: 'waiting', title: t.stepWaiting, note: t.stepWaitingNote },
    { key: 'received', title: t.stepReceived, note: t.stepReceivedNote(quote.network) },
    { key: 'converting', title: t.stepConverting, note: t.stepConvertingNote },
    { key: 'done', title: t.stepDone, note: t.stepDoneNote },
  ];
  const at = steps.findIndex((s) => s.key === status);

  return (
    <div className="invoice">
      {status === 'expired' ? (
        <div className="alert" role="alert">
          <p>
            <strong>{t.expired}</strong>
          </p>
          <p>{t.expiredLine}</p>
          <button className="cta cta-inline" type="button" onClick={props.onNew}>
            {t.newAddress}
          </button>
        </div>
      ) : status === 'short' || status === 'failed' ? (
        <div className="alert" role="alert">
          <p>
            <strong>
              {status === 'short' ? t.short : t.failed}
            </strong>
          </p>
          <p>{t.goingBack}</p>
          <button className="cta cta-inline" type="button" onClick={props.onNew}>
            {t.newAddress}
          </button>
        </div>
      ) : (
        <>
          {sending && (
            <div className="invoice-card">
              <div className="invoice-main">
                <p className="field-label">{t.sendExactly}</p>
                <div className="send-row">
                  <p className="send-amount">
                    {quote.amount} <span>{quote.coin}</span>
                  </p>
                  <CopyButton text={quote.amount} />
                </div>
                <p className="hint">
                  {t.on(quote.network)} {quote.fees ? t.feesAbout(quote.fees) : t.feesIncluded}
                </p>

                <p className="field-label">{t.toAddress}</p>
                <div className="address">
                  <code>{quote.address}</code>
                  <CopyButton text={quote.address} />
                </div>

                {quote.memo && (
                  <>
                    <p className="field-label">{t.memo}</p>
                    <div className="address">
                      <code>{quote.memo}</code>
                      <CopyButton text={quote.memo} />
                    </div>
                  </>
                )}

                <p className="timer">
                  {t.sendWithin}{' '}
                  <strong className="tnum">
                    {mm}:{ss}
                  </strong>
                </p>
              </div>
              <Qr text={quote.address} />
            </div>
          )}

          {sending && (
            <ul className="warn-list">
              <li>{t.warnOne}</li>
              <li>{t.warnOnly(quote.coin, quote.network)}</li>
              {quote.memo && <li>{t.warnMemo}</li>}
            </ul>
          )}

          <ol className="path status" aria-label={t.statusLabel} aria-live="polite">
            {steps.map((s, i) => (
              <li key={s.key} className={i < at ? 'done' : i === at ? 'now' : undefined}>
                <span className="dot" aria-hidden="true" />
                <strong>{s.title}</strong>
                <span>{s.note}</span>
              </li>
            ))}
          </ol>
        </>
      )}

      {sending && (
        <button className="btn-link" type="button" onClick={props.onChange}>
          {t.otherCoin}
        </button>
      )}
    </div>
  );
}

/** Deals not made from a request: compare the key codes in chat before paying
 *  (fingerprints). A different code means someone else joined. */
function CodeCheck({ info }: { info: DealInfo }) {
  const t = useT().pay;
  return (
    <div className="panel code-check">
      <p className="panel-title">{t.codesTitle}</p>
      <dl className="split-result">
        <div>
          <dt>{t.creatorsCode}</dt>
          <dd className="code">{info.creatorCode}</dd>
        </div>
        <div>
          <dt>{t.yourCode}</dt>
          <dd className="code">{info.clientCode ?? '—'}</dd>
        </div>
      </dl>
      <p className="hint">{t.codesHint}</p>
    </div>
  );
}

function Done({ info, deliverBy, onOpen }: { info: DealInfo; deliverBy: Date | null; onOpen: () => void }) {
  const due = deliverBy ?? dealDates(info).deliverBy;
  const t = useT().pay;
  return (
    <section className="terms screen done-screen" aria-labelledby="done-title">
      <span className="done-mark" aria-hidden="true">
        ✓
      </span>
      <h1 id="done-title">{t.doneTitle}</h1>
      <p className="lead">
        {t.doneLead(usd(info.amount), info.creator ? `@${info.creator.nick}` : null, info.deliveryMs, fmtDate(due))}
      </p>
      <p className="lead">{t.doneRules}</p>
      <div className="actions">
        <button className="cta cta-inline" type="button" onClick={onOpen}>
          {t.openDeal}
        </button>
      </div>
    </section>
  );
}

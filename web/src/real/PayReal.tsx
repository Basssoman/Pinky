// Real payment step: a signed quote request, every browser-side check before
// an address is shown, the 1Click status for the progress rail, and "money is
// in the safe" only when the CHAIN says the deal is funded.
import { useEffect, useState } from 'react';
import { usd, type DealInfo } from '../deal';
import { nsToMs } from '../lib/chain';
import { forgetPayQuote, requestPayQuote, storedPayQuote, type LoadedDeal } from '../lib/flows';
import type { VerifiedPayQuote } from '../lib/quote';
import type { Coin, CoinNetwork } from '../lib/tokens';
import { PayStep, type PayQuoteView, type PayStatus } from '../PayStep';
import { clockSkew, getCtx, useCoins } from './ctx';

type Progress = Exclude<PayStatus, 'expired' | 'done'>;

function view(v: VerifiedPayQuote, coin: string, network: string, info: DealInfo): PayQuoteView {
  const fees = v.amountInUsd ? Number(v.amountInUsd) - Number(usd(info.amount)) : NaN;
  return {
    coin,
    network,
    amount: v.amountInFormatted,
    fees: Number.isFinite(fees) && fees > 0 ? fees.toFixed(2) : null,
    address: v.depositAddress,
    memo: v.depositMemo,
    deadline: v.sendByMs,
  };
}

/** 1Click swap status -> a step of the progress rail. */
function progressOf(status: string | null): Progress {
  switch (status) {
    case 'KNOWN_DEPOSIT_TX':
      return 'received';
    case 'PROCESSING':
    case 'SUCCESS':
      return 'converting';
    case 'INCOMPLETE_DEPOSIT':
      return 'short';
    case 'REFUNDED':
    case 'FAILED':
      return 'failed';
    default:
      return 'waiting';
  }
}

export function PayReal(props: { d: LoadedDeal; info: DealInfo; onOpenDeal: () => void }) {
  const { d, info } = props;
  const ctx = getCtx();
  const coins = useCoins();
  const [quote, setQuote] = useState<{ v: VerifiedPayQuote; coin: string; network: string } | null>(() => {
    const s = storedPayQuote(ctx, d);
    return s ? { v: s, coin: s.coin, network: s.network } : null;
  });
  const [progress, setProgress] = useState<Progress>('waiting');
  const funded = d.deal !== null && d.deal.state !== 'Created';

  // The progress rail follows 1Click; it never decides that the deal is paid.
  useEffect(() => {
    if (!quote || funded) return;
    let alive = true;
    const poll = async () => {
      if (document.hidden) return;
      try {
        const s = await ctx.api.payStatus(d.handle, d.token, quote.v.depositAddress, quote.v.depositMemo);
        // An underpayment ends as "refunded": keep saying that less than the full amount arrived.
        if (alive) setProgress((was) => (was === 'short' && progressOf(s.status) === 'failed' ? 'short' : progressOf(s.status)));
      } catch {
        /* keep the last known step */
      }
    };
    void poll();
    const t = window.setInterval(poll, 6000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [quote, funded, ctx, d.handle, d.token]);

  const getAddress = async (coin: Coin, network: CoinNetwork, refund: string) => {
    const v = await requestPayQuote(ctx, d, { originAsset: network.assetId, refundTo: refund, coin: coin.symbol, network: network.name });
    setProgress('waiting');
    setQuote({ v, coin: coin.symbol, network: network.name });
  };

  const change = () => {
    forgetPayQuote(ctx, d);
    setQuote(null);
    setProgress('waiting');
  };

  return (
    <PayStep
      info={info}
      coins={coins.pay}
      quote={quote ? view(quote.v, quote.coin, quote.network, info) : null}
      status={funded ? 'done' : progress}
      onGetAddress={getAddress}
      onChange={change}
      onOpenDeal={props.onOpenDeal}
      deliverBy={d.deal?.delivery_deadline_ns ? new Date(nsToMs(d.deal.delivery_deadline_ns)) : null}
      showCodes
      skewMs={clockSkew()}
    />
  );
}

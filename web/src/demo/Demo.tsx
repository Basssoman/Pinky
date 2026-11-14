// The example deal ("See an example deal" on the home page) and, in
// development, every screen and state on made-up data with a "Demo:" switch
// bar. Nothing here is signed, sent or real; real deals live in real/.
import { useCallback, useEffect, useState } from 'react';
import { CreatePage, Preview, Share, type Terms } from '../CreatePage';
import { DAY, dealDates, demoInfo, splitOf } from '../deal';
import { DealPage } from '../DealPage';
import { DealStatus, type DealState, type Role, type StatusActions, type StatusView } from '../DealStatus';
import { DealSummary } from '../DealSummary';
import { useT } from '../i18n';
import { KeyLinkPage } from '../KeyLinkPage';
import { KeyStep } from '../KeyStep';
import type { Coin } from '../lib/tokens';
import { PRIVATE_BALANCE } from '../lib/tokens';
import { PayStep, type PayQuoteView, type PayStatus } from '../PayStep';
import { Steps } from '../Steps';
import { DEV_PREVIEW } from '../TelegramNotify';
import { useTopOnStep } from '../ui';

export type DemoStep = 'terms' | 'key' | 'pay' | 'deal' | 'create' | 'keylink';
export const DEMO_STEPS: DemoStep[] = ['terms', 'key', 'pay', 'deal', 'create', 'keylink'];

const DEMO_STATES: DealState[] = ['unpaid', 'cancelled', 'expired', 'funded', 'late', 'delivered', 'disputed', 'settled', 'released', 'refunded'];
// Sample links on this site's own address: a made-up domain could be registered by anyone.
const DEMO_LINK = `${window.location.origin}/k#demo-3f9a7c21e84b6d05a1c9f2e7b4d8a6c3`;
const DEMO_CLIENT_LINK = `${window.location.origin}/d#demo-8b2e41f07c9d3a65`;
const QUOTE_MINUTES = 30;
/** Development only (`?bot=Name`): the Telegram block on the example key steps, with a pretend bot. */
const DEMO_NOTIFY = DEV_PREVIEW ? { role: 'client' as const, handle: '0'.repeat(64), seed: '1'.repeat(64), token: '0'.repeat(32) } : undefined;

const net = (name: string) => ({ code: name.toLowerCase().replace(/\s/g, ''), name, assetId: `demo:${name}` });
const coin = (symbol: string, ...networks: string[]): Coin => ({ symbol, networks: networks.map(net) });
const PAY_COINS: Coin[] = [
  coin('USDT', 'Tron', 'Ethereum', 'BNB Chain', 'Solana', 'TON', 'Arbitrum'),
  coin('USDC', 'Ethereum', 'Solana', 'Base', 'Arbitrum', 'NEAR'),
  coin('ETH', 'Ethereum', 'Base', 'Arbitrum'),
  coin('BTC', 'Bitcoin'),
  coin('SOL', 'Solana'),
  coin('TON', 'TON'),
  coin('NEAR', 'NEAR'),
];
const PRICES: Record<string, [number, number]> = { USDT: [1, 2], USDC: [1, 2], ETH: [3100, 5], BTC: [96000, 6], SOL: [185, 3], TON: [3.2, 2], NEAR: [3.1, 2] };
const PAYOUT_COINS: Coin[] = [
  { symbol: 'USDC', networks: [...['NEAR', 'Ethereum', 'Solana', 'Base', 'Arbitrum'].map(net), { ...net(PRIVATE_BALANCE), private: true }] },
  ...PAY_COINS.filter((c) => c.symbol !== 'USDC'),
];

/** Dev-only switch bar. */
function DemoBar(props: { items: { label: string; on: boolean; onClick: () => void }[] }) {
  if (!import.meta.env.DEV) return null;
  return (
    <div className="demo-bar" aria-label="Demo states">
      <span>Demo:</span>
      {props.items.map((it, i) =>
        it.label === '|' ? (
          <span key={i}>|</span>
        ) : (
          <button key={it.label} type="button" aria-pressed={it.on} onClick={it.onClick}>
            {it.label}
          </button>
        ),
      )}
    </div>
  );
}

const SEP = { label: '|', on: false, onClick: () => {} };

export function Demo({ step, go }: { step: DemoStep; go: (next: DemoStep | 'home') => void }) {
  const [joinedAt] = useState(() => new Date());
  const [role, setRole] = useState<Role>('client');
  const [dealState, setDealState] = useState<DealState>('funded');
  const [splitPct, setSplitPct] = useState(70);
  const [incoming, setIncoming] = useState(false);
  const [myPct, setMyPct] = useState<number | null>(null);
  const [leftover, setLeftover] = useState(false);
  const [timerOver, setTimerOver] = useState(false);
  const [fromRequest, setFromRequest] = useState(true);
  const [keyHeld, setKeyHeld] = useState(false);
  const [quote, setQuote] = useState<PayQuoteView | null>(null);
  const [payStatus, setPayStatus] = useState<Exclude<PayStatus, 'expired'>>('waiting');
  const tt = useT();
  // The made-up deal, in the chosen language.
  const DEMO = demoInfo();

  const titles: Record<DemoStep, string> = {
    terms: tt.titles.deal,
    key: tt.titles.saveKey,
    pay: tt.titles.pay,
    deal: tt.titles.yourDeal,
    create: tt.titles.newDeal,
    keylink: tt.titles.secretKey,
  };
  const title = titles[step];
  useEffect(() => {
    document.title = title;
  }, [title]);

  const info = { ...DEMO, creator: fromRequest ? DEMO.creator : null };
  const onState = useCallback((s: DealState, pct?: number) => {
    setDealState(s);
    if (pct !== undefined) setSplitPct(pct);
  }, []);

  const requestToggle = [
    { label: 'from request', on: fromRequest, onClick: () => setFromRequest(true) },
    { label: 'direct link', on: !fromRequest, onClick: () => setFromRequest(false) },
  ];

  if (step === 'terms') {
    return (
      <>
        <DealPage info={info} onAccept={() => go('key')} />
        <DemoBar items={requestToggle} />
      </>
    );
  }

  if (step === 'create') return <DemoCreate />;

  if (step === 'keylink') {
    return (
      <>
        <KeyLinkPage held={keyHeld} title={DEMO.title} onOpen={() => go('deal')} onLeave={() => go('home')} />
        <DemoBar
          items={[
            { label: 'key in this browser', on: keyHeld, onClick: () => setKeyHeld(true) },
            { label: 'other browser', on: !keyHeld, onClick: () => setKeyHeld(false) },
          ]}
        />
      </>
    );
  }

  if (step === 'key' || step === 'pay') {
    const paid = step === 'pay' && payStatus === 'done';
    const makeQuote = (c: Coin, network: { name: string }) => {
      const [price, digits] = PRICES[c.symbol] ?? [1, 2];
      const feeRate = price === 1 ? 0.006 : 0.012;
      const usdc = Number(DEMO.amount) / 1e6;
      setQuote({
        coin: c.symbol,
        network: network.name,
        amount: ((usdc * (1 + feeRate)) / price).toFixed(digits),
        fees: (usdc * feeRate).toFixed(2),
        address: `DEMO-${network.name.replace(/\s/g, '').toUpperCase()}-ADDRESS-NOT-REAL-7F3A9C`,
        memo: null,
        deadline: Date.now() + QUOTE_MINUTES * 60_000,
      });
      setPayStatus('waiting');
    };
    return (
      <>
        <Steps current={paid ? 3 : step === 'key' ? 1 : 2} />
        <main className="deal">
          {step === 'key' ? (
            <KeyStep link={DEMO_LINK} title={DEMO.title} who={tt.key.whoWithNick(DEMO.creator!.nick)} tag="demo" own={DEMO_NOTIFY} onDone={() => go('pay')} />
          ) : (
            <PayStep
              info={info}
              coins={PAY_COINS}
              quote={quote}
              status={payStatus}
              onGetAddress={makeQuote}
              onChange={() => setQuote(null)}
              onOpenDeal={() => go('deal')}
              showCodes={!fromRequest}
            />
          )}
          <DealSummary info={info} payBy={dealDates(DEMO, joinedAt).payBy} paid={paid} />
        </main>
        {step === 'pay' && (
          <DemoBar
            items={[
              ...requestToggle,
              ...(quote
                ? [
                    SEP,
                    ...(['waiting', 'received', 'converting', 'done', 'short', 'failed'] as const).map((s) => ({
                      label: s,
                      on: payStatus === s,
                      onClick: () => {
                        setQuote({ ...quote, deadline: Date.now() + QUOTE_MINUTES * 60_000 });
                        setPayStatus(s);
                      },
                    })),
                    { label: 'expired', on: false, onClick: () => (setQuote({ ...quote, deadline: Date.now() }), setPayStatus('waiting')) },
                  ]
                : []),
            ]}
          />
        )}
      </>
    );
  }

  // step === 'deal'
  const now = Date.now();
  const paidAt = new Date(now - (dealState === 'late' ? 15 : 3) * DAY);
  const deliveredAt = new Date(now - 1 * DAY);
  const live = ['funded', 'late', 'delivered', 'disputed'].includes(dealState);
  const s = splitOf(DEMO, dealState === 'settled' ? splitPct : 100);
  const creatorGot = dealState === 'refunded' ? 0n : s.creatorNet;
  const clientGot = dealState === 'refunded' ? DEMO.amount : dealState === 'settled' ? s.clientBack : 0n;
  const closedPayout = ['settled', 'released', 'refunded'].includes(dealState) ? (role === 'creator' ? creatorGot : clientGot) : 0n;
  const view: StatusView = {
    info,
    role,
    state: dealState,
    d: {
      paidAt: dealState === 'unpaid' ? null : paidAt,
      deliverBy: new Date(paidAt.getTime() + DEMO.deliveryMs),
      deliveredAt: ['delivered', 'disputed', 'released', 'settled'].includes(dealState) ? deliveredAt : null,
      reviewEnd: new Date(deliveredAt.getTime() + DEMO.reviewMs),
      splitAt: new Date(now + DEMO.disputeMs),
      payBy: new Date(dealState === 'expired' ? now - DAY : now + 4 * DAY),
    },
    ending: dealState === 'settled' ? (splitPct === 50 ? 'timeout' : 'agreed') : dealState === 'released' ? 'accepted' : dealState === 'refunded' ? 'late' : null,
    splitPct,
    creatorGot,
    clientGot,
    mine: {
      payout: role === 'client' && leftover && (live || dealState === 'unpaid') ? 40_000_000n : closedPayout,
      pending: false,
      withdrawn: 0n,
    },
    timerOver,
    incoming: incoming && live ? { pct: 70, expires: new Date(now + 23 * 3600_000) } : null,
    myProposal: myPct !== null && live ? { pct: myPct, expires: new Date(now + 24 * 3600_000) } : null,
    delivery: { link: 'https://drive.google.com/drive/folders/demo-promo-final' },
    dispute: { pointLabel: tt.points.get, text: tt.demo.disputeText },
    coins: PAYOUT_COINS,
    now,
    showReview: true,
  };
  const actions: StatusActions = {
    onPay: () => go('pay'),
    onDeliver: () => onState('delivered'),
    onCheckFiles: () => true,
    onAccept: () => onState('released'),
    onDispute: () => onState('disputed'),
    onRefund: () => onState('refunded'),
    onCancel: () => onState('cancelled'),
    onPropose: (p) => setMyPct(p),
    onRevokeProposal: () => setMyPct(null),
    onAcceptProposal: () => onState('settled', 70),
    onFinishTimer: () => (dealState === 'delivered' ? onState('released') : dealState === 'disputed' ? onState('settled', 50) : onState('expired')),
    onWithdraw: () => {},
  };

  return (
    <>
      <DealStatus key={`${role}-${dealState}-${incoming}-${timerOver}`} view={view} actions={actions} />
      <DemoBar
        items={[
          { label: 'client', on: role === 'client', onClick: () => setRole('client') },
          { label: 'creator', on: role === 'creator', onClick: () => setRole('creator') },
          SEP,
          ...DEMO_STATES.map((st) => ({ label: st, on: dealState === st, onClick: () => onState(st) })),
          SEP,
          { label: '+ proposal', on: incoming, onClick: () => setIncoming(!incoming) },
          { label: '+ leftover', on: leftover, onClick: () => setLeftover(!leftover) },
          { label: '+ timer over', on: timerOver, onClick: () => setTimerOver(!timerOver) },
          { label: 'direct link', on: !fromRequest, onClick: () => setFromRequest(!fromRequest) },
        ]}
      />
    </>
  );
}

/** The creator's three steps on made-up data (development only). */
function DemoCreate() {
  const tt = useT();
  const DEMO = demoInfo();
  const [stage, setStage] = useState<'form' | 'key' | 'share'>('form');
  const [terms, setTerms] = useState<Terms | null>(null);
  const [cancelled, setCancelled] = useState(false);
  useTopOnStep(stage);
  if (stage === 'form' || !terms) {
    return (
      <CreatePage
        // the example deal shows the final contract's periods (made-up deal, no chain read)
        limits={{ maxLinkMs: 7 * DAY, payWithinMs: DEMO.payWithinMs }}
        onCreate={(t) => {
          setTerms(t);
          setStage('key');
          window.scrollTo(0, 0);
        }}
      />
    );
  }
  return (
    <>
      <Steps current={stage === 'key' ? 1 : 2} flow="create" />
      <main className="deal">
        {stage === 'key' ? (
          <KeyStep
            role="creator"
            link={DEMO_LINK}
            title={terms.title}
            who={tt.key.whoCreator}
            tag="demo"
            next={tt.create.nextGetLink}
            own={DEMO_NOTIFY && { ...DEMO_NOTIFY, role: 'creator' }}
            onDone={() => setStage('share')}
          />
        ) : (
          <Share
            link={DEMO_CLIENT_LINK}
            expires={new Date(Date.now() + Number(terms.linkDays) * DAY)}
            code={DEMO.creatorCode}
            cancelled={cancelled}
            onCancel={() => setCancelled(true)}
          />
        )}
        <Preview terms={terms} />
      </main>
    </>
  );
}

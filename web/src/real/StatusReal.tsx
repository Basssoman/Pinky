// Real "Your deal" page: state, money and timers from the chain; every
// button signs with this browser's deal key and relays through our API.
import { useEffect, useRef, useState } from 'react';
import type { DealInfo } from '../deal';
import { DealStatus, type StatusActions, type StatusView } from '../DealStatus';
import {
  acceptSettle,
  act,
  deliver,
  filesMatch,
  finishTimer,
  openDispute,
  ownPayout,
  proposeSettle,
  readNotes,
  readProposals,
  resendNotes,
  revokeProposals,
  sendCreatorArbiterCopy,
  timerOver,
  withdraw,
  type DealNotes,
  type LoadedDeal,
  type SettleView,
} from '../lib/flows';
import { useT } from '../i18n';
import { ReviewBlock } from '../market/Review';
import { keyFileText, saveTextFile } from '../keyFile';
import { PasskeyProtect } from '../PasskeyProtect';
import { TelegramNotify } from '../TelegramNotify';
import { useNow } from '../ui';
import { getCtx, useCoins } from './ctx';
import { screenState, statusDates, totals } from './model';

const LIVE = ['Funded', 'Delivered', 'Disputed'];

export function StatusReal(props: {
  d: LoadedDeal;
  info: DealInfo;
  /** Waits until the chain shows the change, then redraws. */
  settle: (changed: (d: LoadedDeal) => boolean) => Promise<LoadedDeal>;
  onPay: () => void;
}) {
  const { d, info } = props;
  const ctx = getCtx();
  const deal = d.deal!;
  const role = d.role === 'creator' ? 'creator' : 'client';
  const now = useNow(15_000, ctx.now);
  const coins = useCoins();
  const tt = useT();
  const points: Record<string, string> = tt.points;
  const [notes, setNotes] = useState<DealNotes | null | undefined>(undefined);
  const [proposals, setProposals] = useState<SettleView[]>([]);
  const [tick, setTick] = useState(0);
  const copySent = useRef(false);
  const resent = useRef(false);

  const hasNotes = deal.state === 'Delivered' || deal.state === 'Disputed';
  const live = LIVE.includes(deal.state);

  // What the parties left for each other: the files link and the dispute text.
  useEffect(() => {
    if (!hasNotes) return;
    let alive = true;
    readNotes(ctx, d)
      .then(async (n) => {
        if (!alive) return;
        setNotes(n);
        // Anything that could not be stored when the action went out (our server was down) goes out now.
        if (!resent.current) {
          resent.current = true;
          if (await resendNotes(ctx, d, n).catch(() => false)) setTick((t) => t + 1);
        }
        // In a dispute the creator's own copy of the files link goes to the arbiter.
        if (!copySent.current && d.role === 'creator' && deal.state === 'Disputed' && !n.arbiterCopy.creator) {
          copySent.current = true;
          await sendCreatorArbiterCopy(ctx, d, n).catch(() => {
            copySent.current = false;
          });
        }
      })
      .catch(() => alive && setNotes(null));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasNotes, deal.state, deal.deliverable_hash, d.handle, tick]);

  // Open split proposals; re-read every 15 s while the deal is live.
  useEffect(() => {
    if (!live) {
      setProposals([]);
      return;
    }
    let alive = true;
    const read = () =>
      readProposals(ctx, d)
        .then((p) => alive && setProposals(p))
        .catch(() => {});
    void read();
    const t = window.setInterval(() => !document.hidden && void read(), 15_000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, deal.state, deal.settle_seq, d.handle, tick]);

  const s = screenState(deal, now);
  const mine = ownPayout(d);
  const incoming = proposals.find((p) => !p.mine) ?? null;
  const own = proposals.find((p) => p.mine) ?? null;

  const view: StatusView = {
    info,
    role,
    state: s.state,
    d: statusDates(deal),
    ending: s.ending,
    splitPct: s.splitPct,
    ...totals(deal),
    mine: { payout: mine.payout, pending: mine.pending > 0n, withdrawn: mine.withdrawn },
    timerOver: timerOver(deal, now) !== null,
    incoming: incoming ? { pct: incoming.creatorPct, expires: new Date(incoming.expiresMs) } : null,
    myProposal: own ? { pct: own.creatorPct, expires: new Date(own.expiresMs) } : null,
    delivery: !hasNotes ? null : notes === undefined ? undefined : notes?.delivery ? { link: notes.delivery.link } : null,
    dispute:
      deal.state !== 'Disputed'
        ? null
        : notes === undefined
          ? undefined
          : notes?.dispute
            ? { pointLabel: points[notes.dispute.point] ?? notes.dispute.point, text: notes.dispute.text }
            : null,
    coins: coins.payout,
    now,
    showReview: false,
    network: ctx.net.cliNetwork,
  };

  const stateIsNot = (state: string) => (x: LoadedDeal) => x.deal?.state !== state;
  const reread = () => setTick((t) => t + 1);

  const actions: StatusActions = {
    onPay: props.onPay,
    onDeliver: async (link, files, onProgress) => {
      await deliver(ctx, d, link, files, onProgress);
      await props.settle(stateIsNot('Funded'));
    },
    onCheckFiles: async (files, onProgress) => {
      if (!notes?.delivery) return false;
      return filesMatch(d, notes.delivery, files, onProgress);
    },
    onAccept: async () => {
      await act(ctx, d, 'accept');
      await props.settle(stateIsNot('Delivered'));
    },
    onDispute: async (reason, splitPct) => {
      await openDispute(ctx, d, reason, notes?.delivery ?? null);
      const after = await props.settle((x) => x.deal?.state === 'Disputed');
      // The client's own split goes out inside the dispute, when the timer is already stopped.
      if (splitPct !== null && after.deal?.state === 'Disputed') await proposeSettle(ctx, after, splitPct);
      reread();
    },
    onRefund: async () => {
      await act(ctx, d, 'refund');
      await props.settle(stateIsNot('Funded'));
    },
    onCancel: async () => {
      await act(ctx, d, 'cancel');
      await props.settle(stateIsNot('Created'));
    },
    onPropose: async (pct) => {
      await proposeSettle(ctx, d, pct);
      setProposals(await readProposals(ctx, d));
    },
    onRevokeProposal: async () => {
      const seq = deal.settle_seq;
      await revokeProposals(ctx, d);
      await props.settle((x) => x.deal?.settle_seq !== seq);
      setProposals([]);
    },
    onAcceptProposal: async () => {
      if (!incoming) return;
      const state = deal.state;
      await acceptSettle(ctx, d, incoming);
      await props.settle(stateIsNot(state));
    },
    onFinishTimer: async () => {
      const state = deal.state;
      await finishTimer(ctx, d);
      await props.settle(stateIsNot(state));
    },
    onWithdraw: async (choice) => {
      const before = mine.payout;
      await withdraw(ctx, d, {
        destinationAsset: choice.network.assetId,
        recipient: choice.address,
        recipientType: choice.network.private ? 'CONFIDENTIAL_INTENTS' : 'DESTINATION_CHAIN',
      });
      await props.settle((x) => ownPayout(x).payout !== before);
    },
  };

  // Telegram notifications stay on offer until the deal is over for good.
  const over = deal.purged || (deal.outcome !== null && deal.settled);
  return (
    <DealStatus
      view={view}
      actions={actions}
      review={
        <>
          <ReviewBlock d={d} />
          {d.local && !over && (
            <PasskeyProtect
              own={d.local}
              onChange={() => {}}
              onDownload={() => {
                const own = getCtx().store.get(d.handle);
                if (!own?.seed) return;
                const who = own.role === 'creator' ? tt.key.whoCreator : tt.key.whoWithCode(info.creatorCode);
                saveTextFile(tt.key.fileName(own.role, d.handle.slice(0, 6)), keyFileText(tt, info.title, who, own));
              }}
            />
          )}
          {d.local && !over && <TelegramNotify local={d.local} />}
        </>
      }
    />
  );
}

// The one set of tools every real page uses: the hard-coded network, our API,
// the chain reader, this browser's key store and a clock.

import { useEffect, useState } from 'react';
import { httpApi } from '../lib/api';
import type { Limits } from '../lib/limits';
import { nsToMs, rpcChain } from '../lib/chain';
import { NET } from '../lib/config';
import type { Ctx } from '../lib/flows';
import { browserStore } from '../lib/local';
import { coinsFromTokens, payoutCoins, type Coin } from '../lib/tokens';

let ctx: Ctx | null = null;
/** How far this computer's clock is from the chain's, when it is far enough to matter. */
let skew = 0;

export function getCtx(): Ctx {
  if (!ctx) {
    const chain = rpcChain(NET.contractId, NET.rpcUrls);
    ctx = { net: NET, api: httpApi(NET.apiBase), chain, store: browserStore(), now: () => Date.now() + skew };
    // Deadlines are decided by the chain's clock. A final block is a few
    // seconds old, so only a clearly wrong computer clock is corrected.
    chain
      .getTimeMs()
      .then((t) => {
        const d = t - Date.now();
        skew = Math.abs(d) > 20_000 ? d : 0;
      })
      .catch(() => {});
  }
  return ctx;
}

export const clockSkew = (): number => skew;

/** Moves to another page of the site without a reload. */
export function navigate(url: string, replace = false): void {
  if (replace) window.history.replaceState(null, '', url);
  else window.history.pushState(null, '', url);
  window.dispatchEvent(new PopStateEvent('popstate'));
  window.scrollTo(0, 0);
}

let limitsOnce: Promise<Limits> | null = null;

/**
 * What the contract allows for a new deal: the longest link
 * and the time to pay. Read from the contract itself; our server's
 * `/api/config` is the fallback for the link limit. null while loading.
 */
export function useContractLimits(): Limits | null {
  const [limits, setLimits] = useState<Limits | null>(null);
  useEffect(() => {
    let alive = true;
    const c = getCtx();
    limitsOnce ??= c.chain
      .getPeriods()
      .then(async (p): Promise<Limits> => {
        let maxLinkMs = p.maxOfferTtlNs !== undefined ? nsToMs(p.maxOfferTtlNs) : null;
        if (maxLinkMs === null) maxLinkMs = await serverMaxLink(c);
        return { maxLinkMs, payWithinMs: nsToMs(p.payByPeriodNs) };
      })
      .catch(async () => ({ maxLinkMs: await serverMaxLink(c), payWithinMs: null }));
    limitsOnce.then((l) => {
      if (alive) setLimits(l);
      if (l.maxLinkMs === null && l.payWithinMs === null) limitsOnce = null; // nothing known: ask again next time
    });
    return () => {
      alive = false;
    };
  }, []);
  return limits;
}

async function serverMaxLink(c: Ctx): Promise<number | null> {
  try {
    const s = (await c.api.config?.())?.max_offer_ttl_seconds;
    return typeof s === 'number' && s > 0 ? s * 1000 : null;
  } catch {
    return null;
  }
}

let tokensOnce: Promise<Awaited<ReturnType<Ctx['api']['tokens']>>> | null = null;

/** Coins to pay with and coins a payout can go to; null while loading, [] if the list could not be loaded. */
export function useCoins(): { pay: Coin[] | null; payout: Coin[] | null } {
  const [coins, setCoins] = useState<{ pay: Coin[] | null; payout: Coin[] | null }>({ pay: null, payout: null });
  useEffect(() => {
    let alive = true;
    const c = getCtx();
    tokensOnce ??= c.api.tokens();
    tokensOnce
      .then((tokens) => {
        if (alive) setCoins({ pay: coinsFromTokens(tokens, true), payout: payoutCoins(tokens, c.net.usdcAssetId) });
      })
      .catch(() => {
        tokensOnce = null;
        // Without our server a payout in plain USDC on NEAR is still possible to describe.
        if (alive) setCoins({ pay: [], payout: payoutCoins([], c.net.usdcAssetId) });
      });
    return () => {
      alive = false;
    };
  }, []);
  return coins;
}

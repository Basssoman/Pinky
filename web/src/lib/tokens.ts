// Coins and networks a person can pay with or withdraw to, built from the
// 1Click token list our server passes on (`GET /api/tokens`).

import type { TokenInfo } from './api';

export interface CoinNetwork {
  /** 1Click blockchain code, e.g. "eth". */
  code: string;
  /** Name people know, e.g. "Ethereum". */
  name: string;
  /** 1Click asset id sent in the quote request (and checked in the signed quote). */
  assetId: string;
  /** Private NEAR Intents balance instead of an on-chain address (withdraw only). */
  private?: boolean;
}

export interface Coin {
  symbol: string;
  networks: CoinNetwork[];
}

const NETWORK_NAMES: Record<string, string> = {
  eth: 'Ethereum',
  sol: 'Solana',
  near: 'NEAR',
  btc: 'Bitcoin',
  ton: 'TON',
  tron: 'Tron',
  arb: 'Arbitrum',
  base: 'Base',
  bsc: 'BNB Chain',
  pol: 'Polygon',
  op: 'Optimism',
  avax: 'Avalanche',
  gnosis: 'Gnosis',
  bera: 'Berachain',
  xrp: 'XRP Ledger',
  doge: 'Dogecoin',
  ltc: 'Litecoin',
  bch: 'Bitcoin Cash',
  zec: 'Zcash',
  sui: 'Sui',
  aptos: 'Aptos',
  stellar: 'Stellar',
  cardano: 'Cardano',
  starknet: 'Starknet',
  monad: 'Monad',
  xlayer: 'X Layer',
  plasma: 'Plasma',
  hypercore: 'Hyperliquid',
};

const ADDRESS_HINTS: Record<string, string> = {
  eth: '0x…',
  arb: '0x…',
  base: '0x…',
  bsc: '0x…',
  pol: '0x…',
  op: '0x…',
  avax: '0x…',
  gnosis: '0x…',
  bera: '0x…',
  tron: 'T…',
  sol: 'Your Solana address',
  ton: 'UQ… or EQ…',
  btc: 'bc1…',
  near: 'name.near',
};

export const networkName = (code: string): string => NETWORK_NAMES[code.toLowerCase()] ?? code.toUpperCase();
export const addressHint = (code: string): string => ADDRESS_HINTS[code.toLowerCase()] ?? 'Your address';
export const PRIVATE_BALANCE = 'Private balance';

/** Coin names people know, where 1Click uses another symbol (TON's coin is "GRAM" there). */
const COIN_NAMES: Record<string, string> = { GRAM: 'TON' };
export const coinName = (symbol: string): string => COIN_NAMES[symbol] ?? symbol;

/**
 * The pay and withdraw forms ask for the network first, then the coin (the usual
 * order). Every network of the list, once, by its name.
 */
export function networksOf(coins: Coin[]): CoinNetwork[] {
  const out: CoinNetwork[] = [];
  for (const c of coins) for (const n of c.networks) if (!out.some((o) => o.name === n.name)) out.push(n);
  return out;
}
/** The coins that can be sent on the network with this name. */
export const coinsOn = (coins: Coin[], networkName: string): Coin[] =>
  coins.filter((c) => c.networks.some((n) => n.name === networkName));

/**
 * Paying: "NEAR" instead of 1Click's "wNEAR". A plain NEAR transfer to the deposit
 * address works (live deal 7, 2026-11-11: 1Click took native NEAR and swapped it).
 * Payouts keep "wNEAR": what arrives is the wrapped token.
 */
const PAY_NAMES: Record<string, string> = { wNEAR: 'NEAR' };

/** Groups the token list by coin, keeping the server's order. `forPay` uses the pay-side names. */
export function coinsFromTokens(tokens: TokenInfo[], forPay = false): Coin[] {
  const coins: Coin[] = [];
  for (const t of tokens) {
    if (typeof t?.assetId !== 'string' || typeof t.symbol !== 'string' || typeof t.blockchain !== 'string') continue;
    const symbol = (forPay && PAY_NAMES[t.symbol]) || coinName(t.symbol);
    let coin = coins.find((c) => c.symbol === symbol);
    if (!coin) coins.push((coin = { symbol, networks: [] }));
    if (!coin.networks.some((n) => n.code === t.blockchain)) {
      coin.networks.push({ code: t.blockchain, name: networkName(t.blockchain), assetId: t.assetId });
    }
  }
  return coins;
}

/**
 * Where a payout can go: every coin of the list, plus a private NEAR Intents
 * balance for USDC (withdraw screen). `usdcAssetId` is the hard-coded one.
 */
export function payoutCoins(tokens: TokenInfo[], usdcAssetId: string): Coin[] {
  const coins = coinsFromTokens(tokens);
  let usdc = coins.find((c) => c.symbol === 'USDC');
  if (!usdc) coins.unshift((usdc = { symbol: 'USDC', networks: [] }));
  if (!usdc.networks.some((n) => n.assetId === usdcAssetId)) {
    usdc.networks.unshift({ code: 'near', name: 'NEAR', assetId: usdcAssetId });
  }
  usdc.networks.push({ code: 'near', name: PRIVATE_BALANCE, assetId: usdcAssetId, private: true });
  return coins;
}

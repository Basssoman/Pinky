// What this site trusts. Hard-coded on purpose (see "Honest limits" in the
// README): the contract, the token and the 1Click key are NEVER taken from our
// API, so a hacked server cannot point a payment at another account.

export interface Net {
  name: 'mainnet' | 'dev';
  /** The escrow contract every signature and every payment is bound to. */
  contractId: string;
  /** NEAR-native USDC as a 1Click asset id, and its token account. */
  usdcAssetId: string;
  tokenAccountId: string;
  /** 1Click quote-signing key. */
  oneClickKey: string;
  /** Arbiter's encryption key, x25519 public key as hex. "" = not set up. */
  arbiterNoteKey: string;
  /** Public NEAR RPCs the browser reads the deal from, tried in order. */
  rpcUrls: string[];
  /** Where our API lives ("" = same origin). The API is a convenience, not a trust anchor. */
  apiBase: string;
  /** `near` CLI network name for the "send it yourself" command. */
  cliNetwork: string;
}

const MAINNET_USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';

/**
 * The FINAL release contract `escrow.pinkydeals.near` (deployed 2026-11-13 from
 * this repository, reproducible build). The v2 TEST instance was
 * 9e537c21716b2035d7c88f153f0283e8dda925af16bbb6cf6ea23256436c2c9c.
 */
const MAINNET: Net = {
  name: 'mainnet',
  contractId: 'escrow.pinkydeals.near',
  usdcAssetId: `nep141:${MAINNET_USDC}`,
  tokenAccountId: MAINNET_USDC,
  oneClickKey: 'ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc',
  // Arbiter bfe910db… (made 2026-11-11 with the arbiter tool `init`); the final contract keeps the same arbiter, so the same key.
  arbiterNoteKey: 'be8a5a374b4a1203a5d8d2ef95a4a49ccd07b0b4669f64fe95a2e5408585b26b',
  // rpc.mainnet.near.org is deprecated (on 2026-11-11 it answered -429 "STOP USING IT"); never put it back.
  rpcUrls: ['https://rpc.mainnet.fastnear.com', 'https://near.drpc.org', 'https://1rpc.io/near'],
  apiBase: '',
  cliNetwork: 'mainnet',
};

/**
 * Local sandbox for development: values come from `.env.development.local`
 * written by the dev stack. Compiled in ONLY for `vite dev`; a production
 * build always uses MAINNET.
 */
function devNet(): Net | null {
  if (!import.meta.env.DEV) return null;
  const e = import.meta.env;
  if (!e.VITE_DEV_CONTRACT_ID) return null;
  const token = String(e.VITE_DEV_TOKEN_ACCOUNT_ID ?? '');
  return {
    name: 'dev',
    contractId: String(e.VITE_DEV_CONTRACT_ID),
    usdcAssetId: `nep141:${token}`,
    tokenAccountId: token,
    oneClickKey: String(e.VITE_DEV_ONECLICK_KEY ?? ''),
    arbiterNoteKey: String(e.VITE_DEV_ARBITER_NOTE_KEY ?? ''),
    rpcUrls: ['/rpc'],
    apiBase: '',
    cliNetwork: 'sandbox',
  };
}

export const NET: Net = devNet() ?? { ...MAINNET, apiBase: String(import.meta.env.VITE_API_URL ?? '') };

/** The one official support contact. "" until the team picks it. */
export const SUPPORT_CONTACT = '';

export const FEE_BPS = 300;
export const USDC_DECIMALS = 6;

// Configuration from environment variables.
//
// Env files are parsed with Node's built-in `util.parseEnv` (no dotenv
// dependency). Order (first non-empty value wins, real env vars always win):
//   1. $ENV_FILE (if set)
//   2. server/.env
//   3. ../.env (repository root; holds ONECLICK_API_KEY)
// Secrets are never logged: `describeConfig` prints only non-secret fields.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

import { ONE_CLICK_MANAGER_PUBLIC_KEY } from './quoteSignature.ts';

export type NearNetwork = 'sandbox' | 'testnet' | 'mainnet';

export interface Config {
  port: number;
  host: string;
  network: NearNetwork;
  rpcUrl: string;
  /** Max seconds to wait for one relayer send before moving on. */
  relayerSendTimeoutSeconds: number;
  /** RPC used to SEND relayer transactions (default: rpcUrl). A separate,
   *  ideally paid endpoint keeps public view floods from blocking sends. */
  rpcSendUrl: string;
  contractId: string;
  relayerAccountId: string;
  /** "ed25519:..." secret key. Never log. */
  relayerPrivateKey: string;
  /** Never log. Empty string means "no key" (1Click then adds its 0.25% fee). */
  oneClickApiKey: string;
  oneClickBaseUrl: string;
  /** Force `dry: true` on every 1Click quote. TRUE unless ONECLICK_FORCE_DRY=false. */
  oneClickForceDry: boolean;
  /** NEP-141 asset id of NEAR-native USDC, the escrow token. */
  usdcAssetId: string;
  /** 1Click slippage tolerance in bps for quotes. */
  slippageBps: number;
  /** Lifetime of quotes we request (deposit deadline), seconds. */
  quoteDeadlineSeconds: number;
  /** Where 1Click refunds a failed payout swap: INTENTS or CONFIDENTIAL_INTENTS
   *  balance of the party's deal-key implicit account (never the operator). */
  payoutRefundType: 'INTENTS' | 'CONFIDENTIAL_INTENTS';
  /** withdraw expires_at_ns = 1Click quote deadline minus this margin. */
  withdrawExpiryMarginSeconds: number;
  /** Largest deal the server accepts, USDC base units. */
  maxDealAmount: bigint;
  /** Smallest deal the server accepts, USDC base units (never below the
   *  contract's 1 USDC; may be raised later, the contract floor is fixed). */
  minDealAmount: bigint;
  /** Fee (bps) every new offer must carry. */
  feeBps: number;
  /** Requests per minute per IP: reads / writes; writes per minute per deal. */
  rateReadsPerMin: number;
  /** POST /api/deals per IP. */
  rateWritesPerMin: number;
  /** Invalid / unauthenticated write requests per IP (400/401/403/404). */
  rateInvalidPerMin: number;
  /** Signed requests per deal key that fail the pre-check (never valid ones). */
  rateSignerPerMin: number;
  /** Quote requests per deal key. */
  rateQuotesPerMin: number;
  /** Rolling 24 h caps: offers and joins per IP prefix (/24, /48); joins globally. */
  dailyOffersPerIp: number;
  dailyJoinsPerIp: number;
  dailyJoinCap: number;
  /** Rolling 24 h cap on relayed withdraws per deal party (failed ones are retried). */
  dailyWithdrawsPerParty: number;
  /** Rolling 24 h cap on relayed withdraws per IP prefix. */
  dailyWithdrawsPerPrefix: number;
  /** Rolling 24 h cap on relayed non-time-critical txs per deal. */
  dailyTxPerDeal: number;
  /** Rolling 24 h cap on relayed `revoke_settle` per deal. */
  dailyRevokeSettlePerDeal: number;
  /** Rolling 24 h cap on pay quotes per deal (bounds the cancel block). */
  dailyPayQuotesPerDeal: number;
  /** Rolling 24 h budget of on-chain `revoke_offer`s; above it a revoke is
   *  only recorded in our DB, which already refuses the join. */
  dailyOnchainRevokes: number;
  /** Contract rejections per deal in 10 min before the relayer stops
   *  sending for it (cool-down). */
  chainFailsPerDeal: number;
  /** Queued time-critical txs (deliver/dispute/accept) per IP prefix. */
  maxQueuedCriticalPerPrefix: number;
  /** Non-time-critical relayer txs are refused below this free relayer NEAR,
   *  so deliver/dispute always have gas left. */
  actionReserveRelayer: bigint;
  /**
   * New joins are refused while the escrow's / relayer's free NEAR is below
   * these (yoctoNEAR), so free deal creation can never use up the NEAR that
   * existing deals need for their actions.
   */
  joinReserveEscrow: bigint;
  joinReserveRelayer: bigint;
  /** /api/health warns (never refuses) above this many offers in 24 h. */
  offerAlertThreshold: number;
  /** Max lifetime of an offer (offer_expires_at_ns - now). */
  maxOfferTtlSeconds: number;
  /** 1Click quote-signing public key (verify every quote before use). */
  oneClickQuotePublicKey: string;
  /** NEAR account of the escrow token (from USDC_ASSET_ID). */
  tokenAccountId: string;
  /** Fastify trustProxy: false, a hop count, or a list of proxy IPs/CIDRs.
   *  "true" means 1 hop, never "every hop". */
  trustProxy: boolean | number | string;
  /** /api/health warns below these (yoctoNEAR). */
  lowBalanceRelayer: bigint;
  lowBalanceEscrow: bigint;
  /** Symbols offered by GET /api/tokens. */
  tokenSymbols: string[];
  /** Blockchains offered by GET /api/tokens (empty = all). */
  tokenChains: string[];
  dbPath: string;
  corsOrigin: string;
  minReviewPeriodSeconds: number;
  minDeliverySeconds: number;
  /** ed25519 key the arbiter tool signs its API requests with ("" = arbiter routes are off). */
  arbiterApiPublicKey: string;
  /** Telegram notification bot. Never log the token. Token or username empty = the bot is off. */
  telegramBotToken: string;
  /** The bot's username without "@" ("" = off). */
  telegramBotUsername: string;
  /** How often the bot re-reads the subscribed deals (seconds, min 10). */
  notifyPollSeconds: number;
  /** Telegram chat id (a number, groups are negative) where the bot sends "Report" messages; "" = reports are only stored. */
  telegramReportsChatId: string;
  /**
   * Weekly volume alert: paid deals from requests to one creator profile above
   * this many USDC in a rolling 7 days -> one message to the reports chat (or a
   * log line). 0 = off. Nothing is ever blocked by it.
   */
  volumeAlertUsdc: number;
  /** Marketplace: re-read not yet finished deals made from requests this often (0 = off; page views still refresh). */
  marketRefreshSeconds: number;
  /** Marketplace: a review can be written or edited this long after the deal ended on-chain, then it is locked (default: 3 days). */
  reviewWindowSeconds: number;
  /** Marketplace: re-read the bios of confirmed accounts this often, in hours (0 = off). */
  accountRecheckHours: number;
  /** NEAR AI Cloud key for the brief helper; "" = the helper is off. Never sent to the browser. */
  nearAiApiKey: string;
  nearAiBaseUrl: string;
  nearAiModel: string;
  /** Brief helper calls per IP per minute / per network per day. */
  briefPerMin: number;
  briefPerDay: number;
}

/** server/ directory (works from src/ via TS stripping and from dist/src/). */
function findServerDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++) {
    if (existsSync(resolve(dir, 'package.json'))) return dir;
    dir = resolve(dir, '..');
  }
  return process.cwd();
}

const SERVER_DIR = findServerDir();

export function loadEnvFiles(): void {
  const candidates = [
    process.env.ENV_FILE,
    resolve(SERVER_DIR, '.env'),
    resolve(SERVER_DIR, '..', '.env'),
  ].filter((p): p is string => !!p);
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    const parsed = parseEnv(readFileSync(file, 'utf8'));
    for (const [k, v] of Object.entries(parsed)) {
      // An empty value (e.g. copied from .env.example) does not shadow a later file.
      if (v !== undefined && v !== '' && !process.env[k]) process.env[k] = v;
    }
  }
}

const DEFAULT_RPC: Record<NearNetwork, string> = {
  sandbox: 'http://127.0.0.1:3030',
  testnet: 'https://test.rpc.fastnear.com',
  mainnet: 'https://free.rpc.fastnear.com',
};

export const MAINNET_USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';

function list(v: string | undefined, dflt: string): string[] {
  return (v ?? dflt)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function int(v: string | undefined, dflt: number): number {
  if (v === undefined || v === '') return dflt;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new Error(`expected integer env value, got "${v}"`);
  return n;
}

function nearToYocto(v: string | undefined, dflt: number): bigint {
  const n = v === undefined || v === '' ? dflt : Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`expected a NEAR amount, got "${v}"`);
  return BigInt(Math.round(n * 1000)) * 10n ** 21n;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const network = (env.NEAR_NETWORK ?? 'sandbox') as NearNetwork;
  if (!['sandbox', 'testnet', 'mainnet'].includes(network)) {
    throw new Error(`NEAR_NETWORK must be sandbox | testnet | mainnet, got "${network}"`);
  }
  const relayerAccountId = env.RELAYER_ACCOUNT_ID ?? '';
  return {
    port: int(env.PORT, 8787),
    host: env.HOST ?? '127.0.0.1',
    network,
    rpcUrl: env.NEAR_RPC_URL || DEFAULT_RPC[network],
    rpcSendUrl: env.NEAR_RPC_SEND_URL || env.NEAR_RPC_URL || DEFAULT_RPC[network],
    relayerSendTimeoutSeconds: int(env.RELAYER_SEND_TIMEOUT_SECONDS, 120),
    contractId: env.ESCROW_CONTRACT_ID ?? '',
    relayerAccountId,
    relayerPrivateKey: env.RELAYER_PRIVATE_KEY ?? '',
    oneClickApiKey: env.ONECLICK_API_KEY ?? '',
    oneClickBaseUrl: env.ONECLICK_BASE_URL || 'https://1click.chaindefuser.com',
    oneClickForceDry: !(env.ONECLICK_FORCE_DRY === 'false' || env.ONECLICK_FORCE_DRY === '0'),
    usdcAssetId: env.USDC_ASSET_ID || `nep141:${MAINNET_USDC}`,
    slippageBps: int(env.ONECLICK_SLIPPAGE_BPS, 100),
    quoteDeadlineSeconds: int(env.QUOTE_DEADLINE_SECONDS, 30 * 60),
    payoutRefundType: env.PAYOUT_REFUND_TYPE === 'CONFIDENTIAL_INTENTS' ? 'CONFIDENTIAL_INTENTS' : 'INTENTS',
    withdrawExpiryMarginSeconds: int(env.WITHDRAW_EXPIRY_MARGIN_SECONDS, 300),
    // $2,000 max per deal at launch (server-side only).
    maxDealAmount: BigInt(int(env.MAX_DEAL_USDC, 2_000)) * 1_000_000n,
    // Team decision (2026-11-06): 1 USDC minimum (contract MIN_AMOUNT).
    minDealAmount: BigInt(Math.max(1, int(env.MIN_DEAL_USDC, 1))) * 1_000_000n,
    // Fee in each offer; today every offer must carry 300 (3%).
    feeBps: int(env.FEE_BPS, 300),
    rateReadsPerMin: int(env.RATE_READS_PER_MIN, 120),
    rateWritesPerMin: int(env.RATE_WRITES_PER_MIN, 20),
    rateInvalidPerMin: int(env.RATE_INVALID_PER_MIN, 30),
    rateSignerPerMin: int(env.RATE_SIGNER_PER_MIN, 20),
    rateQuotesPerMin: int(env.RATE_QUOTES_PER_MIN, 10),
    dailyOffersPerIp: int(env.DAILY_OFFERS_PER_IP, 50),
    dailyJoinsPerIp: int(env.DAILY_JOINS_PER_IP, 20),
    dailyJoinCap: int(env.DAILY_JOIN_CAP, 500),
    dailyWithdrawsPerParty: int(env.DAILY_WITHDRAWS_PER_PARTY, 5),
    dailyWithdrawsPerPrefix: int(env.DAILY_WITHDRAWS_PER_PREFIX, 20),
    dailyTxPerDeal: int(env.DAILY_TX_PER_DEAL, 40),
    dailyRevokeSettlePerDeal: int(env.DAILY_REVOKE_SETTLE_PER_DEAL, 5),
    dailyPayQuotesPerDeal: int(env.DAILY_PAY_QUOTES_PER_DEAL, 8),
    dailyOnchainRevokes: int(env.DAILY_ONCHAIN_REVOKES, 50),
    chainFailsPerDeal: int(env.CHAIN_FAILS_PER_DEAL, 3),
    maxQueuedCriticalPerPrefix: int(env.MAX_QUEUED_CRITICAL_PER_PREFIX, 3),
    actionReserveRelayer: nearToYocto(env.ACTION_RESERVE_RELAYER_NEAR, 0.15),
    joinReserveEscrow: nearToYocto(env.JOIN_RESERVE_ESCROW_NEAR, 0.3),
    joinReserveRelayer: nearToYocto(env.JOIN_RESERVE_RELAYER_NEAR, 0.3),
    offerAlertThreshold: int(env.OFFER_ALERT_THRESHOLD, 1000),
    maxOfferTtlSeconds: int(env.MAX_OFFER_TTL_SECONDS, 7 * 24 * 3600),
    oneClickQuotePublicKey: env.ONECLICK_QUOTE_PUBLIC_KEY || ONE_CLICK_MANAGER_PUBLIC_KEY,
    tokenAccountId: (env.USDC_ASSET_ID || `nep141:${MAINNET_USDC}`).replace(/^nep141:/, ''),
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    lowBalanceRelayer: nearToYocto(env.LOW_BALANCE_RELAYER_NEAR, 2),
    lowBalanceEscrow: nearToYocto(env.LOW_BALANCE_ESCROW_NEAR, 1),
    tokenSymbols: list(env.TOKEN_SYMBOLS, 'USDC,USDT,ETH,SOL,BTC,GRAM,wNEAR,ZEC'),
    tokenChains: list(env.TOKEN_CHAINS, ''),
    dbPath: env.DB_PATH || resolve(SERVER_DIR, 'data', 'escrow.sqlite'),
    corsOrigin: env.CORS_ORIGIN || '*',
    // Minimum review 3 days (also the contract init value).
    minReviewPeriodSeconds: int(env.MIN_REVIEW_PERIOD_SECONDS, 3 * 24 * 3600),
    minDeliverySeconds: int(env.MIN_DELIVERY_SECONDS, 60),
    arbiterApiPublicKey: env.ARBITER_API_PUBLIC_KEY ?? '',
    telegramBotToken: env.TELEGRAM_BOT_TOKEN ?? '',
    telegramBotUsername: botUsername(env.TELEGRAM_BOT_USERNAME),
    notifyPollSeconds: int(env.NOTIFY_POLL_SECONDS, 60),
    telegramReportsChatId: /^-?\d{1,20}$/.test((env.TELEGRAM_REPORTS_CHAT_ID ?? '').trim()) ? (env.TELEGRAM_REPORTS_CHAT_ID ?? '').trim() : '',
    volumeAlertUsdc: Math.max(0, int(env.VOLUME_ALERT_USDC, 10_000)),
    marketRefreshSeconds: int(env.MARKET_REFRESH_SECONDS, 600),
    reviewWindowSeconds: int(env.REVIEW_WINDOW_SECONDS, 3 * 24 * 3600),
    accountRecheckHours: int(env.ACCOUNT_RECHECK_HOURS, 24),
    nearAiApiKey: env.NEARAI_API_KEY ?? '',
    nearAiBaseUrl: (env.NEARAI_BASE_URL || 'https://cloud-api.near.ai/v1').replace(/\/+$/, ''),
    // glm-5.3-flash ignored the thinking switch (14-11 live: empty answers, ~38 s); Qwen3.8-27B: TEE-signed, ~5 s.
    nearAiModel: env.NEARAI_MODEL || 'Qwen/Qwen3.8-27B',
    briefPerMin: int(env.RATE_BRIEF_PER_MIN, 3),
    briefPerDay: int(env.BRIEF_PER_DAY, 30),
  };
}

/** "@PinkyBot" / "PinkyBot" -> "PinkyBot"; anything that is not a Telegram username -> "" (bot off). */
export function botUsername(v: string | undefined): string {
  const u = (v ?? '').trim().replace(/^@/, '');
  return /^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(u) ? u : '';
}

/** "true" -> 1 hop (the left-most X-Forwarded-For entry is client-chosen
 *  behind an appending proxy), a number -> that many hops, anything else
 *  non-empty -> a list of trusted proxy addresses. */
export function parseTrustProxy(v: string | undefined): boolean | number | string {
  if (!v || v === 'false' || v === '0') return false;
  if (v === 'true') return 1;
  if (/^\d+$/.test(v)) return Number(v);
  return v;
}

/** The part of the contract's `get_config` the server limits depend on. */
export interface ContractLimits {
  max_offer_ttl_ns: string;
  min_review_period_ns: string;
  min_amount?: string;
}

/**
 * Tightens the server limits to what the deployed contract accepts, so the
 * server never stores offers whose join can only fail on-chain.
 * Returns what changed (for the start-up log).
 */
export function alignWithContract(c: Config, k: ContractLimits): string[] {
  const changed: string[] = [];
  const ttl = Number(BigInt(k.max_offer_ttl_ns) / 1_000_000_000n);
  if (c.maxOfferTtlSeconds > ttl) {
    changed.push(`maxOfferTtlSeconds ${c.maxOfferTtlSeconds} -> ${ttl}`);
    c.maxOfferTtlSeconds = ttl;
  }
  const minReview = Number((BigInt(k.min_review_period_ns) + 999_999_999n) / 1_000_000_000n);
  if (c.minReviewPeriodSeconds < minReview) {
    changed.push(`minReviewPeriodSeconds ${c.minReviewPeriodSeconds} -> ${minReview}`);
    c.minReviewPeriodSeconds = minReview;
  }
  if (k.min_amount && c.minDealAmount < BigInt(k.min_amount)) {
    changed.push(`minDealAmount ${c.minDealAmount} -> ${k.min_amount}`);
    c.minDealAmount = BigInt(k.min_amount);
  }
  return changed;
}

/** Throws if the config cannot run the relayer. */
export function assertRunnable(c: Config): void {
  const missing = [
    ['ESCROW_CONTRACT_ID', c.contractId],
    ['RELAYER_ACCOUNT_ID', c.relayerAccountId],
    ['RELAYER_PRIVATE_KEY', c.relayerPrivateKey],
  ].filter(([, v]) => !v);
  if (missing.length) {
    throw new Error(`missing env: ${missing.map(([k]) => k).join(', ')}`);
  }
  if (!c.relayerPrivateKey.startsWith('ed25519:')) {
    throw new Error('RELAYER_PRIVATE_KEY must look like "ed25519:<base58>"');
  }
}

/** Safe-to-log summary (no secrets). */
export function describeConfig(c: Config): Record<string, unknown> {
  return {
    network: c.network,
    rpcUrl: c.rpcUrl,
    rpcSendUrl: c.rpcSendUrl === c.rpcUrl ? 'same as rpcUrl' : c.rpcSendUrl,
    contractId: c.contractId,
    relayerAccountId: c.relayerAccountId,
    oneClickApiKey: c.oneClickApiKey ? 'set' : 'NOT SET',
    oneClickForceDry: c.oneClickForceDry,
    usdcAssetId: c.usdcAssetId,
    dbPath: c.dbPath,
    port: c.port,
    telegramBot: c.telegramBotToken && c.telegramBotUsername ? c.telegramBotUsername : 'off',
    reportsChat: c.telegramBotToken && c.telegramReportsChatId ? 'set' : 'off',
    volumeAlertUsdc: c.volumeAlertUsdc || 'off',
  };
}

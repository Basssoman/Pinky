# server — API + relayer

Node 22+ / TypeScript / Fastify. Talks to the escrow contract (near-api-js v7)
and to the NEAR Intents 1Click API. No native modules: storage is the built-in
`node:sqlite`, so the same `node_modules` works in WSL (Node 22) and on
Windows (Node 24).

The relayer only pays gas. It can call `create_deal` (needs a creator-signed
offer plus the client's own key), `act(...)` (needs a deal-key signature it
cannot forge) and the two timeout methods (anyone). It cannot move funds on
its own. Relayer transactions are queued one at a time.

**The routes are in `src/app.ts` and `src/market.ts`; the browser-side checks in `web/src/lib/flows.ts`.**

## Run

```bash
cd server
npm install              # already done; pure-JS deps only
cp .env.example .env     # fill in (see below); .env is git-ignored
npm run build            # tsc -> dist/
npm start                # node dist/src/main.js
```

`npm run dev` = build + start. Node 24 can also run the sources directly
(`node src/main.ts`); WSL's Node 22 cannot, so use `dist/` there.

## Tests

```bash
npm test                 # unit/API tests, mocked chain + mocked 1Click (no network)
npm run test:live        # real 1Click, DRY quotes + GET /v0/tokens only (needs ONECLICK_API_KEY)
bash scripts/e2e.sh      # WSL: local sandbox + contracts + this server, 5 full deal flows
```

`scripts/e2e.sh` builds both wasm files, reuses the `near-sandbox` binary
downloaded by `contract`'s sandbox tests (or `NEAR_SANDBOX_BIN`), deploys
escrow + mock USDC on a fresh local node, starts `dist/src/main.js` as a real
process and walks deals through the REST API exactly like the two browsers
would (creator offer → client joins with its own key → …). Funding is a
direct `ft_transfer_call` (what 1Click does on delivery); 1Click itself is not
called (its base URL points at a closed local port).

## Local stack for the web app

```bash
bash scripts/devstack.sh   # WSL: sandbox + contracts + this server + a stand-in for 1Click
```

It keeps running, writes `web/.env.development.local` (so `npm run dev` in
`web/` talks to it through the Vite proxy) and an arbiter-tool home in
`$HOME/kept-devstack/arbiter`. `curl -X POST http://127.0.0.1:8799/dev/pay`
plays the client's payment (`?short=1`, `?fail=1` for the bad cases). In the
web, `/new?unit=min` reads the day fields as minutes so timers can be watched.

## Arbiter tool

`scripts/arbiter/arbiter.ts` (`node dist/scripts/arbiter/arbiter.js <command>`): `init`, `keys`,
`queue` (disputed deals from the chain with countdowns), `case <id>
[--files <path>...]` (terms, the client's reason, both files links decrypted,
local files checked against the on-chain fingerprint), `resolve <id>
<percent to the creator> "<reason>"` (sends `resolve_dispute` from the
arbiter account after a typed YES, then writes the public log line). Its
keys live in `$ARBITER_HOME/arbiter.json`, apart from the server.

## Marketplace

`src/market.ts` (routes, signature and limit checks) + `src/market-store.ts`
(tables `market_*` in the same SQLite file, created on start: no separate
migration). Creator profiles with services, catalog, client requests
(`/r#token`, only sha256(token) stored), the creator's signed inbox, deal from
request (optional `request_handle` on `POST /api/deals`) and reviews checked
against the contract. Field names: the shared marketplace API contract. Every
profile-key / review signature has `expires_at_ns` (<= 10 min) and is single
use. Operator hide: `node dist/scripts/market-admin.js hide|unhide <profile_id>`,
`reviews <profile_id>`, `hide-review <deal_handle>`. Dev instance (no sends):
`scripts/market-dev-env.sh`.

### Reports

`src/reports.ts`: `POST /api/reports` `{kind, target_id, reason, text?}` —
`kind` = `profile` (24 hex) | `review` / `reply` (review id, 16 hex) |
`request` (handle, 64 hex); `reason` = `scam` | `link` | `offensive` | `other`;
`text` ≤ 500 characters. The target must exist and be shown (else 404).
Limits: 3 per minute per IP, 20 per day per network, 10 per hour per target;
the same person reporting the same thing again the same day is thanked, not
stored twice. Table `reports` in the same SQLite file (created on start). The
reporter's IP is never stored (in-memory rate limiters only). If
`TELEGRAM_BOT_TOKEN` and `TELEGRAM_REPORTS_CHAT_ID` are set, our bot sends ONE
short plain-text message per report to that chat (at most 30 an hour): kind,
reason, the reporter's text with links/domains/e-mails/@names broken up so
nothing in it is clickable, and the item's page on our site (first origin in
`CORS_ORIGIN`). Chat id: send `/chatid` to the bot in that chat (a private
chat with the bot, or a group the bot was added to); the bot answers with it.

Operator: `node dist/scripts/reports.js list [all]`, `show <id>` (what was
reported + the exact hide command), `close <id> [all]`. Hide with
`node dist/scripts/market-admin.js hide <profile_id>` or
`hide-review <deal_handle>` (on the hosted API: inside the app container).

## Environment

Loaded from real env vars, then `$ENV_FILE`, `server/.env`, then the repository
root `.env` (first non-empty value wins). Secrets are never logged.

| Var | Default | Notes |
|---|---|---|
| `ONECLICK_API_KEY` | — | secret; sent as `X-API-Key` |
| `RELAYER_PRIVATE_KEY` | — | secret, `ed25519:...` key of `RELAYER_ACCOUNT_ID` |
| `RELAYER_ACCOUNT_ID` | — | must equal the contract's `relayer_id`; needs NEAR for gas |
| `ESCROW_CONTRACT_ID` | — | escrow account |
| `NEAR_NETWORK` | `sandbox` | `sandbox` \| `testnet` \| `mainnet` |
| `NEAR_RPC_URL` | per network | sandbox `http://127.0.0.1:3030`, FastNEAR for testnet/mainnet |
| `PORT` / `HOST` | `8787` / `127.0.0.1` | |
| `CORS_ORIGIN` | `*` | comma-separated list in production |
| `TRUST_PROXY` | `false` | number of proxy hops (`true` = 1) or proxy addresses; only behind a reverse proxy |
| `NEAR_RPC_SEND_URL` | `NEAR_RPC_URL` | separate (ideally paid) RPC for relayer sends, so view floods cannot block them |
| `RELAYER_SEND_TIMEOUT_SECONDS` | `120` | max wait for one relayer send; then 504 `relayer_timeout` and the queue moves on (a join first re-reads the chain for up to 20 s and answers success if it landed) |
| `DB_PATH` | `server/data/escrow.sqlite` | `:memory:` for throwaway runs |
| `ONECLICK_BASE_URL` | `https://1click.chaindefuser.com` | |
| `ONECLICK_FORCE_DRY` | **`true`** | every quote is `dry` unless set to `false` (real payments) |
| `ONECLICK_SLIPPAGE_BPS` | `100` | |
| `QUOTE_DEADLINE_SECONDS` | `1800` | 1Click `deadline` for our quotes |
| `WITHDRAW_EXPIRY_MARGIN_SECONDS` | `300` | withdraw `expires_at_ns` = quote deadline − margin |
| `PAYOUT_REFUND_TYPE` | `INTENTS` | or `CONFIDENTIAL_INTENTS`; refundTo is always the party's implicit account |
| `USDC_ASSET_ID` | `nep141:17208628…6133a1` | escrow token as 1Click asset id |
| `MAX_DEAL_USDC` | `2000` | largest accepted offer |
| `MIN_DEAL_USDC` | `1` | smallest accepted offer; never below the contract's 1 USDC |
| `FEE_BPS` | `300` | every offer must carry exactly this `fee_bps` (contract v2, ≤ 300) |
| `MIN_REVIEW_PERIOD_SECONDS` / `MIN_DELIVERY_SECONDS` | `259200` / `60` | keep ≥ the contract's `min_review_period_ns`; delivery = work time from funding (max 90 days) |
| `RATE_READS_PER_MIN` / `RATE_WRITES_PER_MIN` | `120` / `20` | reads per IP / new offers per IP |
| `RATE_INVALID_PER_MIN` | `30` | invalid or unauthenticated write requests per IP |
| `RATE_SIGNER_PER_MIN` / `RATE_QUOTES_PER_MIN` | `20` / `10` | failing signed actions / quotes per deal key (valid actions are never limited) |
| `DAILY_OFFERS_PER_IP` / `DAILY_JOINS_PER_IP` | `50` / `20` | rolling 24 h caps per network prefix (IPv4 /24, IPv6 /48) |
| `DAILY_JOIN_CAP` | `500` | global rolling 24 h join cap (refuses; the server log warns at 80 %, at most hourly) |
| `DAILY_WITHDRAWS_PER_PARTY` / `DAILY_WITHDRAWS_PER_PREFIX` | `5` / `20` | relayed withdraw attempts per deal party / per network prefix per rolling 24 h (no relayed withdraw below 0.1 USDC) |
| `DAILY_TX_PER_DEAL` / `DAILY_REVOKE_SETTLE_PER_DEAL` | `40` / `5` | relayed non-time-critical txs per deal per day (deliver/dispute are never limited) |
| `DAILY_PAY_QUOTES_PER_DEAL` | `8` | pay quotes per deal per day (bounds how long a client can block cancel) |
| `DAILY_ONCHAIN_REVOKES` | `50` | on-chain `revoke_offer`s per day; above it a revoke is kept in the DB only |
| `CHAIN_FAILS_PER_DEAL` | `3` | contract rejections per deal / join link in 10 min before a 10 min pause |
| `MAX_QUEUED_CRITICAL_PER_PREFIX` | `3` | deliver/dispute txs one network prefix may have waiting at once |
| `ACTION_RESERVE_RELAYER_NEAR` | `0.15` | non-time-critical txs pause (503) below this free relayer NEAR |
| `JOIN_RESERVE_ESCROW_NEAR` / `JOIN_RESERVE_RELAYER_NEAR` | `0.3` / `0.3` | new joins pause (503 `low_balance`) while free NEAR is below these |
| `OFFER_ALERT_THRESHOLD` | `1000` | offers in 24 h above this only raise a server log warning (never in the public `/api/health`) |
| `MAX_OFFER_TTL_SECONDS` | `604800` | max offer lifetime |
| `ONECLICK_QUOTE_PUBLIC_KEY` | 1Click SDK key | every quote signature is verified with it |
| `LOW_BALANCE_RELAYER_NEAR` / `LOW_BALANCE_ESCROW_NEAR` | `2` / `1` | `/api/health` warnings |
| `TOKEN_SYMBOLS` / `TOKEN_CHAINS` | `USDC,USDT,ETH,SOL,BTC,GRAM,wNEAR,ZEC` (GRAM = 1Click's name for TON) / all | filter for `GET /api/tokens` |
| `ARBITER_API_PUBLIC_KEY` | — | ed25519 key of the arbiter tool (the arbiter tool `keys` command prints it); without it the `/api/arbiter/*` routes do not exist |
| `MARKET_REFRESH_SECONDS` | `600` | marketplace: re-read unfinished deals made from catalog requests this often; `0` = off |
| `ACCOUNT_RECHECK_HOURS` | `24` | marketplace: re-read the bios of confirmed creator accounts (YouTube / Behance) this often; the mark goes when the code is gone; `0` = off |
| `REVIEW_WINDOW_SECONDS` | `259200` (3 days) | a review can be written or edited this long after the deal ended on-chain, then it is locked |
| `NEARAI_API_KEY` | — | AI brief helper on NEAR AI Cloud; empty = off (the site hides the button). Never sent to the browser |
| `NEARAI_BASE_URL` / `NEARAI_MODEL` | `https://cloud-api.near.ai/v1` / `z-ai/glm-5.3-flash` | NEAR AI endpoint and a PRIVATE (TEE) model |
| `RATE_BRIEF_PER_MIN` / `BRIEF_PER_DAY` | `3` / `30` | brief helper calls per IP per minute / per network per day |
| `TELEGRAM_REPORTS_CHAT_ID` | — | Telegram chat id (a number; groups are negative) for "Report" messages from our bot; needs `TELEGRAM_BOT_TOKEN`. Empty = reports are only stored. Get it with `/chatid` sent to the bot |
| `LOG_LEVEL` | `info` | request logs contain method/url/status only |

## Deploy checklist (contract side, not automated here)

1. `cargo near build non-reproducible-wasm` in `contract/` (WSL).
2. Deploy **and** call `new(owner_id, token_id, arbiter_id, relayer_id,
   fee_account_id, periods?)` in one transaction signed by the escrow account
   (`new` is `#[private]`). Owner ≠ relayer ≠ arbiter. `periods` only for a
   short-period test instance; `admin_delay_ns` must be ≥
   `dispute_period_ns`. Register the fee account with the token before it
   calls `withdraw_fees`.
3. **Register the escrow with the token**: `storage_deposit({account_id: <escrow>})`
   on the USDC contract, otherwise deliveries via `ft_transfer_call` fail.
4. Fund the escrow account with NEAR for its code and own state only.
   Contract v2: the relayer (not the escrow) attaches 0.01 NEAR to each
   `create_deal` (the deal's storage) and 0.00225 NEAR to each withdraw, so
   budget both in the relayer's NEAR. Use a fresh DB.
5. Mainnet: delete all full-access keys of the escrow account (no upgrades).

# Pinky

Private escrow deals for freelance creators (video, design, motion, code),
plus a small catalog of creators. Built on NEAR.

- Site: https://pinkydeals.pages.dev
- Judges: start with [VERIFY.md](VERIFY.md) (step-by-step check, real mainnet
  transactions, `npm run verify`).
- Code: https://github.com/Basssoman/pinky
- Demo video: coming with the submission
- Tracks: **realworld**, **privacy**
- License: [MIT](LICENSE)

## What it is

A creator and a client agree on a job anywhere (Telegram, X, email). The
creator opens a deal on the site and sends the client a link. The client pays
with almost any coin from almost any chain; NEAR Intents (1Click) converts it
to USDC and delivers it into the escrow contract on NEAR. The creator
delivers; the client accepts, or the money is released automatically when the
review period ends. If the creator misses the deadline, the client takes the
money back. If they disagree, they can agree on a split themselves, or the
client opens a dispute and the arbiter decides.

Nobody needs a NEAR account, a wallet, gas or ID documents. Each side gets a
one-time key made in their own browser; the contract knows the deal only by
those two public keys, never by a wallet address. The terms stay off-chain;
the chain stores a salted hash of them.

On top of deals sits a small marketplace: a catalog of creators by category,
profiles with services, an order form, and reviews that only a finished deal
can leave. A deal can still start from a plain link sent in any chat.

## How a deal works

```
creator browser                 server (relayer)               NEAR mainnet
---------------                 ----------------               ------------
makes creator key
signs the offer  ──── link ───► stores the offer
                                (link token only as sha256)
                     client browser
                     makes client key, checks the
                     creator's signature on the terms
                     "join" ───────► create_deal(offer, sig, client_pk) ──► Created
                     pays any coin ─► 1Click quote ──► USDC ft_transfer_call ─► Funded
creator signs "deliver" (file fingerprint) ─► act(...) ──────────────────► Delivered
client signs "accept"  ─────────────────────► act(...) ──────────────────► Released
   (or: review period ends → anyone calls release_after_timeout)
creator signs "withdraw {destination, amount, expiry}" ─► act(...) ─► USDC → 1Click → any chain
```

- Every party action is `act(deal_id, action, payload, signature)`. The
  signature covers `escrow-v1|{contract_id}|{deal_id}|{action}|{payload}`, so
  it cannot be reused on another deal, another contract or another action.
- `act` is permissionless: the relayer only pays gas. If our server refuses or
  is down, anyone can submit the same signed action from any NEAR account.
- A withdraw signature names the destination, the amount and an expiry, so
  the relayer cannot send the money anywhere else.
- Fee: 3% of what the creator receives, only on success; a refund returns
  100% to the client.
- Timers (production values): client has 7 days to pay, review period ≥ 3
  days, dispute period 7 days. After the dispute period the arbiter can no
  longer decide; anyone can apply a 50/50 split.

Full state machine and contract methods:
[contract/README.md](contract/README.md) and the doc comments in `contract/src/lib.rs`.

## Architecture

| Part | Folder | What it does |
|---|---|---|
| Contract | `contract/` | Rust, near-sdk 5.29. Holds the USDC, checks every signature, enforces deadlines, keeps per-deal accounting. No upgrade method. |
| Server | `server/` | Node 22 + TypeScript + Fastify + SQLite. REST API, relayer (pays gas, cannot forge signatures), 1Click quotes (each quote's signature is verified), marketplace, arbiter tool, Telegram notifications, AI brief helper (NEAR AI Cloud). |
| Site | `web/` | Vite + React, static (Cloudflare Pages). Makes and keeps the deal keys in the browser, signs actions, reads the deal state from public NEAR RPC itself. The contract id, the USDC token and the 1Click quote key are hard-coded in the site, never taken from our API. |
| Verify | `verify/`, `contract/tests/verify.rs` | `npm run verify`: attack suite on a local sandbox + read-only mainnet checks. |

## Run from scratch

Linux, macOS or WSL. Needs:

- Rust via rustup (the toolchain `1.93.0` + `wasm32-unknown-unknown` is
  pinned in `contract/rust-toolchain.toml` and installs itself),
- `cargo install cargo-near` (tested with 0.22),
- Node.js ≥ 22.13,
- optional: Docker, for the reproducible contract build.

```bash
git clone https://github.com/Basssoman/pinky pinky && cd pinky

# 1. Everything a judge needs, one command (no npm install at the root):
npm run verify

# 2. Contract tests
cd contract
cargo test --lib                          # unit tests
cargo test --test sandbox                 # integration tests on near-sandbox
cargo test --test verify -- --nocapture    # the attack suite alone
cargo near build reproducible-wasm        # docker; or non-reproducible-wasm
cd ..

# 3. Server
cd server && npm ci && npm test && cd ..

# 4. Site
cd web && npm ci && npm test && cd ..

# 5. Whole stack locally (sandbox chain + contracts + server + 1Click stand-in),
#    then the site in dev mode against it:
CARGO_TARGET_DIR_BASE=$HOME/target bash server/scripts/devstack.sh   # terminal 1
cd web && npm run dev                                                 # terminal 2, http://localhost:5173
```

The first sandbox run downloads the `near-sandbox` binary and compiles the
contract; it takes a few minutes. Keep `CARGO_TARGET_DIR` on a Linux
filesystem in WSL (builds on the Windows drive are slow).

Server configuration: copy `server/.env.example` to `server/.env`. All
variables are listed in [server/README.md](server/README.md#environment).
Secrets (`ONECLICK_API_KEY`, `RELAYER_PRIVATE_KEY`, `NEARAI_API_KEY`,
`TELEGRAM_BOT_TOKEN`) only live in `.env` / environment variables; quotes are
dry (`ONECLICK_FORCE_DRY=true`) unless you set it to `false`.

## Mainnet

| What | Account |
|---|---|
| Escrow (live, real periods) | [`escrow.pinkydeals.near`](https://nearblocks.io/address/escrow.pinkydeals.near) |
| Escrow, TEST instance (short periods, our first live deals; deleted 2026-11-14) | [`9e537c21…c2c9c`](https://nearblocks.io/address/9e537c21716b2035d7c88f153f0283e8dda925af16bbb6cf6ea23256436c2c9c) |
| Token: NEAR-native USDC | [`17208628…6133a1`](https://nearblocks.io/address/17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1) |

`escrow.pinkydeals.near` is a reproducible build of this repository at commit
`912cb4b` (sha256 `6b5193ae…9649`, [VERIFY.md step 6](VERIFY.md#6-rebuild-the-contract-and-compare-it-with-the-chain-510-min-docker)).
Its deploy key was deleted on 2026-11-14 (tx [`GCPjUcna…`](https://nearblocks.io/txns/GCPjUcna7FdwZjv9sAdcNANXw4GRMdbsLPQ7vLyzUiKi)): the account has
no keys, so nobody, us included, can change the code. Check it any
time with `view_access_key_list` or `npm run verify:mainnet -- --build none`.

The TEST instance had short timers (review 5 min, dispute 15 min, pay-by 3 h)
and was deleted after the final contract went live. Its real deal
transactions are listed in [VERIFY.md](VERIFY.md#earlier-deals-on-the-test-instance)
and can still be checked from an archival node.

## Threat model

What we protect: the money in a deal, and who is behind a deal.

| Who | Can | Cannot |
|---|---|---|
| Outsider on the chain | see every deal's amount, state, timestamps, the two one-time public keys, payout destinations (1Click deposit addresses) | see the terms (only a salted hash), link a deal to the client's or creator's wallet through the escrow |
| Someone who stole only the link | read the terms; join before the real client while nobody has joined (limited by the offer expiry; the creator sees the client-key fingerprint and can compare it in chat) | act for a party after the join: every action needs that party's key |
| The relayer / our server | delay or refuse to relay; see plain terms, IP addresses, request times; see refund and payout addresses in transit (sent to 1Click, not stored); ask 1Click for a public instead of a confidential route (not covered by the quote signature) | forge a party's signature; change a signed price; redirect a withdraw (destination is signed); point the site at another contract (hard-coded) |
| Creator | cancel before payment, refund the client while the work is in progress, deliver before the deadline | take the money before the client accepts or the review period ends; accept their own work |
| Client | accept, dispute during the review period, refund only after a missed deadline | take the money back early; dispute after the review period |
| Arbiter (the team) | decide any split of a disputed deal while the dispute period runs | touch a deal nobody disputed; decide after the dispute period; give more than 100% |
| Contract owner (the team) | rotate the relayer at once; change arbiter / fee account only after a public delay ≥ the dispute period; sweep tokens that belong to no deal; reconcile a stuck withdraw | take deal money, unless it misreports a reconcile of a stuck withdraw (every reconcile is logged with the receipt it claims) |
| Anyone, us included, after the deploy key was deleted (see [Mainnet](#mainnet)) | nothing on the contract account itself: it has no keys | replace the contract code, or take what the escrow holds |
| Holder of our 1Click API key (operator, or a thief of `.env`) | query 1Click status for our deposit addresses and learn the client's refund wallet and the deal id | move any money |

Every "cannot" in the contract rows is exercised by `npm run verify`
(attack suite, [VERIFY.md](VERIFY.md#what-npm-run-verify-checks)).

## Honest limits

These are true today.

- **Disputes are decided by people, by us.** The arbiter account is operated
  by the Pinky team. It can pick any split while a dispute is open. After the
  dispute period only a 50/50 split is possible. An AI arbiter is not built.
- **The owner is trusted.** Owner and arbiter are operated by the project.
  The owner can appoint a new arbiter, but only after a public delay that is
  at least the dispute period, so it can only decide disputes opened while the
  change was visibly pending.
- **Payments are on a public chain.** Amounts, states, timestamps, keys,
  payout destinations and event logs are public. The client's transaction on
  its own chain to a 1Click deposit address is public there; unlinking it from
  the deal depends on 1Click's confidential mode.
- **Our server sees a lot:** the plain terms and request briefs, IP
  addresses, which link maps to which on-chain deal, refund and payout
  addresses in transit, per-creator deal volume, Telegram chat ids for
  people who turned notifications on. It never sees private keys; link tokens
  are stored only as hashes.
- **Our 1Click API key is a de-anonymization secret:** whoever holds it can
  ask 1Click about our deposit addresses and see the client's refund wallet
  and the deal id.
- **Confidential routing is trusted to the operator.** The 1Click quote
  signature does not cover the `confidentiality` field.
- **A hacked website could fake the checks.** The site checks the terms
  signature, the contract id and the deal state from the chain, but a
  modified site could skip those checks (true of any website).
- **Third parties:** Telegram (bot messages are not end-to-end encrypted),
  NEAR AI Cloud (receives each brief; marked verified only when the TEE
  signature checks out — today only the Intel TDX quote is checked, the NVIDIA
  GPU attestation service did not answer us), the static host/CDN (sees IPs
  and page types, never the link fragments).
- **Outage fallback costs privacy.** If our server is down, a party can send
  its signed action from its own NEAR wallet (~0.1 NEAR), which links that
  wallet to the deal on-chain.
- **No upgrades, no audit yet.** The contract has no upgrade method and
  no keys (the deploy key was deleted on 2026-11-14): it cannot be changed or
  patched by anyone, and a fix means a new contract. It has had internal security reviews, not an
  external audit.
- **The demo API runs on a single small server**; it may be slow
  or briefly offline.

## Repository

```
contract/   escrow contract (Rust) + mock token + sandbox tests + attack suite
server/     API, relayer, marketplace, arbiter tool, bot, AI brief helper
web/        the site
verify/     npm run verify: runner + list of real mainnet deal transactions
```

License: [MIT](LICENSE).

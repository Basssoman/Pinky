# Pinky — check it yourself

Pinky is private escrow for freelance creators on NEAR: the client pays from
any chain (NEAR Intents / 1Click), the contract holds USDC, one-time browser
keys sign every action, no wallet or account for either side. Overview and
architecture: [README.md](README.md). Honest limits: [README.md#honest-limits](README.md#honest-limits).

Everything below is read-only. Nothing here signs a transaction or moves money.

> **Which contract?** The live contract is **`escrow.pinkydeals.near`**
> (mainnet, real USDC, real timers: review ≥ 3 days, dispute 7 days, pay-by
> 7 days). It was built reproducibly from this repository at commit
> [`912cb4b`](https://github.com/Basssoman/pinky/tree/912cb4b6a0b7ee8ae8af1e81b900671ab3a2dd22);
> step 6 rebuilds it byte for byte. Its last full-access key (`EfkwMx…`, the
> deploy key) is still on the account and will be deleted; until then the
> "full-access keys" check below prints `FAIL`, and that is the honest answer.
>
> Our first live deals (8 of them, 2026-11-06..11) ran on a **TEST instance**
> `9e537c21716b2035d7c88f153f0283e8dda925af16bbb6cf6ea23256436c2c9c` with
> short timers. That account was deleted on 2026-11-14 after the final
> contract went live; its history stays on archival nodes and explorers, and
> `npm run verify` can still check it (see [Earlier deals](#earlier-deals-on-the-test-instance)).

## Step by step: try a deal

Needs: Node.js ≥ 22 and `curl`. Step 6 also needs Rust + `cargo-near` + Docker
(see [README.md#run-from-scratch](README.md#run-from-scratch)).

### 1. Open the site (30 s)

Do: open https://pinkydeals.pages.dev

You see: the headline "Safe deals for freelance work with people you don’t
know". Click the button to start a deal: you get the "New deal" form. No
"connect wallet" anywhere; keys are made in the browser.

### 2. Open the contract on the explorer (30 s)

Do: open https://nearblocks.io/address/escrow.pinkydeals.near

You see: the deploy + init transaction (2026-11-13) and deal 0 on 2026-11-14:
`create_deal`, then three `act` calls and the USDC payment arriving through
`ft_on_transfer`. The `create_deal` and `act` calls come from one relayer
account `f1fb5d0a…9531a5`; the relayer only pays gas, the party's signature is
inside the arguments.

### 3. Read the finished deal straight from the chain (1 min)

Do:

```bash
curl -s https://rpc.mainnet.fastnear.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"call_function","finality":"final","account_id":"escrow.pinkydeals.near","method_name":"get_deal","args_base64":"eyJkZWFsX2lkIjowfQ=="}}' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(Buffer.from(JSON.parse(s).result.result).toString()))'
```

(`eyJkZWFsX2lkIjowfQ==` is base64 of `{"deal_id":0}`.)

You see (excerpt):

```
"id":0, "amount":"1000000", "funded_amount":"1000000", "state":"PaidOut",
"creator_pk":"ed25519:G3z9hD2kEsTH3i47tAHRtx8ZX6dVVxu8PYCRuPJEbwkZ",
"client_pk":"ed25519:5wKxUEF7ytqVxsqESEwkR4jTqBNdrNTZrhntkmv4aJE6",
"fee_bps":300, "fee_amount":"30000",
"deliverable_hash":"v1:283d988bcf0d0f52e0849869f870af9bc99eeb833dd837ba8f99c43233d011b9",
"terms_hash":"7c8c8e50d6b71483d9f2312036238983fe66022804dc5efb1188703c6f6d28cd",
"outcome":"Accepted", "creator_withdrawn":"970000", "client_withdrawn":"0",
"creator_fingerprint":"5a15-6212-2531", "client_fingerprint":"f8f9-a4dd-9768"
```

What it shows: the deal knows its parties only as two one-time keys (no
wallet addresses), the terms only as a salted hash, the delivered file only
as a fingerprint. 1 USDC paid, 3% fee kept, 0.97 USDC paid out to the creator.

### 4. Look at the payout transaction (1 min)

Do: open https://nearblocks.io/txns/C6vcxwK8DeLe1u1zFngMRwFZnyNgf9fAhjTtu6DGW9Hi

You see: method `act`, arguments

```
{"deal_id":0,"action":"withdraw",
 "payload":"{\"destination\":\"31719930dafb741b3537624ff61379efb07642c0b7500cf01834ec3fc9c8720c\",\"amount\":\"970000\",\"expires_at_ns\":\"1794619415014000000\"}",
 "signature":"aUwEuKjG…"}
```

and the logs `withdraw_started` → USDC `ft_transfer` of 970000 from the
escrow to `31719930…` (a 1Click deposit address, which forwards to the
creator's chosen chain) → `withdraw_done`. The destination is inside the
signed payload: changing it breaks the creator's signature (step 5
re-verifies every such signature; attack 24 shows the contract refusing a
redirect).

### 5. Run the proof script (1 min, no Rust needed)

Do (from a clone of this repository, no `npm install`):

```bash
npm run verify:mainnet -- --build none
```

You see, about 10 s later:

```
PASS  contract account exists on mainnet
INFO  code hash vs local build                      (skipped: --build none)
INFO  NEP-330 contract_source_metadata              (link to github.com/Basssoman/pinky @ 912cb4b)
FAIL  full-access keys present (1)                  (the deploy key, until it is deleted; then: PASS no full-access keys)
PASS  accepted token is NEAR-native USDC
PASS  config: 1 deals, fee max 300 bps, ...         (real periods: review >= 3 days, dispute 7 days)
PASS  deal transactions found on mainnet, succeeded, right contract/method/deal: 5/5
PASS  relayed actions carry a valid deal-key signature (re-verified here with ed25519): 4/4
PASS  deal outcomes on chain match the table: 1/1
```

Exit code 0 means every check behaved as expected (after the key is deleted).

With Rust installed, the attack suite runs too (the first run compiles for a
few minutes):

```bash
npm run verify -- --build none
```

You see 42 lines `REFUSED  ATTACK …` each followed by the contract's own
error, 16 lines `OK …`, then

```
VERIFY_SANDBOX attacks_refused=42/42 honest_ok=16/16 failures=0
PASS  sandbox attacks refused for the expected reason: 42/42
PASS  sandbox honest paths OK: 16/16
```

followed by the mainnet lines of step 5.

### 6. Rebuild the contract and compare it with the chain (5–10 min, Docker)

The wasm carries the commit it was built from, so check out exactly that
commit first:

```bash
git checkout 912cb4b
cd contract && cargo near build reproducible-wasm
sha256sum target/near/escrow.wasm
```

You see `6b5193ae00325d2261a068413649eda9c4e74f368713fb5f04da8835555b9649`.
The contract's `code_hash` on chain is `8DvmhWF9M5B1dJbXkCRYQive2AJyKKAnJSk3w5uojYqW`:
the same 32 bytes written in base58. So the chain runs exactly the code of
this repository. (`npm run verify` from a newer commit tells you this and
prints the same commands.)

## Real mainnet deals

### On the final contract `escrow.pinkydeals.near`

Real USDC; the client paid from another chain through 1Click. Funding
arrives as a receipt from the USDC token (`ft_transfer_call`), so it is not a
transaction to the escrow; `funded_amount` in `get_deal` shows it.
Machine-readable list: [verify/mainnet-txs.json](verify/mainnet-txs.json)
(checked by `npm run verify`).

| Deal | Amount | Outcome | Transactions (nearblocks) |
|---|---|---|---|
| 0 | 1 USDC | accepted, creator paid 0.97 (through the site) | [join](https://nearblocks.io/txns/DiTcN7zkVAVp9ptahSxNyGKkF3JKRsfjWd7SHY4sWRt) · [deliver](https://nearblocks.io/txns/6VZr6gs6KEuf46qYRzfdTB1WXoF78YjVsxM5u38fbEWA) · [accept](https://nearblocks.io/txns/4u3FXfnftBUU5NJ9bj1z4MXRtE68TjXXtftqNPmrDieH) · [withdraw](https://nearblocks.io/txns/C6vcxwK8DeLe1u1zFngMRwFZnyNgf9fAhjTtu6DGW9Hi) |

Contract deploy + init (one transaction, `new` is private):
[4osoXnj9…](https://nearblocks.io/txns/4osoXnj9UMbs9XzEz5FPLmUu2Vgy3SaqPASw7nxzJBCe).

### Earlier deals on the TEST instance

TEST instance `9e537c21716b2035d7c88f153f0283e8dda925af16bbb6cf6ea23256436c2c9c`
(short timers: review 5 min, dispute 15 min, pay-by 3 h), deleted on
2026-11-14. The explorer links still work; to re-check them from an archival
node (the last block before the deletion):

```bash
npm run verify:mainnet -- --build none --contract 9e537c21716b2035d7c88f153f0283e8dda925af16bbb6cf6ea23256436c2c9c
```

You see `PASS … 30/30` transactions, `PASS … 28/28` signatures, `PASS … 7/7`
outcomes.

| Deal | Amount | Outcome | Transactions (nearblocks) |
|---|---|---|---|
| 0 | 5 USDC | accepted, creator paid 4.85 | [join](https://nearblocks.io/txns/4vPYvHDUK92sjGJU1WUQbBRmS2tQQpUzuhVXnXeSju2j) · [deliver](https://nearblocks.io/txns/7Py9xhyKcWU6GX42unQyTxEfdKrAPJG6akPLpcbxRBLb) · [accept](https://nearblocks.io/txns/AaAVdpEzkbasViw5S8CWrPyNfDqKyFnfxpxuSE62JNs1) · [withdraw](https://nearblocks.io/txns/91pze9kVnWgXZNJnmQqx8T8F2xgt7jgBjnzUbcgSbXfJ) |
| 1 | 2 USDC | dispute, arbiter split 60/40 | [join](https://nearblocks.io/txns/Bv7QvExFLTHcygyQn3imwjvnqqe2q9xfEKygiszzxqNs) · [deliver](https://nearblocks.io/txns/GXjnyCCsY1djY8UcnCpMB34ca73HUWnFqN1Ch1E8HDpr) · [dispute](https://nearblocks.io/txns/93oM2tMJdPt4mxK7HGnAyUDb6osGTu12mLKd9zyFz7Ns) · [arbiter](https://nearblocks.io/txns/LX7kzzMKGcS82K9HWkexDcTxM2YDfQQnjtVYZCSdkgC) · [withdraw](https://nearblocks.io/txns/EE9ppzeknfD8uFYpYGvPKvb13eTvCVDCH9Vg1w2631Kz) · [withdraw](https://nearblocks.io/txns/FZGottpC5KS6yKXvD6FSWNegtrDBwnk22h6H54WJyySV) |
| 2 | 2 USDC | both sides agreed 70/30 (settle) | [join](https://nearblocks.io/txns/CtovZ9QT4Y8wXN2n4sEN7fyEyrQn8sNpqYFkiSrqvHur) · [settle](https://nearblocks.io/txns/GntGRqdGJ4veFzUQvAs8YpBcPL9vJWCeyTVyyq6JTyqa) · [withdraw](https://nearblocks.io/txns/DuLaNvVQD69X47WCiK2VGNEsspqw2eacLXvpeBEh2aNE) · [withdraw](https://nearblocks.io/txns/HMHCfNKKyzTWcBhwZ1Xh2922J6zRS4uiHuPZ2KZaYeFx) |
| 3 | 2 USDC | creator refunded the client | [join](https://nearblocks.io/txns/9zuGLNsPKsytngjhAFJjBNExeNvPkTVnfaBsbqi7MdGv) · [refund](https://nearblocks.io/txns/hnXhmaYFNvFnje9Sbi8mtDcfmvhbNxdmzQDEjme423Y) · [withdraw](https://nearblocks.io/txns/AqH62jXgVgukm3YRUtesWYDVGTTgysXF4pciRqq86VRK) |
| 4 | 2 USDC | accepted (through the site) | [join](https://nearblocks.io/txns/tRtmVHwvary2sGKr1Di7qcWpTrLJsMHYSXvVmGTQkgz) · [deliver](https://nearblocks.io/txns/5PfphXYbDrzthn4ziTwKmn2vaQu5Wkbt8oB6fPjkfssd) · [accept](https://nearblocks.io/txns/612hhRywQtvzzZGotdXZYaLduu7Nw2ptH3cJLozrPxz2) · [withdraw](https://nearblocks.io/txns/DrqCUbE53Gq5XBDfeoDW5vKckcCzugzaAm99smfYrHUS) |
| 5 | 5 USDC | accepted (through the site) | [join](https://nearblocks.io/txns/3wpLkbCds9PwJ2MNotkudjDDWjtQfysmnU5htg8fCQb1) · [deliver](https://nearblocks.io/txns/DhKAfZJEy68f4uqdUfru17tv8bNj6THJ6aDW11wLtTzg) · [accept](https://nearblocks.io/txns/CJKY65mTsPveJ6xf9DJcmiPDvPLxY544EJDu4k9po5PL) · [withdraw](https://nearblocks.io/txns/C2vduSdnrmZW8EAGLH3LAg8W4P7EJ16kKuvC78sBxs6S) |
| 6 | 5 USDC | joined, never paid | [join](https://nearblocks.io/txns/8FoBjEfu7oVUtnu2qPSjS4CPzsyfXewq2pR4aqh7oRUN) |
| 7 | 1 USDC | creator refunded the client (through the site) | [join](https://nearblocks.io/txns/CeSv4gW5xVtmU3eTpkZkM2P1sDmEp4WGPdgtNCPRqsG2) · [refund](https://nearblocks.io/txns/FxFT4NfNpsDWioCwTh4qjQEhCfZvRxQQaK49H2SkZMUC) · [withdraw](https://nearblocks.io/txns/7r1GTr3zJ15k6LJ3p2iYTb1MnneSnkXgaNhoyKeJxuVQ) |

TEST deploy + init: [3xDGzqVn…](https://nearblocks.io/txns/3xDGzqVnEHSeeJyJ2QTdDBuvCb4rR789Goyxp5x9pPAj).
Deals 0–3 were driven by our live kit on 2026-11-06, deals 4–7 through the
site on 2026-11-11. On the TEST instance the arbiter is the team (deal 1).

## What `npm run verify` checks

Runner: [verify/verify.mjs](verify/verify.mjs). Root `package.json` scripts:
`verify` (all), `verify:sandbox` (Part A only), `verify:mainnet` (Part B only).

```bash
npm run verify -- --contract <account>            # check another deployment (default: escrow.pinkydeals.near)
npm run verify -- --build reproducible            # NEP-330 reproducible build in docker
npm run verify -- --wasm path/to/escrow.wasm      # compare a wasm you built yourself
```

`NEAR_RPC` / `NEAR_ARCHIVAL_RPC` (comma-separated) override the public RPCs.

### Part A — local sandbox ([contract/tests/verify.rs](contract/tests/verify.rs))

Builds the real escrow wasm and a mock USDC token, starts `near-sandbox`, and
tries to break the contract. An attack counts as REFUSED only if the contract
panics **with the expected message** (refused for the right reason). Each
honest step must succeed and leave the expected balances.

| # | Attack | Contract's answer |
|---|---|---|
| 01 | a stranger account creates a deal directly | `only relayer` |
| 02 | offer signed by another key in the creator's name | `offer: invalid creator signature` |
| 03 | server changes the price in a signed offer | `offer: invalid creator signature` |
| 04 | join with a weak (small-order) key | `public key: weak (small-order or non-canonical) ed25519 point` |
| 06 | replay the offer for a second deal | `offer already used or revoked` |
| 08 | start a deal from a revoked link | `offer already used or revoked` |
| 09 | deliver before the client paid | `deliver: deal must be Funded` |
| 10 | fake payment: call `ft_on_transfer` directly | ignored, returned in full; deal stays unfunded |
| 12–13 | fake delivery signed by the client / an outsider | `invalid signature (creator key required)` |
| 14 | creator takes the money while the work is in progress | `withdraw: nothing to withdraw for this key` |
| 15 | client withdraws the paid money early | `withdraw: nothing to withdraw for this key` |
| 16 | client refunds before the deadline | `refund: client may refund only after the delivery deadline` |
| 17 | arbiter decides a deal nobody disputed | `deal must be Disputed` |
| 19 | creator accepts their own work | `invalid signature (client key required)` |
| 20 | creator takes the money before acceptance | `withdraw: nothing to withdraw for this key` |
| 21 | early auto-release | `review period is not over yet` |
| 22 | signature made for another contract | `invalid signature (client key required)` |
| 24 | relayer redirects the payout | `invalid signature` |
| 25 | withdraw more than the payout | `withdraw: amount exceeds the withdrawable payout` |
| 26 | expired withdraw signature | `withdraw: signature expired` |
| 27 | withdraw into the escrow itself | `withdraw: bad destination` |
| 28 | client takes the creator's released money | `withdraw: nothing to withdraw for this key` |
| 30 | replay a withdraw (pay twice) | `withdraw: signature already used` |
| 31 | replay deal 0's accept on deal 1 (same keys) | `invalid signature (client key required)` |
| 33–34 | owner / relayer decides a dispute | `only arbiter` |
| 35 | arbiter gives the creator more than 100% | `creator_share_bps must be <= 10000` |
| 37 | arbiter changes a decided dispute | `deal must be Disputed` |
| 39 | creator signs a settle for both sides | `settle: invalid client signature` |
| 41 | submit a settle the client took back | `settle: revoked (settle_seq changed)` |
| 43 | replay a settle | `settle: deal state differs from the signed state` |
| 44 | a stranger takes the fees | `only fee account` |
| 45 | fee account takes deal money | `amount exceeds accrued fees` |
| 46 | a stranger sweeps the escrow | `only owner` |
| 47 | owner sweeps deal money as "orphans" | `amount exceeds orphan_amount` |
| 48 | relayer appoints itself arbiter | `only owner` |
| 49 | 50/50 timeout before the dispute period ends | `dispute period is not over yet` |
| 50 | deliver after the deadline | `deliver: delivery deadline has passed` |
| 52 | creator withdraws from a refunded deal | `withdraw: nothing to withdraw for this key` |
| 54 | dispute after the review period | `dispute: review period is over` |
| 56 | arbiter decides after the dispute period | `the dispute period is over; only the timeout split applies` |

Honest paths (OK): join, revoke a link, pay, deliver, accept with the 3% fee
from the creator's share, withdraw to the signed destination, dispute → arbiter
70/30 → both withdraw, revoke a settle proposal, settle 90/10, refund after a
missed deadline (100% back), auto-release after the review period, 50/50
timeout split, and at the end: escrow token balance = total liabilities.

The other contract tests still run separately: `cargo test --lib` (unit,
every transition) and `cargo test --test sandbox`.


### Part B — read-only mainnet

| Check | PASS means | Today on `escrow.pinkydeals.near` |
|---|---|---|
| contract account exists | `view_account` answers | PASS |
| code hash vs local build | sha256 of a **fresh** local build (base58) = the account's `code_hash`: the chain runs exactly this repository's code | PASS with `--build reproducible` from a checkout of `912cb4b` (step 6). From another commit the script says so and prints the commands instead of comparing |
| full-access keys | 0 full-access keys: nobody can redeploy the code or use the account | **FAIL, 1 key** (the deploy key) until it is deleted |
| token | `token_id` = NEAR-native USDC `17208628…6133a1` | PASS |
| config | real periods on the final contract | PASS |
| transactions | every tx in `verify/mainnet-txs.json` exists (archival RPC), succeeded, called this contract with the listed method / deal / action | PASS 5/5 |
| signatures | each `create_deal` carries a valid creator offer signature, each `act` a valid creator or client key signature over `escrow-v1|{contract}|{deal}|{action}|{payload}`, each `settle` both | PASS 4/4 |
| outcomes | `get_deal(id).outcome` = the table | PASS 1/1 |

For the deleted TEST instance (`--contract 9e537c21…`) only the history is
checked, from an archival node at the last block before the deletion:
transactions 30/30, signatures 28/28, outcomes 7/7.

# Live-test kit — one tiny real deal on mainnet

Guided commands for one real 5 USDC deal: the human pays in GRAM from TON
through 1Click into our escrow, then withdraws the USDC back to
your own NEAR account (`LIVE_BENEFICIARY`). Every command that sends a transaction prints the exact
actions first and waits for you to type `YES`. Nothing here ever needs the
human's wallet keys: the human only sends plain NEAR transfers and the GRAM
payment from their own wallets.

All commands run in WSL from `server/`:

```bash
cd server
npm run build                                   # compiles src + scripts to dist/
LIVE=node --disable-warning=ExperimentalWarning dist/scripts/live/live.js
```

(`$LIVE` below means `node --disable-warning=ExperimentalWarning dist/scripts/live/live.js`.)
Defaults: `LIVE_NETWORK=mainnet`, RPC `https://free.rpc.fastnear.com`,
`LIVE_HOME=$HOME/escrow-live` (keys, server env, deal state; chmod 600),
USDC `17208628…6133a1`, beneficiary `$LIVE_BENEFICIARY` (required), API `http://127.0.0.1:8787`.

## Order of commands

**0. Build the contract** (the preflight compares its hash):
`cd ../contract && CARGO_TARGET_DIR=$HOME/target/escrow cargo near build non-reproducible-wasm && cd ../server`

**1. Keys** — `$LIVE keys`
Creates 4 ed25519 keys for implicit accounts (escrow, relayer, owner,
arbiter) in `$HOME/escrow-live/keys`. Prints only the 64-hex account ids.
Safe to run again (reuses the keys). Back up `$HOME/escrow-live/keys` if
you care about the NEAR in those accounts.

**2. Preflight (read-only)** — `$LIVE preflight`
Checks balances, the USDC token, the wasm code hash, and prints a FUNDING TABLE.
Sends nothing.

**3. HUMAN: fund the accounts.** From `$LIVE_BENEFICIARY`, send plain NEAR
transfers to the ids in the SEND column (today: escrow **3.07 NEAR**,
relayer **0.37 NEAR**, owner/arbiter **0**). Sending NEAR to a 64-hex id
creates that implicit account (the wallet may charge ~0.007 NEAR extra per
new account). Re-run `$LIVE preflight` until SEND is 0 everywhere.

**4. Deploy** — `$LIVE deploy`
- TX 1, signed by the escrow account: ONE batch = DeployContract(wasm) +
  `new(owner, USDC, arbiter, relayer, min_review 5 min, dispute 15 min)`.
- TX 2: `storage_deposit` on the USDC contract for the escrow (0.00125 NEAR).
- `--lock` would also delete the escrow's full-access key (no upgrades and
  no NEAR recovery, ever). **Do not use `--lock` for this test.**

**5. Server** — `$LIVE serverenv`, then start the server in a second WSL
terminal and keep it running:
`ENV_FILE=$HOME/escrow-live/server.env node --disable-warning=ExperimentalWarning dist/src/main.js`
(`ONECLICK_FORCE_DRY=false` and mainnet; the 1Click API key comes from the
repository `.env`). Check `curl -s localhost:8787/api/health`.

**6. Deal** — `$LIVE deal --refund <client TON address>`
Resumable: progress lives in `$HOME/escrow-live/deal/state.json`; Ctrl-C and
re-run continues where it stopped. Steps:
1. creator offer (off-chain): amount 5 USDC, delivery 3 h, review 10 min, offer valid 60 min;
2. `YES` → client joins with its own key → `create_deal` (relayer pays);
3. pay quote: GRAM (`nep245:v2_1.omni.hot.tg:1117_`) → exactly 5 USDC into
   the escrow. The quote's 1Click signature, request fields and freshness are
   verified the way the web must do it;
4. **HUMAN: send exactly the printed GRAM amount to the printed deposit
   address (and memo, if one is printed) before the printed deadline.** The
   script polls 1Click status, the deal and `orphan_amount`, and prints the
   **Funding answer**:
   - `FUNDING ANSWER: YES`: the deal is Funded (normal case);
   - `ARRIVED AS AN ORPHAN`: fund the owner with ~0.05 NEAR, run
     `$LIVE assign-orphan <deal_id> <amount>`, then re-run `deal`;
   - `PLAIN ft_transfer`: fund the owner, `$LIVE sweep <amount>` sends it back
     to $LIVE_BENEFICIARY (the deal stays unfunded);
   - 1Click `REFUNDED/FAILED`: GRAM goes back to the TON address; re-run with `--requote`.
5. `YES` → creator delivers; 6. `YES` → client accepts;
7. payout quote: 5 USDC (NEAR) → `$LIVE_BENEFICIARY`, `DESTINATION_CHAIN`,
   refund to the creator key's own INTENTS account; verified like the web;
8. `YES` → withdraw (escrow → 1Click deposit address);
9. polls until the deal is PaidOut and `$LIVE_BENEFICIARY` received USDC.
Every tx is printed as a `https://nearblocks.io/txns/<hash>` link.
Option `--direct-payout` skips 1Click for the payout and withdraws straight
to `$LIVE_BENEFICIARY` (use it if the USDC→USDC NEAR payout quote is refused).

**7. Recover** — stop the server (Ctrl-C), then `$LIVE recover`.
Refuses while the escrow owes anything (`total_liabilities > 0`) or holds
USDC. Then: `storage_unregister` on USDC (gets the 0.00125 NEAR back) and
DeleteAccount for escrow and relayer (and owner/arbiter if they exist), all
NEAR → `$LIVE_BENEFICIARY`. A locked escrow cannot be recovered.

## Funding formula (computed live by `preflight` from the RPC protocol config)

```
price    = runtime_config.storage_amount_per_byte          (1e19 yocto/byte = 0.00001 NEAR)
gp       = gas_price                                        (1e8 yocto/gas today)
purchase = runtime_config.min_gas_purchase_price            (1e9 yocto/gas: prepaid gas is BOUGHT at this price)
res(g)   = g * max(gp, purchase) * inflation^steps          (inflation = 1/1 on protocol 86)

escrow  = 1.2 * ( price * (182 + wasm_bytes + 600 + 2 * 1000)        # account + code + state + 2 deals
                 + usdc_min (0.00125)                                  # own USDC registration
                 + 2 * usdc_min                                        # payout destination registrations
                 + gp * (deploy_gas + 30 TGas)                         # deploy + storage_deposit gas
                 + res(deploy_gas) )                                   # must be available to send the deploy
        = 3.07 NEAR for the current 245,226-byte wasm (2.48 NEAR of it is code storage)

relayer = 1.2 * ( price * 182 + res(30+30+30+150+30+30 TGas) )       # every tx at purchase price, no refund
        = 0.37 NEAR
```
`deploy_gas` = receipt + deploy base + deploy per-byte * wasm + function call
base + 30 TGas (~59 TGas). Measured on the sandbox: state after init 358 B,
one full deal +611 B; the whole deal cost the relayer 0.0016 NEAR and the
escrow 0.0010 NEAR. Everything not spent comes back with `recover`.
The relayer budget is high because prepaid gas is bought at 10x the gas price,
and refunds arrive only after the transaction, so back-to-back calls need the
full prepaid amount available each time.

## Dry run (no network)

`bash scripts/live/prove-sandbox.sh` runs the whole kit on a local sandbox.
It uses a mock USDC token and a local mock 1Click, which signs quotes,
delivers via `ft_transfer_call`, and forwards payouts. It runs
`keys → preflight → fund → deploy → serverenv → server → deal → recover`
and ends with `LIVE KIT SANDBOX PROOF PASSED`.
`LIVE_AUTO_YES=1` and `LIVE_QUOTE_PUBLIC_KEY` only work with `LIVE_NETWORK=sandbox`.

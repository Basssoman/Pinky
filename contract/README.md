# contract — Pinky escrow v2 (near-sdk 5.29)

Escrow for one NEP-141 token (NEAR-native USDC in production). Parties are
one-time ed25519 deal keys. The creator signs an offer; the client joins with
its own key (`create_deal(offer, offer_signature, client_pk)`, relayer only).
Every later party action is `act(deal_id, action, payload, signature)` with a
signature over `escrow-v1|{contract_id}|{deal_id}|{action}|{payload}`.
The doc comments in `src/lib.rs` are the reference.

```
src/lib.rs        contract
src/tests.rs      unit tests: every allowed / rejected transition + the
                  security-review PoCs inverted (poc_*_fixed)
tests/sandbox.rs  integration tests on near-sandbox with the mock token
mock-ft/          minimal NEP-141 token for tests only (anyone can mint;
                  set_fail_transfers(true) makes ft_transfer fail)
```

## Build & test (WSL)

```bash
cd contract
export CARGO_TARGET_DIR=$HOME/target/escrow   # keep it on a Linux filesystem
cargo test --lib                         # unit tests
cargo test --test sandbox                # sandbox integration tests (builds both wasm files)
cargo near build non-reproducible-wasm   # -> $CARGO_TARGET_DIR/near/escrow.wasm + escrow_abi.json
```

## Methods (contract v2)

`new` takes the five accounts and optional `periods` (all `U64` nanoseconds as
strings; any field left out uses the default). Use short periods only for a
test instance.

```
new(owner_id, token_id, arbiter_id, relayer_id, fee_account_id, periods?)
periods = { min_review_period_ns?   default 3 days
            dispute_period_ns?      default 7 days
            pay_by_period_ns?       default 7 days (client pays within this after the join)
            funding_grace_ns?       default 6 h   (late payments after pay_by still fund)
            max_offer_ttl_ns?       default 7 days
            purge_after_ns?         default 30 days
            admin_delay_ns?         default 7 days, must be >= dispute_period_ns
            sweep_confirm_delay_ns? default 1 h,   must be < 1 day }
```

Checks: owner ≠ relayer and owner ≠ arbiter; all periods > 0;
`min_review_period_ns` ≤ 90 days.

| Method | Caller |
|---|---|
| `new(...)` (above) | the escrow account itself (`#[private]`, deploy + init in one tx) |
| `create_deal(offer, offer_signature, client_pk) -> u64` | relayer only, attaches `DEAL_DEPOSIT` (0.01 NEAR, deal storage); creator-signed offer, single use |
| `revoke_offer(offer, signature)` | anyone with the creator's signature, attaches 0.001 NEAR; the offer can never start a deal afterwards |
| `ft_on_transfer(sender_id, amount, msg) -> U128` | the token (`msg` = `{"deal_id":N}`); bad msg / unknown deal → orphan funds, other tokens returned |
| `act(deal_id, action, payload, signature) -> bool` | **anyone** (permissionless), deal-key signature checked. Actions: `cancel`, `deliver`, `refund`, `accept`, `dispute`, `withdraw` (attach 0.00225 NEAR, ≥ 100 TGas; returns a promise → bool), `revoke_settle` |
| `settle(deal_id, payload, creator_signature, client_signature)` | anyone; agreed split signed by both deal keys, only while the current timer runs |
| `release_after_timeout(deal_id)` | anyone, after the review period (Delivered → Released) |
| `close_unpaid(deal_id)` | anyone, after `pay_by + grace` (Created → Expired) |
| `purge(deal_id)` | anyone, a never-funded closed deal after `purge_after_ns`; a tombstone keeps the keys and the client's leftover money |
| `resolve_dispute(deal_id, creator_share_bps)` | arbiter, only while the dispute period runs |
| `resolve_dispute_timeout(deal_id)` | anyone, after the dispute period (50/50) |
| `withdraw_fees(amount)` | fee account, 1 yoctoNEAR, ≥ 150 TGas |
| `set_relayer` (at once), `set_arbiter` / `set_fee_account` (after `admin_delay_ns`), `cancel_admin_changes` | owner |
| `apply_admin_changes` | anyone, once the delay is over |
| `assign_orphan`, `sweep_orphans`, `sweep_unaccounted` (two steps, `sweep_confirm_delay_ns` apart), `reconcile_pending`, `reconcile_fee_pending` | owner |
| `get_deal`, `get_deals(from, limit)`, `get_tombstone`, `is_purged`, `is_offer_used`, `is_offer_revoked`, `get_deal_id_by_offer`, `is_withdraw_used`, `get_config` | view |
| `on_withdraw`, `on_fee_withdraw`, `on_sweep_balance`, `on_sweep_done` | private callbacks |

Signed messages: `escrow-v1|{contract_id}|{deal_id}|{action}|{payload}`,
offers `escrow-v1|{contract_id}|offer|{offer}`, revocations
`escrow-v1|{contract_id}|revoke_offer|{offer}`. The fee (≤ 3%, carried in each
offer as `fee_bps`) is taken from the creator's share only.

No upgrade method. Deployment: register the escrow with the token
(`storage_deposit`), fund it with NEAR for storage, and on mainnet delete its
full-access keys after init. Run a security review before any
mainnet deploy.

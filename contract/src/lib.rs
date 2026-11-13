//! Private escrow for freelance creators — contract version 2.
//!
//! Parties are identified only by one-time ed25519 public keys (one pair per
//! party per deal). The creator never sees the client key: the creator signs
//! an OFFER (`escrow-v1|{contract_id}|offer|{offer_payload}`), the client's
//! browser generates its own key and the relayer creates the deal from the
//! signed offer plus that client key (`create_deal`). Every later party
//! action is an `act(...)` call carrying a signature over
//! `escrow-v1|{contract_id}|{deal_id}|{action}|{payload}`, so the relayer can
//! submit it but can never forge, redirect or replay it on another deal.
//! A mutual split ("Agree on a split") is `settle(...)` with BOTH signatures.
//!
//! Funds: the configured NEP-141 token (NEAR-native USDC in production)
//! arrives through `ft_on_transfer` with msg `{"deal_id":N}`. The contract
//! never returns tokens of that token from `ft_on_transfer`.
//!
//! Version 2:
//! - full payment only: ONE arrival >= amount funds the deal before the
//!   funding cutoff (`pay_by + grace`); anything else (an underpayment, the
//!   excess of the funding payment, money after the cutoff or after funding)
//!   goes straight to `client_payout`. Invariant: `funded_amount` is 0 or
//!   `amount`.
//! - the delivery deadline starts at funding (`funded_at + duration`).
//! - `client_payout` can be withdrawn in any state; `PaidOut` is set only
//!   for resolved deals (never for a live deal).
//! - the submitter of a withdraw attaches the storage it costs (no NEAR
//!   drain of the escrow by dust withdraws).
//! - a per-deal fee (`fee_bps` <= 3%) is taken from the creator's share only.
//! - arbiter / fee-account changes take effect after a delay.
//! - never-funded closed deals can be purged; a small tombstone keeps the
//!   client's leftover and late money withdrawable by the client key.
//! - the relayer attaches `DEAL_DEPOSIT` to `create_deal`, so the escrow's
//!   own NEAR never pays for deal storage; deals below
//!   `MIN_AMOUNT` (1 USDC) are refused.
//! - `revoke_settle` signs the current `settle_seq` (one use per signature).
//! - the arbiter decides only while the dispute period runs; the admin delay
//!   is at least the dispute period.
//! - sweeping untracked tokens needs two balance reads >= 1 h apart with no
//!   ledger change in between; recorded orphans are swept without a read.
//!
//! Payout accounting (per deal):
//! - `creator_payout` / `client_payout`: amount the party can withdraw NOW.
//! - `creator_pending` / `client_pending`: amount in an in-flight withdrawal.
//! - `creator_withdrawn` / `client_withdrawn`: amount already paid out.
//!
//! Contract-wide: `total_liabilities` = everything owed (credited minus paid
//! out, fees included until they are withdrawn). `ft_balance_of(self) -
//! total_liabilities` is unaccounted (orphans, plain transfers) and is the
//! only thing the owner can sweep.
//!
//! There is intentionally no upgrade method.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde::Deserialize;
use near_sdk::serde_json::{self, Value};
use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
    PromiseError, PromiseOrValue,
};

#[cfg(test)]
mod tests;

/// Prefix of every signed message.
pub const MESSAGE_PREFIX: &str = "escrow-v1";
/// Event standard version (bumped for the v2 schema).
pub const EVENT_VERSION: &str = "3.0.0";
/// Basis points denominator for splits and fees.
pub const MAX_BPS: u16 = 10_000;
/// Hard cap of the per-deal fee: 3%.
pub const MAX_FEE_BPS: u16 = 300;
/// Split applied when a dispute times out without an arbiter decision.
pub const DEFAULT_SPLIT_BPS: u16 = 5_000;
/// Max length for the terms hash.
pub const MAX_HASH_LEN: usize = 128;
/// Max length for the deliverable hash (room for a version prefix).
pub const MAX_DELIVERABLE_LEN: usize = 192;
/// Offer nonce length bounds.
pub const MIN_NONCE_LEN: usize = 16;
pub const MAX_NONCE_LEN: usize = 64;
/// Max length of a signed payload / offer (bounds gas spent parsing it).
pub const MAX_PAYLOAD_LEN: usize = 1024;
/// Max deal amount, so `amount * MAX_BPS * MAX_BPS` can never overflow.
pub const MAX_AMOUNT: u128 = u128::MAX / (MAX_BPS as u128 * MAX_BPS as u128);
/// Min deal amount: 1 USDC (6 decimals). Makes spam deals cost real money
/// (team decision, 2026-11-06).
pub const MIN_AMOUNT: u128 = 1_000_000;
/// Max number of deals returned by `get_deals`.
pub const MAX_PAGE: u64 = 100;
const SEC: u64 = 1_000_000_000;
const DAY: u64 = 24 * 3600 * SEC;
/// Hard on-chain limits of an offer.
pub const MAX_DELIVERY_DURATION_NS: u64 = 90 * DAY;
pub const MAX_REVIEW_PERIOD_NS: u64 = 90 * DAY;
/// Defaults of the init parameters (production values).
pub const DEFAULT_MIN_REVIEW_NS: u64 = 3 * DAY;
pub const DEFAULT_DISPUTE_NS: u64 = 7 * DAY;
pub const DEFAULT_PAY_BY_NS: u64 = 7 * DAY;
pub const DEFAULT_FUNDING_GRACE_NS: u64 = 6 * 3600 * SEC;
pub const DEFAULT_MAX_OFFER_TTL_NS: u64 = 7 * DAY;
pub const DEFAULT_PURGE_AFTER_NS: u64 = 30 * DAY;
pub const DEFAULT_ADMIN_DELAY_NS: u64 = 7 * DAY;
/// Owner may reconcile a stuck pending withdrawal only after this delay.
pub const RECONCILE_DELAY_NS: u64 = DAY;
/// `used_offers` value of a revoked offer.
pub const REVOKED: u64 = u64::MAX;

/// NEP-145 registration deposit for the payout destination (USDC on NEAR
/// needs 0.00125 NEAR). Refunded by the token if already registered.
pub const STORAGE_DEPOSIT: NearToken = NearToken::from_yoctonear(1_250_000_000_000_000_000_000);
/// What the submitter of a withdraw must attach: the destination's storage
/// deposit plus the replay-hash storage (~100 B) the escrow keeps forever.
pub const WITHDRAW_DEPOSIT: NearToken = NearToken::from_yoctonear(2_250_000_000_000_000_000_000);
/// What `revoke_offer` must attach (the stored offer hash).
pub const REVOKE_DEPOSIT: NearToken = NearToken::from_yoctonear(1_000_000_000_000_000_000_000);
/// What the relayer must attach to `create_deal`: the worst-case storage of
/// one deal over its life (~800 B: record, used offer, funding, a 192-byte
/// deliverable hash, dispute, outcome) at 10^19 yocto per byte, with margin.
pub const DEAL_DEPOSIT: NearToken = NearToken::from_yoctonear(10_000_000_000_000_000_000_000);
/// Accounts a withdraw may never pay to with a plain `ft_transfer` (the
/// tokens would sit there unattributed).
pub const DENIED_DESTINATIONS: [&str; 1] = ["intents.near"];
/// Default (production) delay between the two balance reads of a sweep of
/// untracked tokens; nothing may change in between. An init
/// parameter so a sandbox / test instance can use seconds.
pub const SWEEP_CONFIRM_DELAY_NS: u64 = 3600 * SEC;
/// The first read of a sweep is valid this long.
pub const SWEEP_SNAPSHOT_TTL_NS: u64 = DAY;
pub const GAS_STORAGE_DEPOSIT: Gas = Gas::from_tgas(10);
pub const GAS_FT_TRANSFER: Gas = Gas::from_tgas(20);
pub const GAS_ON_WITHDRAW: Gas = Gas::from_tgas(20);
pub const GAS_FT_BALANCE_OF: Gas = Gas::from_tgas(10);
pub const GAS_ON_SWEEP_BALANCE: Gas = Gas::from_tgas(60);
pub const GAS_ON_SWEEP_DONE: Gas = Gas::from_tgas(15);
/// Minimum prepaid gas for `act(withdraw)` so the callback can always run.
pub const MIN_GAS_WITHDRAW: Gas = Gas::from_tgas(100);
/// Minimum prepaid gas for `sweep_unaccounted` and `withdraw_fees`.
pub const MIN_GAS_SWEEP: Gas = Gas::from_tgas(150);

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Deals,
    UsedWithdrawals,
    UsedOffers,
    Tombstones,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum DealState {
    Created,
    Funded,
    Delivered,
    Released,
    PaidOut,
    Disputed,
    Refunded,
    Cancelled,
    /// Closed unpaid after the funding cutoff (`close_unpaid`).
    Expired,
}

impl DealState {
    fn name(self) -> &'static str {
        match self {
            Self::Created => "Created",
            Self::Funded => "Funded",
            Self::Delivered => "Delivered",
            Self::Released => "Released",
            Self::PaidOut => "PaidOut",
            Self::Disputed => "Disputed",
            Self::Refunded => "Refunded",
            Self::Cancelled => "Cancelled",
            Self::Expired => "Expired",
        }
    }
    /// Final states: nothing can change the split any more.
    fn is_resolved(self) -> bool {
        matches!(self, Self::Released | Self::Refunded | Self::Cancelled | Self::Expired | Self::PaidOut)
    }
}

/// How a deal ended (for review labels, the dispute log and the 3-day
/// review window).
#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Outcome {
    Accepted,
    AutoReleased,
    RefundedByCreator,
    RefundedAfterDeadline,
    ArbiterSplit { creator_share_bps: u16 },
    TimeoutSplit { creator_share_bps: u16 },
    Settled { creator_share_bps: u16 },
    Cancelled,
    ClosedUnpaid,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Party {
    Creator,
    Client,
}

/// Action names accepted by `act`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Action {
    Cancel,
    Deliver,
    Refund,
    Accept,
    Dispute,
    Withdraw,
    RevokeSettle,
}

impl Action {
    fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "cancel" => Self::Cancel,
            "deliver" => Self::Deliver,
            "refund" => Self::Refund,
            "accept" => Self::Accept,
            "dispute" => Self::Dispute,
            "withdraw" => Self::Withdraw,
            "revoke_settle" => Self::RevokeSettle,
            _ => return None,
        })
    }
}

/// Creator-signed offer. Signed bytes: `escrow-v1|{contract_id}|offer|{offer}`
/// where `{offer}` is the exact compact JSON string passed to `create_deal`.
/// All numbers are canonical decimal strings ("300", never "+300"/"0300").
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
pub struct Offer {
    pub creator_pk: String,
    pub amount: String,
    pub fee_bps: String,
    pub delivery_duration_ns: String,
    pub review_period_ns: String,
    pub terms_hash: String,
    pub offer_nonce: String,
    /// Joins (create_deal) are rejected after this time.
    pub offer_expires_at_ns: String,
}

/// Init parameters (all optional; production defaults above).
#[near(serializers = [json])]
#[derive(Clone, Debug, Default)]
pub struct Periods {
    pub min_review_period_ns: Option<U64>,
    pub dispute_period_ns: Option<U64>,
    pub pay_by_period_ns: Option<U64>,
    pub funding_grace_ns: Option<U64>,
    pub max_offer_ttl_ns: Option<U64>,
    pub purge_after_ns: Option<U64>,
    pub admin_delay_ns: Option<U64>,
    pub sweep_confirm_delay_ns: Option<U64>,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Deal {
    pub amount: u128,
    /// 0 or `amount` (full payment only).
    pub funded_amount: u128,
    pub state: DealState,
    pub creator_pk: [u8; 32],
    pub client_pk: [u8; 32],
    pub fee_bps: u16,
    /// Fee taken from the creator's share when the deal resolved.
    pub fee_amount: u128,
    pub delivery_duration_ns: u64,
    /// Set at funding: `funded_at + delivery_duration`.
    pub delivery_deadline_ns: Option<u64>,
    pub review_period_ns: u64,
    pub pay_by_ns: u64,
    pub funded_at_ns: Option<u64>,
    pub delivered_at_ns: Option<u64>,
    pub deliverable_hash: Option<String>,
    pub terms_hash: String,
    pub creator_payout: u128,
    pub client_payout: u128,
    pub creator_pending: u128,
    pub client_pending: u128,
    pub creator_pending_since_ns: u64,
    pub client_pending_since_ns: u64,
    /// Id of the in-flight withdraw per side (0 = none); callbacks must match.
    pub creator_pending_id: u64,
    pub client_pending_id: u64,
    pub creator_withdrawn: u128,
    pub client_withdrawn: u128,
    pub disputed_at_ns: Option<u64>,
    pub dispute_ends_at_ns: Option<u64>,
    pub created_at_ns: u64,
    pub ended_at_ns: Option<u64>,
    pub outcome: Option<Outcome>,
    /// Bumped by `revoke_settle`; a settle must carry the current value.
    pub settle_seq: u32,
}

/// What stays of a purged deal: the keys, how it ended and the client's
/// money, so leftovers and late money stay withdrawable by the client key
/// without bringing the whole deal back.
#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Tombstone {
    pub creator_pk: [u8; 32],
    pub client_pk: [u8; 32],
    pub state: DealState,
    pub outcome: Option<Outcome>,
    pub ended_at_ns: u64,
    pub client_payout: u128,
    pub client_pending: u128,
    pub client_pending_since_ns: u64,
    pub client_pending_id: u64,
    pub client_withdrawn: u128,
}

impl Tombstone {
    fn side(&mut self) -> Side<'_> {
        Side {
            payout: &mut self.client_payout,
            pending: &mut self.client_pending,
            pending_since: &mut self.client_pending_since_ns,
            pending_id: &mut self.client_pending_id,
            withdrawn: &mut self.client_withdrawn,
        }
    }
}

/// First balance read of a two-step sweep.
#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct SweepSnapshot {
    pub balance: u128,
    pub ledger_seq: u64,
    pub at_ns: u64,
}

struct Side<'a> {
    payout: &'a mut u128,
    pending: &'a mut u128,
    pending_since: &'a mut u64,
    pending_id: &'a mut u64,
    withdrawn: &'a mut u128,
}

impl Deal {
    fn side(&mut self, party: Party) -> Side<'_> {
        match party {
            Party::Creator => Side {
                payout: &mut self.creator_payout,
                pending: &mut self.creator_pending,
                pending_since: &mut self.creator_pending_since_ns,
                pending_id: &mut self.creator_pending_id,
                withdrawn: &mut self.creator_withdrawn,
            },
            Party::Client => Side {
                payout: &mut self.client_payout,
                pending: &mut self.client_pending,
                pending_since: &mut self.client_pending_since_ns,
                pending_id: &mut self.client_pending_id,
                withdrawn: &mut self.client_withdrawn,
            },
        }
    }

    fn pk(&self, party: Party) -> &[u8; 32] {
        match party {
            Party::Creator => &self.creator_pk,
            Party::Client => &self.client_pk,
        }
    }

    fn review_ends_at_ns(&self) -> Option<u64> {
        self.delivered_at_ns.map(|d| d.saturating_add(self.review_period_ns))
    }

    fn settled(&self) -> bool {
        self.creator_payout == 0
            && self.client_payout == 0
            && self.creator_pending == 0
            && self.client_pending == 0
    }

    /// Only a resolved deal with nothing left becomes PaidOut.
    fn mark_paid_out_if_done(&mut self) {
        if self.state.is_resolved() && self.settled() {
            self.state = DealState::PaidOut;
        }
    }

    fn finish(&mut self, state: DealState, outcome: Outcome, now: u64) {
        self.state = state;
        self.outcome = Some(outcome);
        self.ended_at_ns = Some(now);
    }

    /// Splits the funded amount: `bps` of it to the creator minus the fee,
    /// the rest to the client. Returns the fee. 0 bps -> Refunded.
    fn split(&mut self, bps: u16, outcome: Outcome, now: u64) -> u128 {
        let creator_share = self.funded_amount * bps as u128 / MAX_BPS as u128;
        let fee = creator_share * self.fee_bps as u128 / MAX_BPS as u128;
        self.creator_payout += creator_share - fee;
        self.client_payout += self.funded_amount - creator_share;
        self.fee_amount = fee;
        let state = if bps == 0 { DealState::Refunded } else { DealState::Released };
        self.finish(state, outcome, now);
        fee
    }

    /// Everything that funded the deal goes back to the client, no fee.
    fn refund_all(&mut self, state: DealState, outcome: Outcome, now: u64) {
        self.client_payout += self.funded_amount;
        self.finish(state, outcome, now);
    }

    /// Records tokens that arrived for this deal.
    fn credit(&mut self, amount: u128, now: u64, funding_cutoff_ns: u64) {
        if self.state == DealState::Created && now <= funding_cutoff_ns && amount >= self.amount {
            self.funded_amount = self.amount;
            self.client_payout += amount - self.amount;
            self.state = DealState::Funded;
            self.funded_at_ns = Some(now);
            self.delivery_deadline_ns = Some(now.saturating_add(self.delivery_duration_ns));
        } else {
            // Underpayment, money after the cutoff, or after funding: the
            // client can withdraw it at once.
            self.client_payout += amount;
        }
    }
}

/// JSON view of a deal (`DealView`).
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct DealView {
    pub id: u64,
    pub amount: U128,
    pub funded_amount: U128,
    pub state: DealState,
    pub creator_pk: String,
    pub client_pk: String,
    pub fee_bps: u16,
    pub fee_amount: U128,
    pub delivery_duration_ns: U64,
    /// `null` until the deal is funded.
    pub delivery_deadline_ns: Option<U64>,
    pub review_period_ns: U64,
    pub pay_by_ns: U64,
    /// After this a payment no longer funds the deal (`pay_by + grace`).
    pub funding_cutoff_ns: U64,
    pub funded_at_ns: Option<U64>,
    pub delivered_at_ns: Option<U64>,
    pub deliverable_hash: Option<String>,
    pub terms_hash: String,
    /// Withdrawable by the creator key right now.
    pub creator_payout: U128,
    /// Withdrawable by the client key right now.
    pub client_payout: U128,
    pub created_at_ns: U64,
    pub review_ends_at_ns: Option<U64>,
    pub disputed_at_ns: Option<U64>,
    /// After this anyone may trigger the default 50/50 split.
    pub dispute_ends_at_ns: Option<U64>,
    pub ended_at_ns: Option<U64>,
    pub outcome: Option<Outcome>,
    pub settle_seq: u32,
    pub creator_pending: U128,
    pub client_pending: U128,
    pub creator_withdrawn: U128,
    pub client_withdrawn: U128,
    /// true when nothing is withdrawable or in flight right now. NOT "the
    /// deal is over": a fresh Created deal is also `settled`. To decide on a
    /// withdraw, use the payouts, not `state` (a PaidOut deal can get late
    /// money into `client_payout`).
    pub settled: bool,
    /// Short fingerprints of the deal keys for out-of-band comparison:
    /// first 12 hex chars of sha256(raw 32-byte key), as "xxxx-xxxx-xxxx".
    pub creator_fingerprint: String,
    pub client_fingerprint: String,
}

/// JSON view of a purged deal (`get_tombstone`).
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct TombstoneView {
    pub id: u64,
    /// The state the deal had when it was purged (Cancelled / Expired / PaidOut).
    pub state: DealState,
    pub outcome: Option<Outcome>,
    pub ended_at_ns: U64,
    pub creator_pk: String,
    pub client_pk: String,
    /// Withdrawable by the client key right now.
    pub client_payout: U128,
    pub client_pending: U128,
    pub client_withdrawn: U128,
    pub creator_fingerprint: String,
    pub client_fingerprint: String,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct PendingChange {
    pub account_id: AccountId,
    pub effective_at_ns: U64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct ConfigView {
    pub owner_id: AccountId,
    pub token_id: AccountId,
    pub arbiter_id: AccountId,
    pub relayer_id: AccountId,
    pub fee_account_id: AccountId,
    pub pending_arbiter: Option<PendingChange>,
    pub pending_fee_account: Option<PendingChange>,
    pub min_review_period_ns: U64,
    pub dispute_period_ns: U64,
    pub pay_by_period_ns: U64,
    pub funding_grace_ns: U64,
    pub max_offer_ttl_ns: U64,
    pub purge_after_ns: U64,
    pub admin_delay_ns: U64,
    pub sweep_confirm_delay_ns: U64,
    pub max_fee_bps: u16,
    pub deals_count: u64,
    pub orphan_amount: U128,
    pub total_liabilities: U128,
    pub sweep_reserved: U128,
    pub fee_accrued: U128,
    pub fee_pending: U128,
    /// Smallest deal amount `create_deal` accepts.
    pub min_amount: U128,
    /// yoctoNEAR the relayer attaches to `create_deal`.
    pub deal_deposit: U128,
    /// Bumped by every change of liabilities, orphans, sweeps or pending
    /// transfers (a two-step sweep needs it unchanged).
    pub ledger_seq: U64,
    /// Time of the first read of a pending two-step sweep, if any.
    pub sweep_snapshot_at_ns: Option<U64>,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
struct Pending {
    account_id: AccountId,
    effective_at_ns: u64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner_id: AccountId,
    token_id: AccountId,
    arbiter_id: AccountId,
    relayer_id: AccountId,
    fee_account_id: AccountId,
    pending_arbiter: Option<Pending>,
    pending_fee_account: Option<Pending>,
    min_review_period_ns: u64,
    dispute_period_ns: u64,
    pay_by_period_ns: u64,
    funding_grace_ns: u64,
    max_offer_ttl_ns: u64,
    purge_after_ns: u64,
    admin_delay_ns: u64,
    sweep_confirm_delay_ns: u64,
    deals: LookupMap<u64, Deal>,
    next_deal_id: u64,
    tombstones: LookupMap<u64, Tombstone>,
    /// sha256(signer_pk || message) of withdraw signatures already used.
    used_withdrawals: LookupSet<Vec<u8>>,
    /// sha256(offer) -> deal id (or `REVOKED`), for used / revoked offers.
    used_offers: LookupMap<Vec<u8>, u64>,
    /// Counter for withdraw ids (callbacks must match the pending id).
    next_withdraw_id: u64,
    /// Tokens that arrived via `ft_on_transfer` without a valid deal id.
    orphan_amount: u128,
    /// What the escrow owes (deals + accrued fees), credited minus paid out.
    total_liabilities: u128,
    /// Amount reserved by in-flight sweeps.
    sweep_reserved: u128,
    /// Fees taken from creator shares and not yet withdrawn.
    fee_accrued: u128,
    fee_pending: u128,
    fee_pending_since_ns: u64,
    fee_pending_id: u64,
    /// See `ConfigView::ledger_seq`.
    ledger_seq: u64,
    sweep_snapshot: Option<SweepSnapshot>,
}

pub fn pk_to_string(pk: &[u8; 32]) -> String {
    format!("ed25519:{}", near_sdk::bs58::encode(pk).into_string())
}

pub fn parse_pk(s: &str) -> [u8; 32] {
    let b58 = s
        .strip_prefix("ed25519:")
        .unwrap_or_else(|| env::panic_str("public key must start with ed25519:"));
    let bytes = near_sdk::bs58::decode(b58)
        .into_vec()
        .unwrap_or_else(|_| env::panic_str("public key: invalid base58"));
    let pk: [u8; 32] = bytes.try_into().unwrap_or_else(|_| env::panic_str("public key: expected 32 bytes"));
    require!(!is_weak_key(&pk), "public key: weak (small-order or non-canonical) ed25519 point");
    pk
}

/// Small-order ed25519 encodings (sign bit masked), as in libsodium's
/// `has_small_order`. For these a trivial signature verifies.
const SMALL_ORDER: [[u8; 32]; 4] = [
    [0; 32],
    [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [
        0x26, 0xe8, 0x95, 0x8f, 0xc2, 0xb2, 0x27, 0xb0, 0x45, 0xc3, 0xf4, 0x89, 0xf2, 0xef, 0x98, 0xf0, 0xd5, 0xdf,
        0xac, 0x05, 0xd3, 0xc6, 0x33, 0x39, 0xb1, 0x38, 0x02, 0x88, 0x6d, 0x53, 0xfc, 0x05,
    ],
    [
        0xc7, 0x17, 0x6a, 0x70, 0x3d, 0x4d, 0xd8, 0x4f, 0xba, 0x3c, 0x0b, 0x76, 0x0d, 0x10, 0x67, 0x0f, 0x2a, 0x20,
        0x53, 0xfa, 0x2c, 0x39, 0xcc, 0xc6, 0x4e, 0xc7, 0xfd, 0x77, 0x92, 0xac, 0x03, 0x7a,
    ],
];

/// true for small-order points and for non-canonical encodings (y >= p,
/// which covers p-1 (order 2), p and p+1 as well).
pub fn is_weak_key(pk: &[u8; 32]) -> bool {
    let mut m = *pk;
    m[31] &= 0x7f;
    if SMALL_ORDER.iter().any(|s| *s == m) {
        return true;
    }
    // y = p - 1 = 2^255 - 20 and above: low byte >= 0xec, then all 0xff, top 0x7f.
    m[0] >= 0xec && m[1..31].iter().all(|b| *b == 0xff) && m[31] == 0x7f
}

pub fn signed_message(contract_id: &str, deal_id: u64, action: &str, payload: &str) -> String {
    format!("{MESSAGE_PREFIX}|{contract_id}|{deal_id}|{action}|{payload}")
}

pub fn offer_message(contract_id: &str, offer: &str) -> String {
    format!("{MESSAGE_PREFIX}|{contract_id}|offer|{offer}")
}

pub fn revoke_offer_message(contract_id: &str, offer: &str) -> String {
    format!("{MESSAGE_PREFIX}|{contract_id}|revoke_offer|{offer}")
}

/// Anti-replay key for a withdraw: sha256(signer_pk || signed message).
pub fn withdrawal_hash(pk: &[u8; 32], message: &str) -> Vec<u8> {
    let mut bytes = pk.to_vec();
    bytes.extend_from_slice(message.as_bytes());
    env::sha256(&bytes)
}

fn event(name: &str, data: Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        serde_json::json!({
            "standard": "private-escrow",
            "version": EVENT_VERSION,
            "event": name,
            "data": [data],
        })
    ));
}

/// Extracts `deal_id` from `{"deal_id": N}` (number or decimal string).
fn parse_deal_msg(msg: &str) -> Option<u64> {
    let v: Value = serde_json::from_str(msg).ok()?;
    match v.get("deal_id")? {
        Value::Number(n) => n.as_u64(),
        Value::String(s) => s.parse().ok(),
        _ => None,
    }
}

fn str_field<'a>(payload: &'a Value, key: &str, what: &str) -> &'a str {
    payload
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_else(|| env::panic_str(&format!("{what}: payload.{key} (string) required")))
}

/// Canonical decimal string: digits only, no sign, no leading zero.
fn is_canonical_decimal(s: &str) -> bool {
    !s.is_empty() && s.len() <= 39 && s.bytes().all(|b| b.is_ascii_digit()) && (s == "0" || !s.starts_with('0'))
}

pub fn parse_u128_strict(s: &str, what: &str) -> u128 {
    require!(is_canonical_decimal(s), format!("{what}: must be a canonical decimal string"));
    s.parse().unwrap_or_else(|_| env::panic_str(&format!("{what}: out of range")))
}

pub fn parse_u64_strict(s: &str, what: &str) -> u64 {
    require!(is_canonical_decimal(s), format!("{what}: must be a canonical decimal string"));
    s.parse().unwrap_or_else(|_| env::panic_str(&format!("{what}: out of range")))
}

#[near]
impl Contract {
    /// Must be called by the escrow account itself (deploy + init in one
    /// batch transaction). `owner_id` must differ from relayer and arbiter.
    /// Use short `periods` only for a test instance.
    #[init]
    #[private]
    pub fn new(
        owner_id: AccountId,
        token_id: AccountId,
        arbiter_id: AccountId,
        relayer_id: AccountId,
        fee_account_id: AccountId,
        periods: Option<Periods>,
    ) -> Self {
        require!(owner_id != relayer_id && owner_id != arbiter_id, "owner must differ from relayer and arbiter");
        let p = periods.unwrap_or_default();
        let get = |v: Option<U64>, d: u64| v.map(|x| x.0).unwrap_or(d);
        let dispute = get(p.dispute_period_ns, DEFAULT_DISPUTE_NS);
        let min_review = get(p.min_review_period_ns, DEFAULT_MIN_REVIEW_NS);
        let pay_by = get(p.pay_by_period_ns, DEFAULT_PAY_BY_NS);
        require!(dispute > 0 && min_review > 0 && pay_by > 0, "periods must be > 0");
        require!(min_review <= MAX_REVIEW_PERIOD_NS, "min_review_period_ns above the maximum");
        let admin_delay = get(p.admin_delay_ns, DEFAULT_ADMIN_DELAY_NS);
        // A new arbiter must never reach a dispute opened before the change.
        require!(admin_delay >= dispute, "admin_delay_ns must be >= dispute_period_ns");
        let sweep_delay = get(p.sweep_confirm_delay_ns, SWEEP_CONFIRM_DELAY_NS);
        require!(sweep_delay > 0 && sweep_delay < SWEEP_SNAPSHOT_TTL_NS, "sweep_confirm_delay_ns must be > 0 and < 1 day");
        Self {
            owner_id,
            token_id,
            arbiter_id,
            relayer_id,
            fee_account_id,
            pending_arbiter: None,
            pending_fee_account: None,
            min_review_period_ns: min_review,
            dispute_period_ns: dispute,
            pay_by_period_ns: pay_by,
            funding_grace_ns: get(p.funding_grace_ns, DEFAULT_FUNDING_GRACE_NS),
            max_offer_ttl_ns: get(p.max_offer_ttl_ns, DEFAULT_MAX_OFFER_TTL_NS),
            purge_after_ns: get(p.purge_after_ns, DEFAULT_PURGE_AFTER_NS),
            admin_delay_ns: admin_delay,
            sweep_confirm_delay_ns: sweep_delay,
            deals: LookupMap::new(StorageKey::Deals),
            next_deal_id: 0,
            tombstones: LookupMap::new(StorageKey::Tombstones),
            used_withdrawals: LookupSet::new(StorageKey::UsedWithdrawals),
            used_offers: LookupMap::new(StorageKey::UsedOffers),
            next_withdraw_id: 0,
            orphan_amount: 0,
            total_liabilities: 0,
            sweep_reserved: 0,
            fee_accrued: 0,
            fee_pending: 0,
            fee_pending_since_ns: 0,
            fee_pending_id: 0,
            ledger_seq: 0,
            sweep_snapshot: None,
        }
    }

    // ------------------------------------------------------------------
    // Relayer
    // ------------------------------------------------------------------

    /// Creates a deal from a creator-signed offer and the client's own key.
    /// Only the relayer, which attaches `DEAL_DEPOSIT` for the deal's
    /// storage. Each offer can be used once; a revoked offer never.
    #[payable]
    pub fn create_deal(&mut self, offer: String, offer_signature: String, client_pk: String) -> u64 {
        require!(env::predecessor_account_id() == self.relayer_id, "only relayer");
        require!(env::attached_deposit() >= DEAL_DEPOSIT, "create_deal: attach 0.01 NEAR for the deal storage");
        require!(offer.len() <= MAX_PAYLOAD_LEN, "offer too long");
        let o: Offer = serde_json::from_str(&offer).unwrap_or_else(|_| env::panic_str("offer: invalid JSON or fields"));
        let creator = parse_pk(&o.creator_pk);
        let client = parse_pk(&client_pk);
        require!(creator != client, "creator_pk and client_pk must differ");

        let sig = decode_signature(&offer_signature);
        let message = offer_message(env::current_account_id().as_str(), &offer);
        require!(env::ed25519_verify(&sig, message.as_bytes(), &creator), "offer: invalid creator signature");

        let offer_hash = env::sha256(offer.as_bytes());
        require!(!self.used_offers.contains_key(&offer_hash), "offer already used or revoked");

        let amount = parse_u128_strict(&o.amount, "amount");
        let fee_bps = parse_u64_strict(&o.fee_bps, "fee_bps");
        let duration = parse_u64_strict(&o.delivery_duration_ns, "delivery_duration_ns");
        let review = parse_u64_strict(&o.review_period_ns, "review_period_ns");
        let expires = parse_u64_strict(&o.offer_expires_at_ns, "offer_expires_at_ns");
        require!(amount >= MIN_AMOUNT, "amount below the minimum (1 USDC)");
        require!(amount <= MAX_AMOUNT, "amount too large");
        require!(fee_bps <= MAX_FEE_BPS as u64, "fee_bps above the maximum (300)");
        require!(duration > 0 && duration <= MAX_DELIVERY_DURATION_NS, "delivery_duration_ns must be 1 ns .. 90 days");
        require!(
            review >= self.min_review_period_ns && review <= MAX_REVIEW_PERIOD_NS,
            "review_period_ns outside the allowed range"
        );
        require!(!o.terms_hash.is_empty() && o.terms_hash.len() <= MAX_HASH_LEN, "bad terms_hash");
        require!(
            (MIN_NONCE_LEN..=MAX_NONCE_LEN).contains(&o.offer_nonce.len()),
            "offer_nonce must be 16..64 chars"
        );
        let now = env::block_timestamp();
        require!(now <= expires, "offer expired");
        require!(expires <= now.saturating_add(self.max_offer_ttl_ns), "offer_expires_at_ns too far in the future");

        let id = self.next_deal_id;
        self.next_deal_id += 1;
        self.used_offers.insert(offer_hash, id);
        self.deals.insert(
            id,
            Deal {
                amount,
                funded_amount: 0,
                state: DealState::Created,
                creator_pk: creator,
                client_pk: client,
                fee_bps: fee_bps as u16,
                fee_amount: 0,
                delivery_duration_ns: duration,
                delivery_deadline_ns: None,
                review_period_ns: review,
                pay_by_ns: now.saturating_add(self.pay_by_period_ns),
                funded_at_ns: None,
                delivered_at_ns: None,
                deliverable_hash: None,
                terms_hash: o.terms_hash,
                creator_payout: 0,
                client_payout: 0,
                creator_pending: 0,
                client_pending: 0,
                creator_pending_since_ns: 0,
                client_pending_since_ns: 0,
                creator_pending_id: 0,
                client_pending_id: 0,
                creator_withdrawn: 0,
                client_withdrawn: 0,
                disputed_at_ns: None,
                dispute_ends_at_ns: None,
                created_at_ns: now,
                ended_at_ns: None,
                outcome: None,
                settle_seq: 0,
            },
        );
        event("deal_created", serde_json::json!({ "deal_id": id, "amount": U128(amount), "fee_bps": fee_bps }));
        id
    }

    /// Creator-signed revocation of an offer that was not joined yet:
    /// the offer can never start a deal afterwards.
    /// Anyone may submit it; attach `REVOKE_DEPOSIT` for the storage.
    #[payable]
    pub fn revoke_offer(&mut self, offer: String, signature: String) {
        require!(env::attached_deposit() >= REVOKE_DEPOSIT, "revoke_offer: attach 0.001 NEAR for storage");
        require!(offer.len() <= MAX_PAYLOAD_LEN, "offer too long");
        let o: Offer = serde_json::from_str(&offer).unwrap_or_else(|_| env::panic_str("offer: invalid JSON or fields"));
        let creator = parse_pk(&o.creator_pk);
        let sig = decode_signature(&signature);
        let message = revoke_offer_message(env::current_account_id().as_str(), &offer);
        require!(env::ed25519_verify(&sig, message.as_bytes(), &creator), "revoke_offer: invalid creator signature");
        let offer_hash = env::sha256(offer.as_bytes());
        require!(!self.used_offers.contains_key(&offer_hash), "offer already used or revoked");
        self.used_offers.insert(offer_hash, REVOKED);
        event("offer_revoked", serde_json::json!({}));
    }

    // ------------------------------------------------------------------
    // Owner
    // ------------------------------------------------------------------

    /// Owner only. Replaces the relayer at once: the only account allowed to
    /// call `create_deal`. It cannot move funds by itself.
    pub fn set_relayer(&mut self, relayer_id: AccountId) {
        self.assert_owner();
        require!(relayer_id != self.owner_id, "owner must differ from relayer");
        self.relayer_id = relayer_id;
    }

    /// Owner only. Schedules a new arbiter; it takes effect after
    /// `admin_delay_ns` (>= the dispute period) via `apply_admin_changes`
    ///. Disputes open now end before that, and the arbiter can
    /// only decide while a dispute runs, so a stolen owner key cannot decide
    /// disputes that are already open.
    pub fn set_arbiter(&mut self, arbiter_id: AccountId) {
        self.assert_owner();
        require!(arbiter_id != self.owner_id, "owner must differ from arbiter");
        let at = env::block_timestamp().saturating_add(self.admin_delay_ns);
        event("arbiter_change_scheduled", serde_json::json!({ "arbiter_id": arbiter_id, "effective_at_ns": U64(at) }));
        self.pending_arbiter = Some(Pending { account_id: arbiter_id, effective_at_ns: at });
    }

    /// Owner only. Schedules a new fee account (same delay as the arbiter).
    pub fn set_fee_account(&mut self, fee_account_id: AccountId) {
        self.assert_owner();
        let at = env::block_timestamp().saturating_add(self.admin_delay_ns);
        event(
            "fee_account_change_scheduled",
            serde_json::json!({ "fee_account_id": fee_account_id, "effective_at_ns": U64(at) }),
        );
        self.pending_fee_account = Some(Pending { account_id: fee_account_id, effective_at_ns: at });
    }

    /// Owner only. Cancels scheduled arbiter / fee-account changes.
    pub fn cancel_admin_changes(&mut self) {
        self.assert_owner();
        self.pending_arbiter = None;
        self.pending_fee_account = None;
        event("admin_changes_cancelled", serde_json::json!({}));
    }

    /// Anyone. Applies scheduled changes whose delay is over.
    pub fn apply_admin_changes(&mut self) {
        let now = env::block_timestamp();
        if let Some(p) = self.pending_arbiter.clone() {
            if now > p.effective_at_ns {
                self.arbiter_id = p.account_id.clone();
                self.pending_arbiter = None;
                event("arbiter_changed", serde_json::json!({ "arbiter_id": p.account_id }));
            }
        }
        if let Some(p) = self.pending_fee_account.clone() {
            if now > p.effective_at_ns && self.fee_pending == 0 {
                self.fee_account_id = p.account_id.clone();
                self.pending_fee_account = None;
                event("fee_account_changed", serde_json::json!({ "fee_account_id": p.account_id }));
            }
        }
    }

    /// Credits `amount` of recorded orphan funds to a deal (e.g. a payment
    /// that arrived without the deal id). Treated like a normal arrival.
    pub fn assign_orphan(&mut self, deal_id: u64, amount: U128) {
        self.assert_owner();
        require!(self.sweep_reserved == 0, "a sweep is in flight; retry after it finishes");
        require!(amount.0 > 0 && amount.0 <= self.orphan_amount, "amount exceeds orphan_amount");
        let state = self.credit_deal(deal_id, amount.0).unwrap_or_else(|| env::panic_str("deal not found"));
        self.orphan_amount -= amount.0;
        event("orphan_assigned", serde_json::json!({ "deal_id": deal_id, "amount": amount, "state": state }));
    }

    /// Owner only, 1 yoctoNEAR. Sends recorded orphan funds (arrivals via
    /// `ft_on_transfer` without a valid deal id) to `receiver_id`. No
    /// balance read: orphans are tracked and always backed.
    #[payable]
    pub fn sweep_orphans(&mut self, receiver_id: AccountId, amount: U128) -> Promise {
        self.assert_owner();
        near_sdk::assert_one_yocto();
        require!(env::prepaid_gas() >= MIN_GAS_SWEEP, "sweep: attach at least 150 TGas");
        require!(amount.0 > 0 && amount.0 <= self.orphan_amount, "amount exceeds orphan_amount");
        self.orphan_amount -= amount.0;
        self.sweep_reserved += amount.0;
        self.ledger_seq += 1;
        self.sweep_transfer(receiver_id, amount, amount)
    }

    /// Owner only, 1 yoctoNEAR. Sends untracked tokens (plain transfers
    /// without `ft_on_transfer`: balance minus liabilities, orphans and
    /// in-flight sweeps) to `receiver_id`. Two steps: the first
    /// call only records the balance; a second call at least
    /// `sweep_confirm_delay_ns` (default 1 h) later (and within `SWEEP_SNAPSHOT_TTL_NS`)
    /// sweeps, only if the balance is exactly the same and nothing in the
    /// ledger changed in between. So a payment that is still on its way,
    /// or a withdraw that finished between the read and the callback, can
    /// never be taken for surplus. Returns `true` only when tokens are sent.
    #[payable]
    pub fn sweep_unaccounted(&mut self, receiver_id: AccountId, amount: U128) -> Promise {
        self.assert_owner();
        near_sdk::assert_one_yocto();
        require!(amount.0 > 0, "amount must be > 0");
        require!(env::prepaid_gas() >= MIN_GAS_SWEEP, "sweep: attach at least 150 TGas");
        Promise::new(self.token_id.clone())
            .function_call(
                "ft_balance_of".to_string(),
                serde_json::json!({ "account_id": env::current_account_id() }).to_string().into_bytes(),
                NearToken::from_yoctonear(0),
                GAS_FT_BALANCE_OF,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_SWEEP_BALANCE)
                    .on_sweep_balance(receiver_id, amount, U64(self.ledger_seq)),
            )
    }

    /// Owner fixes a withdrawal whose callback never ran (e.g. out of gas),
    /// at least 24 hours after it started. `transferred` = whether the
    /// `ft_transfer` receipt executed successfully; `receipt_id` = that
    /// receipt's id (logged, so anyone can audit the owner's claim).
    pub fn reconcile_pending(&mut self, deal_id: u64, party: Party, transferred: bool, receipt_id: String) {
        self.assert_owner();
        require!(!receipt_id.is_empty() && receipt_id.len() <= 64, "receipt_id (the ft_transfer receipt) is required");
        let now = env::block_timestamp();
        let amount = if let Some(deal) = self.deals.get_mut(&deal_id) {
            let amount = reconcile_side(deal.side(party), transferred, now);
            deal.mark_paid_out_if_done();
            amount
        } else {
            require!(party == Party::Client, "deal not found");
            let t = self.tombstones.get_mut(&deal_id).unwrap_or_else(|| env::panic_str("deal not found"));
            reconcile_side(t.side(), transferred, now)
        };
        if transferred {
            self.total_liabilities = self.total_liabilities.saturating_sub(amount);
        }
        self.ledger_seq += 1;
        event(
            "pending_reconciled",
            serde_json::json!({
                "deal_id": deal_id, "party": party, "amount": U128(amount), "transferred": transferred,
                "receipt_id": receipt_id,
            }),
        );
    }

    /// Owner fixes a fee withdrawal whose callback never ran (same rules).
    pub fn reconcile_fee_pending(&mut self, transferred: bool, receipt_id: String) {
        self.assert_owner();
        require!(!receipt_id.is_empty() && receipt_id.len() <= 64, "receipt_id (the ft_transfer receipt) is required");
        require!(self.fee_pending > 0, "nothing pending");
        require!(
            env::block_timestamp() > self.fee_pending_since_ns.saturating_add(RECONCILE_DELAY_NS),
            "too early to reconcile"
        );
        let amount = self.fee_pending;
        self.fee_pending = 0;
        self.fee_pending_id = 0;
        self.ledger_seq += 1;
        if transferred {
            self.total_liabilities = self.total_liabilities.saturating_sub(amount);
        } else {
            self.fee_accrued += amount;
        }
        event(
            "fee_pending_reconciled",
            serde_json::json!({ "amount": U128(amount), "transferred": transferred, "receipt_id": receipt_id }),
        );
    }

    // ------------------------------------------------------------------
    // Fees
    // ------------------------------------------------------------------

    /// Fee account only. Pays out accrued fees to the fee account itself
    /// (it must be registered with the token). Attach 1 yoctoNEAR.
    #[payable]
    pub fn withdraw_fees(&mut self, amount: U128) -> Promise {
        near_sdk::assert_one_yocto();
        require!(env::predecessor_account_id() == self.fee_account_id, "only fee account");
        require!(env::prepaid_gas() >= MIN_GAS_SWEEP, "withdraw_fees: attach at least 150 TGas");
        require!(self.fee_pending == 0, "a fee withdrawal is in progress");
        require!(amount.0 > 0 && amount.0 <= self.fee_accrued, "amount exceeds accrued fees");
        self.fee_accrued -= amount.0;
        self.fee_pending = amount.0;
        self.fee_pending_since_ns = env::block_timestamp();
        self.next_withdraw_id += 1;
        let id = self.next_withdraw_id;
        self.fee_pending_id = id;
        self.ledger_seq += 1;
        let receiver = self.fee_account_id.clone();
        event("fee_withdraw_started", serde_json::json!({ "amount": amount, "receiver_id": receiver }));
        Promise::new(self.token_id.clone())
            .function_call(
                "ft_transfer".to_string(),
                serde_json::json!({ "receiver_id": receiver, "amount": amount, "memo": "escrow fees" })
                    .to_string()
                    .into_bytes(),
                NearToken::from_yoctonear(1),
                GAS_FT_TRANSFER,
            )
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_ON_WITHDRAW).on_fee_withdraw(amount, id))
    }

    // ------------------------------------------------------------------
    // Funding (NEP-141 receiver)
    // ------------------------------------------------------------------

    /// Never panics on bad input and never returns tokens of the configured
    /// token. Unknown deal / bad msg -> recorded as orphan funds.
    /// Tokens from any other contract are returned in full (not ours).
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        if env::predecessor_account_id() != self.token_id {
            env::log_str("ft_on_transfer: unsupported token, returning all");
            return PromiseOrValue::Value(amount);
        }
        let credited = parse_deal_msg(&msg).and_then(|id| self.credit_deal(id, amount.0).map(|s| (id, s)));
        if credited.is_none() {
            self.orphan_amount = self.orphan_amount.saturating_add(amount.0);
            self.ledger_seq += 1;
            event("orphan_funds", serde_json::json!({ "sender_id": sender_id, "amount": amount, "msg_len": msg.len() }));
        }
        PromiseOrValue::Value(U128(0))
    }

    // ------------------------------------------------------------------
    // Signed party actions
    // ------------------------------------------------------------------

    /// Generic signed action. `payload` is a compact JSON object that was
    /// signed exactly as sent. Returns `true` for state actions; `withdraw`
    /// returns a promise that resolves to `true` (paid) / `false` (failed).
    /// `withdraw` needs `WITHDRAW_DEPOSIT` attached; other actions none.
    #[payable]
    pub fn act(&mut self, deal_id: u64, action: String, payload: String, signature: String) -> PromiseOrValue<bool> {
        let act = Action::parse(&action).unwrap_or_else(|| env::panic_str("unknown action"));
        if act == Action::Withdraw {
            require!(env::attached_deposit() >= WITHDRAW_DEPOSIT, "withdraw: attach 0.00225 NEAR for storage");
        } else {
            require!(env::attached_deposit().is_zero(), "this action takes no deposit");
        }
        require!(payload.len() <= MAX_PAYLOAD_LEN, "payload too long");
        let payload_json: Value =
            serde_json::from_str(&payload).unwrap_or_else(|_| env::panic_str("payload is not JSON"));
        require!(payload_json.is_object(), "payload must be a JSON object");

        let sig = decode_signature(&signature);
        let message = signed_message(env::current_account_id().as_str(), deal_id, &action, &payload);
        let now = env::block_timestamp();

        let Some(mut deal) = self.deals.get(&deal_id).cloned() else {
            // A purged deal: only the client key can withdraw what is left.
            return PromiseOrValue::Promise(self.withdraw_from_tombstone(deal_id, act, &payload_json, &sig, &message));
        };
        let (creator_pk, client_pk) = (deal.creator_pk, deal.client_pk);
        let verifies = |party: Party| {
            let pk = match party {
                Party::Creator => &creator_pk,
                Party::Client => &client_pk,
            };
            env::ed25519_verify(&sig, message.as_bytes(), pk)
        };

        match act {
            Action::Cancel => {
                require!(verifies(Party::Creator), "invalid signature (creator key required)");
                require!(deal.state == DealState::Created, "cancel: deal must be Created");
                deal.refund_all(DealState::Cancelled, Outcome::Cancelled, now);
            }
            Action::Deliver => {
                require!(verifies(Party::Creator), "invalid signature (creator key required)");
                require!(deal.state == DealState::Funded, "deliver: deal must be Funded");
                require!(now <= deal.delivery_deadline_ns.unwrap_or(0), "deliver: delivery deadline has passed");
                let hash = str_field(&payload_json, "deliverable_hash", "deliver");
                require!(!hash.is_empty() && hash.len() <= MAX_DELIVERABLE_LEN, "bad deliverable_hash");
                deal.state = DealState::Delivered;
                deal.delivered_at_ns = Some(now);
                deal.deliverable_hash = Some(hash.to_string());
            }
            Action::Refund => {
                require!(deal.state == DealState::Funded, "refund: deal must be Funded");
                if verifies(Party::Client) {
                    require!(
                        now > deal.delivery_deadline_ns.unwrap_or(u64::MAX),
                        "refund: client may refund only after the delivery deadline"
                    );
                    deal.refund_all(DealState::Refunded, Outcome::RefundedAfterDeadline, now);
                } else if verifies(Party::Creator) {
                    deal.refund_all(DealState::Refunded, Outcome::RefundedByCreator, now);
                } else {
                    env::panic_str("invalid signature");
                }
            }
            Action::Accept => {
                require!(verifies(Party::Client), "invalid signature (client key required)");
                require!(deal.state == DealState::Delivered, "accept: deal must be Delivered");
                let fee = deal.split(MAX_BPS, Outcome::Accepted, now);
                self.fee_accrued += fee;
            }
            Action::Dispute => {
                require!(verifies(Party::Client), "invalid signature (client key required)");
                require!(deal.state == DealState::Delivered, "dispute: deal must be Delivered");
                let ends = deal.review_ends_at_ns().unwrap_or(0);
                require!(now <= ends, "dispute: review period is over");
                deal.state = DealState::Disputed;
                deal.disputed_at_ns = Some(now);
                deal.dispute_ends_at_ns = Some(now.saturating_add(self.dispute_period_ns));
            }
            Action::RevokeSettle => {
                require!(verifies(Party::Creator) || verifies(Party::Client), "invalid signature");
                require!(
                    matches!(deal.state, DealState::Funded | DealState::Delivered | DealState::Disputed),
                    "revoke_settle: deal is not live"
                );
                // The signature names the seq it revokes, so it works once and
                // nobody can replay it to block later settles.
                let seq = parse_u64_strict(str_field(&payload_json, "seq", "revoke_settle"), "revoke_settle: seq");
                require!(seq == deal.settle_seq as u64, "revoke_settle: seq is not the current settle_seq");
                deal.settle_seq = deal.settle_seq.saturating_add(1);
            }
            Action::Withdraw => {
                let party = if verifies(Party::Creator) {
                    Party::Creator
                } else if verifies(Party::Client) {
                    Party::Client
                } else {
                    env::panic_str("invalid signature")
                };
                let (destination, amount) = parse_withdraw(&payload_json, now);
                let pk = *deal.pk(party);
                let withdraw_id = self.begin_withdraw(deal.side(party), &pk, &message, &destination, amount);
                self.deals.insert(deal_id, deal);
                return PromiseOrValue::Promise(self.withdraw_transfer(deal_id, party, destination, amount, withdraw_id));
            }
        }
        let state = deal.state;
        self.deals.insert(deal_id, deal);
        event("deal_action", serde_json::json!({ "deal_id": deal_id, "action": action, "state": state }));
        PromiseOrValue::Value(true)
    }

    /// "Agree on a split": both parties sign the same payload
    /// `{"split_bps":"7000","state":"Delivered","seq":"0","expires_at_ns":"…","nonce":"…"}`
    /// (message `escrow-v1|{contract}|{deal_id}|settle|{payload}`). Allowed
    /// in Funded / Delivered / Disputed only while the current timer runs
    /// (delivery deadline / review end / dispute end), only
    /// in the signed state and with the current `settle_seq`. The fee is
    /// taken from the creator's share only. Anyone may submit.
    pub fn settle(&mut self, deal_id: u64, payload: String, creator_signature: String, client_signature: String) {
        require!(payload.len() <= MAX_PAYLOAD_LEN, "payload too long");
        let p: Value = serde_json::from_str(&payload).unwrap_or_else(|_| env::panic_str("payload is not JSON"));
        require!(p.is_object(), "payload must be a JSON object");
        let message = signed_message(env::current_account_id().as_str(), deal_id, "settle", &payload);
        let mut deal = self.deal_or_panic(deal_id);
        require!(
            env::ed25519_verify(&decode_signature(&creator_signature), message.as_bytes(), &deal.creator_pk),
            "settle: invalid creator signature"
        );
        require!(
            env::ed25519_verify(&decode_signature(&client_signature), message.as_bytes(), &deal.client_pk),
            "settle: invalid client signature"
        );
        let bps = parse_u64_strict(str_field(&p, "split_bps", "settle"), "settle: split_bps");
        require!(bps <= MAX_BPS as u64, "settle: split_bps must be <= 10000");
        let seq = parse_u64_strict(str_field(&p, "seq", "settle"), "settle: seq");
        let expires = parse_u64_strict(str_field(&p, "expires_at_ns", "settle"), "settle: expires_at_ns");
        let signed_state = str_field(&p, "state", "settle");
        let _ = str_field(&p, "nonce", "settle");
        let now = env::block_timestamp();
        require!(now <= expires, "settle: signature expired");
        require!(signed_state == deal.state.name(), "settle: deal state differs from the signed state");
        require!(seq == deal.settle_seq as u64, "settle: revoked (settle_seq changed)");
        let timer_end = match deal.state {
            DealState::Funded => deal.delivery_deadline_ns.unwrap_or(0),
            DealState::Delivered => deal.review_ends_at_ns().unwrap_or(0),
            DealState::Disputed => deal.dispute_ends_at_ns.unwrap_or(0),
            _ => env::panic_str("settle: deal must be Funded, Delivered or Disputed"),
        };
        require!(now <= timer_end, "settle: the deal timer is over; the timeout rules apply");
        let bps = bps as u16;
        let fee = deal.split(bps, Outcome::Settled { creator_share_bps: bps }, now);
        self.fee_accrued += fee;
        let state = deal.state;
        self.deals.insert(deal_id, deal);
        event("deal_settled", serde_json::json!({ "deal_id": deal_id, "creator_share_bps": bps, "state": state }));
    }

    /// Delivered -> Released after the review period. Anyone may call.
    pub fn release_after_timeout(&mut self, deal_id: u64) {
        let mut deal = self.deal_or_panic(deal_id);
        require!(deal.state == DealState::Delivered, "deal must be Delivered");
        let ends = deal.review_ends_at_ns().unwrap_or(u64::MAX);
        let now = env::block_timestamp();
        require!(now > ends, "review period is not over yet");
        let fee = deal.split(MAX_BPS, Outcome::AutoReleased, now);
        self.fee_accrued += fee;
        self.deals.insert(deal_id, deal);
        event(
            "deal_action",
            serde_json::json!({ "deal_id": deal_id, "action": "release_after_timeout", "state": DealState::Released }),
        );
    }

    /// Created -> Expired after the funding cutoff (`pay_by + grace`):
    /// the deal was never fully paid. Anyone may call. Money that arrived
    /// stays withdrawable by the client key.
    pub fn close_unpaid(&mut self, deal_id: u64) {
        let mut deal = self.deal_or_panic(deal_id);
        require!(deal.state == DealState::Created, "deal must be Created");
        let now = env::block_timestamp();
        require!(now > self.funding_cutoff(&deal), "the funding window is not over yet");
        deal.finish(DealState::Expired, Outcome::ClosedUnpaid, now);
        let state = deal.state;
        self.deals.insert(deal_id, deal);
        event("deal_action", serde_json::json!({ "deal_id": deal_id, "action": "close_unpaid", "state": state }));
    }

    /// Removes a never-funded, closed deal after `purge_after_ns` (storage
    /// back to the escrow). A small tombstone keeps the keys, how it ended
    /// and the client's leftover payout; late money is added there and the
    /// client key withdraws it (`act` withdraw). Not while a withdraw is in
    /// flight. Anyone may call.
    pub fn purge(&mut self, deal_id: u64) {
        let deal = self.deal_or_panic(deal_id);
        require!(deal.funded_amount == 0, "purge: only never-funded deals");
        require!(deal.state.is_resolved(), "purge: deal is not closed");
        require!(
            deal.creator_payout == 0 && deal.creator_pending == 0 && deal.client_pending == 0,
            "purge: a withdrawal is in flight"
        );
        let ended = deal.ended_at_ns.unwrap_or(u64::MAX);
        require!(env::block_timestamp() > ended.saturating_add(self.purge_after_ns), "purge: too early");
        self.deals.remove(&deal_id);
        self.tombstones.insert(
            deal_id,
            Tombstone {
                creator_pk: deal.creator_pk,
                client_pk: deal.client_pk,
                state: deal.state,
                outcome: deal.outcome,
                ended_at_ns: ended,
                client_payout: deal.client_payout,
                client_pending: 0,
                client_pending_since_ns: 0,
                client_pending_id: 0,
                client_withdrawn: deal.client_withdrawn,
            },
        );
        event("deal_purged", serde_json::json!({ "deal_id": deal_id, "client_payout": U128(deal.client_payout) }));
    }

    /// Arbiter decision on a disputed deal, only while the dispute period
    /// runs (after it, only the 50/50 timeout).
    pub fn resolve_dispute(&mut self, deal_id: u64, creator_share_bps: u16) {
        require!(env::predecessor_account_id() == self.arbiter_id, "only arbiter");
        require!(creator_share_bps <= MAX_BPS, "creator_share_bps must be <= 10000");
        let deal = self.deal_or_panic(deal_id);
        require!(deal.state == DealState::Disputed, "deal must be Disputed");
        let ends = deal.dispute_ends_at_ns.unwrap_or(0);
        require!(env::block_timestamp() <= ends, "the dispute period is over; only the timeout split applies");
        self.apply_split(deal_id, creator_share_bps, Outcome::ArbiterSplit { creator_share_bps }, "dispute_resolved");
    }

    /// Default outcome when the arbiter did not decide within the dispute
    /// period: 50/50 split of the deal amount. Anyone may call.
    pub fn resolve_dispute_timeout(&mut self, deal_id: u64) {
        let deal = self.deal_or_panic(deal_id);
        require!(deal.state == DealState::Disputed, "deal must be Disputed");
        let ends = deal.dispute_ends_at_ns.unwrap_or(u64::MAX);
        require!(env::block_timestamp() > ends, "dispute period is not over yet");
        self.apply_split(
            deal_id,
            DEFAULT_SPLIT_BPS,
            Outcome::TimeoutSplit { creator_share_bps: DEFAULT_SPLIT_BPS },
            "dispute_timed_out",
        );
    }

    // ------------------------------------------------------------------
    // Callbacks (private, never panic)
    // ------------------------------------------------------------------

    /// After `ft_transfer` of a withdraw. On failure the payout is restored;
    /// the signature stays burned (the party must sign a fresh withdraw).
    #[private]
    pub fn on_withdraw(
        &mut self,
        deal_id: u64,
        party: Party,
        amount: U128,
        destination: AccountId,
        withdraw_id: u64,
    ) -> bool {
        let success = env::promise_results_count() == 1 && near_sdk::is_promise_success();
        let (matched, state) = if let Some(deal) = self.deals.get_mut(&deal_id) {
            let matched = close_withdraw(deal.side(party), amount.0, withdraw_id, success);
            deal.mark_paid_out_if_done();
            (matched, deal.state)
        } else if let Some(t) = self.tombstones.get_mut(&deal_id) {
            let matched = party == Party::Client && close_withdraw(t.side(), amount.0, withdraw_id, success);
            (matched, t.state)
        } else {
            env::log_str("on_withdraw: unknown deal");
            return false;
        };
        if !matched {
            // Stale callback (the owner reconciled this withdraw). Logged so
            // a transfer that did happen after all can be noticed.
            event(
                "withdraw_stale_callback",
                serde_json::json!({
                    "deal_id": deal_id, "party": party, "amount": amount, "withdraw_id": withdraw_id,
                    "transfer_succeeded": success,
                }),
            );
            return success;
        }
        if success {
            self.total_liabilities = self.total_liabilities.saturating_sub(amount.0);
        }
        self.ledger_seq += 1;
        event(
            if success { "withdraw_done" } else { "withdraw_failed" },
            serde_json::json!({
                "deal_id": deal_id, "party": party, "amount": amount, "destination": destination, "state": state,
            }),
        );
        success
    }

    /// After `ft_transfer` of `withdraw_fees`.
    #[private]
    pub fn on_fee_withdraw(&mut self, amount: U128, withdraw_id: u64) -> bool {
        let success = env::promise_results_count() == 1 && near_sdk::is_promise_success();
        if self.fee_pending_id != withdraw_id || self.fee_pending != amount.0 {
            event("fee_withdraw_stale_callback", serde_json::json!({ "amount": amount, "transfer_succeeded": success }));
            return success;
        }
        self.fee_pending = 0;
        self.fee_pending_id = 0;
        self.ledger_seq += 1;
        if success {
            self.total_liabilities = self.total_liabilities.saturating_sub(amount.0);
        } else {
            self.fee_accrued += amount.0;
        }
        event(if success { "fee_withdraw_done" } else { "fee_withdraw_failed" }, serde_json::json!({ "amount": amount }));
        success
    }

    /// After `ft_balance_of(self)` of `sweep_unaccounted`. `ledger_seq` is
    /// the value when the read was started.
    #[private]
    pub fn on_sweep_balance(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        ledger_seq: U64,
        #[callback_result] balance: Result<U128, PromiseError>,
    ) -> PromiseOrValue<bool> {
        let Ok(balance) = balance else {
            env::log_str("sweep: ft_balance_of failed");
            return PromiseOrValue::Value(false);
        };
        let now = env::block_timestamp();
        if self.ledger_seq != ledger_seq.0 {
            self.sweep_snapshot = None;
            event("sweep_rejected", serde_json::json!({ "reason": "the ledger changed during the balance read" }));
            return PromiseOrValue::Value(false);
        }
        let unaccounted = balance
            .0
            .saturating_sub(self.total_liabilities)
            .saturating_sub(self.sweep_reserved)
            .saturating_sub(self.orphan_amount);
        let confirmed = matches!(
            &self.sweep_snapshot,
            Some(s) if s.ledger_seq == self.ledger_seq
                && s.balance == balance.0
                && now >= s.at_ns.saturating_add(self.sweep_confirm_delay_ns)
                && now <= s.at_ns.saturating_add(SWEEP_SNAPSHOT_TTL_NS)
        );
        if !confirmed {
            // First step (or the state moved): record this read only.
            self.sweep_snapshot = Some(SweepSnapshot { balance: balance.0, ledger_seq: self.ledger_seq, at_ns: now });
            event(
                "sweep_snapshot",
                serde_json::json!({
                    "balance": balance, "unaccounted": U128(unaccounted),
                    "confirm_after_ns": U64(now.saturating_add(self.sweep_confirm_delay_ns)),
                }),
            );
            return PromiseOrValue::Value(false);
        }
        self.sweep_snapshot = None;
        if amount.0 > unaccounted {
            event("sweep_rejected", serde_json::json!({ "amount": amount, "available": U128(unaccounted) }));
            return PromiseOrValue::Value(false);
        }
        self.sweep_reserved += amount.0;
        self.ledger_seq += 1;
        PromiseOrValue::Promise(self.sweep_transfer(receiver_id, amount, U128(0)))
    }

    /// Internal callback after a sweep transfer (only the contract itself
    /// can call it). Releases the reservation; if the transfer failed, the
    /// orphan amount is put back. Returns whether the transfer succeeded.
    #[private]
    pub fn on_sweep_done(&mut self, receiver_id: AccountId, amount: U128, orphan_taken: U128) -> bool {
        let success = env::promise_results_count() == 1 && near_sdk::is_promise_success();
        self.sweep_reserved = self.sweep_reserved.saturating_sub(amount.0);
        self.ledger_seq += 1;
        if !success {
            self.orphan_amount = self.orphan_amount.saturating_add(orphan_taken.0);
        }
        event(
            if success { "sweep_done" } else { "sweep_failed" },
            serde_json::json!({ "receiver_id": receiver_id, "amount": amount }),
        );
        success
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    /// One deal by id: state, amounts, deadlines, the two one-time public
    /// keys and hashes. No wallets or names are stored. `null` if not found
    /// or purged.
    pub fn get_deal(&self, deal_id: u64) -> Option<DealView> {
        self.deals.get(&deal_id).map(|d| self.view(deal_id, d))
    }

    /// A page of deals starting at id `from`, at most `limit` ids scanned
    /// (capped at `MAX_PAGE`); purged ids are skipped.
    pub fn get_deals(&self, from: u64, limit: u64) -> Vec<DealView> {
        let end = from.saturating_add(limit.min(MAX_PAGE)).min(self.next_deal_id);
        (from..end).filter_map(|i| self.deals.get(&i).map(|d| self.view(i, d))).collect()
    }

    /// Whether the deal id was purged (only a tombstone is left).
    pub fn is_purged(&self, deal_id: u64) -> bool {
        self.tombstones.contains_key(&deal_id) && !self.deals.contains_key(&deal_id)
    }

    /// What is left of a purged deal (keys, how it ended, the client's
    /// money). `null` if the id was never purged.
    pub fn get_tombstone(&self, deal_id: u64) -> Option<TombstoneView> {
        self.tombstones.get(&deal_id).map(|t| TombstoneView {
            id: deal_id,
            state: t.state,
            outcome: t.outcome,
            ended_at_ns: U64(t.ended_at_ns),
            creator_pk: pk_to_string(&t.creator_pk),
            client_pk: pk_to_string(&t.client_pk),
            client_payout: U128(t.client_payout),
            client_pending: U128(t.client_pending),
            client_withdrawn: U128(t.client_withdrawn),
            creator_fingerprint: fingerprint(&t.creator_pk),
            client_fingerprint: fingerprint(&t.client_pk),
        })
    }

    /// Whether this exact signed offer was already used or revoked.
    pub fn is_offer_used(&self, offer: String) -> bool {
        self.used_offers.contains_key(&env::sha256(offer.as_bytes()))
    }

    /// Whether this exact offer was revoked by its creator.
    pub fn is_offer_revoked(&self, offer: String) -> bool {
        self.used_offers.get(&env::sha256(offer.as_bytes())) == Some(&REVOKED)
    }

    /// Deal created from this exact offer string, if any (join recovery and
    /// the browser's chain check).
    pub fn get_deal_id_by_offer(&self, offer: String) -> Option<u64> {
        self.used_offers.get(&env::sha256(offer.as_bytes())).copied().filter(|id| *id != REVOKED)
    }

    /// Whether this withdraw signature (by `signer_pk` over this deal id and
    /// payload) was already used. Lets relayers skip doomed replays.
    pub fn is_withdraw_used(&self, deal_id: u64, payload: String, signer_pk: String) -> bool {
        let pk = parse_pk(&signer_pk);
        let message = signed_message(env::current_account_id().as_str(), deal_id, "withdraw", &payload);
        self.used_withdrawals.contains(&withdrawal_hash(&pk, &message))
    }

    /// Contract settings and totals.
    pub fn get_config(&self) -> ConfigView {
        let pc = |p: &Option<Pending>| {
            p.as_ref().map(|p| PendingChange { account_id: p.account_id.clone(), effective_at_ns: U64(p.effective_at_ns) })
        };
        ConfigView {
            owner_id: self.owner_id.clone(),
            token_id: self.token_id.clone(),
            arbiter_id: self.arbiter_id.clone(),
            relayer_id: self.relayer_id.clone(),
            fee_account_id: self.fee_account_id.clone(),
            pending_arbiter: pc(&self.pending_arbiter),
            pending_fee_account: pc(&self.pending_fee_account),
            min_review_period_ns: U64(self.min_review_period_ns),
            dispute_period_ns: U64(self.dispute_period_ns),
            pay_by_period_ns: U64(self.pay_by_period_ns),
            funding_grace_ns: U64(self.funding_grace_ns),
            max_offer_ttl_ns: U64(self.max_offer_ttl_ns),
            purge_after_ns: U64(self.purge_after_ns),
            admin_delay_ns: U64(self.admin_delay_ns),
            sweep_confirm_delay_ns: U64(self.sweep_confirm_delay_ns),
            max_fee_bps: MAX_FEE_BPS,
            deals_count: self.next_deal_id,
            orphan_amount: U128(self.orphan_amount),
            total_liabilities: U128(self.total_liabilities),
            sweep_reserved: U128(self.sweep_reserved),
            fee_accrued: U128(self.fee_accrued),
            fee_pending: U128(self.fee_pending),
            min_amount: U128(MIN_AMOUNT),
            deal_deposit: U128(DEAL_DEPOSIT.as_yoctonear()),
            ledger_seq: U64(self.ledger_seq),
            sweep_snapshot_at_ns: self.sweep_snapshot.as_ref().map(|s| U64(s.at_ns)),
        }
    }
}

// ----------------------------------------------------------------------
// Internal helpers
// ----------------------------------------------------------------------

impl Contract {
    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner_id, "only owner");
    }

    fn deal_or_panic(&self, deal_id: u64) -> Deal {
        self.deals.get(&deal_id).cloned().unwrap_or_else(|| env::panic_str("deal not found"))
    }

    fn funding_cutoff(&self, deal: &Deal) -> u64 {
        deal.pay_by_ns.saturating_add(self.funding_grace_ns)
    }

    /// Credits an arrival to a live deal, or to the client payout kept in a
    /// purged deal's tombstone (no storage growth). None = unknown id.
    fn credit_deal(&mut self, deal_id: u64, amount: u128) -> Option<DealState> {
        let now = env::block_timestamp();
        let grace = self.funding_grace_ns;
        let (state, funded, purged) = if let Some(deal) = self.deals.get_mut(&deal_id) {
            deal.credit(amount, now, deal.pay_by_ns.saturating_add(grace));
            (deal.state, deal.funded_amount, false)
        } else if let Some(t) = self.tombstones.get_mut(&deal_id) {
            t.client_payout += amount;
            (t.state, 0, true)
        } else {
            return None;
        };
        self.total_liabilities = self.total_liabilities.saturating_add(amount);
        self.ledger_seq += 1;
        event(
            "deal_funding",
            serde_json::json!({
                "deal_id": deal_id, "amount": U128(amount), "funded_amount": U128(funded), "state": state,
                "purged": purged,
            }),
        );
        Some(state)
    }

    fn apply_split(&mut self, deal_id: u64, bps: u16, outcome: Outcome, event_name: &str) {
        let mut deal = self.deal_or_panic(deal_id);
        require!(deal.state == DealState::Disputed, "deal must be Disputed");
        let fee = deal.split(bps, outcome, env::block_timestamp());
        self.fee_accrued += fee;
        let state = deal.state;
        self.deals.insert(deal_id, deal);
        event(event_name, serde_json::json!({ "deal_id": deal_id, "creator_share_bps": bps, "state": state }));
    }

    /// Withdraw from a purged deal's tombstone (client key only).
    fn withdraw_from_tombstone(
        &mut self,
        deal_id: u64,
        act: Action,
        payload: &Value,
        sig: &[u8; 64],
        message: &str,
    ) -> Promise {
        let mut t = self.tombstones.get(&deal_id).cloned().unwrap_or_else(|| env::panic_str("deal not found"));
        require!(act == Action::Withdraw, "the deal was purged: only the client's withdraw is possible");
        let pk = t.client_pk;
        require!(env::ed25519_verify(sig, message.as_bytes(), &pk), "invalid signature (client key required)");
        let (destination, amount) = parse_withdraw(payload, env::block_timestamp());
        let withdraw_id = self.begin_withdraw(t.side(), &pk, message, &destination, amount);
        self.tombstones.insert(deal_id, t);
        self.withdraw_transfer(deal_id, Party::Client, destination, amount, withdraw_id)
    }

    /// Checks a withdraw and moves exactly `amount` of the side's payout to
    /// pending (effects before interactions). Returns the withdraw id.
    fn begin_withdraw(
        &mut self,
        side: Side<'_>,
        pk: &[u8; 32],
        message: &str,
        destination: &AccountId,
        amount: u128,
    ) -> u64 {
        // No state check: payouts only exist where the party is owed money
        // (creator after resolution; client also mid-deal).
        require!(
            *destination != env::current_account_id()
                && *destination != self.token_id
                && !DENIED_DESTINATIONS.contains(&destination.as_str()),
            "withdraw: bad destination"
        );
        require!(env::prepaid_gas() >= MIN_GAS_WITHDRAW, "withdraw: attach at least 100 TGas");
        let message_hash = withdrawal_hash(pk, message);
        require!(!self.used_withdrawals.contains(&message_hash), "withdraw: signature already used");
        require!(*side.pending == 0, "withdraw: another withdrawal is in progress");
        require!(*side.payout > 0, "withdraw: nothing to withdraw for this key");
        require!(amount > 0 && amount <= *side.payout, "withdraw: amount exceeds the withdrawable payout");
        *side.payout -= amount;
        *side.pending = amount;
        *side.pending_since = env::block_timestamp();
        self.next_withdraw_id += 1;
        let withdraw_id = self.next_withdraw_id;
        *side.pending_id = withdraw_id;
        // Burned for good, also if the transfer fails (sign a fresh one).
        self.used_withdrawals.insert(message_hash);
        self.ledger_seq += 1;
        withdraw_id
    }

    fn withdraw_transfer(
        &self,
        deal_id: u64,
        party: Party,
        destination: AccountId,
        amount: u128,
        withdraw_id: u64,
    ) -> Promise {
        event(
            "withdraw_started",
            serde_json::json!({
                "deal_id": deal_id, "party": party, "amount": U128(amount), "destination": destination,
            }),
        );

        let storage_args = serde_json::json!({ "account_id": destination, "registration_only": true });
        let transfer_args = serde_json::json!({
            "receiver_id": destination,
            "amount": U128(amount),
            "memo": format!("escrow deal {deal_id}"),
        });
        // `then` runs ft_transfer even if storage_deposit failed. The
        // storage deposit comes from what the submitter attached.
        Promise::new(self.token_id.clone())
            .function_call(
                "storage_deposit".to_string(),
                storage_args.to_string().into_bytes(),
                STORAGE_DEPOSIT,
                GAS_STORAGE_DEPOSIT,
            )
            .then(Promise::new(self.token_id.clone()).function_call(
                "ft_transfer".to_string(),
                transfer_args.to_string().into_bytes(),
                NearToken::from_yoctonear(1),
                GAS_FT_TRANSFER,
            ))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_WITHDRAW)
                    .on_withdraw(deal_id, party, U128(amount), destination, withdraw_id),
            )
    }

    /// `ft_transfer` of a sweep (the amount is already reserved).
    fn sweep_transfer(&self, receiver_id: AccountId, amount: U128, orphan_taken: U128) -> Promise {
        Promise::new(self.token_id.clone())
            .function_call(
                "ft_transfer".to_string(),
                serde_json::json!({ "receiver_id": receiver_id, "amount": amount, "memo": "escrow sweep" })
                    .to_string()
                    .into_bytes(),
                NearToken::from_yoctonear(1),
                GAS_FT_TRANSFER,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_SWEEP_DONE)
                    .on_sweep_done(receiver_id, amount, orphan_taken),
            )
    }

    fn view(&self, id: u64, d: &Deal) -> DealView {
        DealView {
            id,
            amount: U128(d.amount),
            funded_amount: U128(d.funded_amount),
            state: d.state,
            creator_pk: pk_to_string(&d.creator_pk),
            client_pk: pk_to_string(&d.client_pk),
            fee_bps: d.fee_bps,
            fee_amount: U128(d.fee_amount),
            delivery_duration_ns: U64(d.delivery_duration_ns),
            delivery_deadline_ns: d.delivery_deadline_ns.map(U64),
            review_period_ns: U64(d.review_period_ns),
            pay_by_ns: U64(d.pay_by_ns),
            funding_cutoff_ns: U64(self.funding_cutoff(d)),
            funded_at_ns: d.funded_at_ns.map(U64),
            delivered_at_ns: d.delivered_at_ns.map(U64),
            deliverable_hash: d.deliverable_hash.clone(),
            terms_hash: d.terms_hash.clone(),
            creator_payout: U128(d.creator_payout),
            client_payout: U128(d.client_payout),
            created_at_ns: U64(d.created_at_ns),
            review_ends_at_ns: d.review_ends_at_ns().map(U64),
            disputed_at_ns: d.disputed_at_ns.map(U64),
            dispute_ends_at_ns: d.dispute_ends_at_ns.map(U64),
            ended_at_ns: d.ended_at_ns.map(U64),
            outcome: d.outcome,
            settle_seq: d.settle_seq,
            creator_pending: U128(d.creator_pending),
            client_pending: U128(d.client_pending),
            creator_withdrawn: U128(d.creator_withdrawn),
            client_withdrawn: U128(d.client_withdrawn),
            settled: d.settled(),
            creator_fingerprint: fingerprint(&d.creator_pk),
            client_fingerprint: fingerprint(&d.client_pk),
        }
    }
}

/// Parses and checks a withdraw payload: `(destination, amount)`.
fn parse_withdraw(payload: &Value, now: u64) -> (AccountId, u128) {
    let destination: AccountId = str_field(payload, "destination", "withdraw")
        .parse()
        .unwrap_or_else(|_| env::panic_str("withdraw: payload.destination must be a valid account id"));
    let amount = parse_u128_strict(str_field(payload, "amount", "withdraw"), "withdraw: amount");
    let expires_at = parse_u64_strict(str_field(payload, "expires_at_ns", "withdraw"), "withdraw: expires_at_ns");
    require!(now <= expires_at, "withdraw: signature expired");
    (destination, amount)
}

/// Closes an in-flight withdraw of one side. `false` = stale callback
/// (the pending id or amount does not match), nothing changed.
fn close_withdraw(side: Side<'_>, amount: u128, withdraw_id: u64, success: bool) -> bool {
    if *side.pending_id != withdraw_id || *side.pending != amount {
        return false;
    }
    *side.pending = 0;
    *side.pending_id = 0;
    if success {
        *side.withdrawn += amount;
    } else {
        *side.payout += amount;
    }
    true
}

/// Owner's fix of a stuck withdraw of one side; returns the amount.
fn reconcile_side(side: Side<'_>, transferred: bool, now: u64) -> u128 {
    let amount = *side.pending;
    require!(amount > 0, "nothing pending");
    require!(now > side.pending_since.saturating_add(RECONCILE_DELAY_NS), "too early to reconcile");
    *side.pending = 0;
    // A late callback of this withdraw will no longer match and is ignored.
    *side.pending_id = 0;
    if transferred {
        *side.withdrawn += amount;
    } else {
        *side.payout += amount;
    }
    amount
}

/// First 12 hex chars of sha256(pk) as "xxxx-xxxx-xxxx" (48 bits).
pub fn fingerprint(pk: &[u8; 32]) -> String {
    let h = env::sha256(pk);
    let hex: String = h[..6].iter().map(|b| format!("{b:02x}")).collect();
    format!("{}-{}-{}", &hex[0..4], &hex[4..8], &hex[8..12])
}

fn decode_signature(signature: &str) -> [u8; 64] {
    use near_sdk::base64::Engine;
    let bytes = near_sdk::base64::engine::general_purpose::STANDARD
        .decode(signature)
        .unwrap_or_else(|_| env::panic_str("signature must be standard base64"));
    bytes.try_into().unwrap_or_else(|_| env::panic_str("signature must be 64 bytes"))
}

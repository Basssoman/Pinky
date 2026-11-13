//! Unit tests: every allowed and every rejected transition, plus the
//! security-review PoCs ported in inverted form (`poc_*_fixed`), and the
//! v2 rules (full payment, pay_by, settle, fee, purge, PaidOut-only-when-resolved guard, ...).
#![allow(unused_must_use)]

use super::*;
use ed25519_dalek::{Signer, SigningKey};
use near_sdk::base64::Engine;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::{testing_env, PromiseResult, RuntimeFeesConfig};

const T0: u64 = 1_700_000_000 * SEC;
/// Funding happens at T0 + 1 s in the helpers, so a funded deal's delivery
/// deadline is T0 + 3600 s.
const FUNDED_AT: u64 = T0 + SEC;
const DURATION: u64 = 3600 * SEC - SEC;
const DEADLINE: u64 = FUNDED_AT + DURATION;
const MIN_REVIEW: u64 = 60 * SEC;
const REVIEW: u64 = 600 * SEC;
const DISPUTE: u64 = 3600 * SEC;
const PAY_BY: u64 = 7 * 24 * 3600 * SEC;
const GRACE: u64 = 6 * 3600 * SEC;
const AMOUNT: u128 = 5_000_000; // 5 USDC
const SEC_HOUR: u64 = 3600 * SEC;
const DEST: &str = "deposit-address.near";

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn contract_id() -> AccountId {
    acc("escrow.near")
}
fn token() -> AccountId {
    acc("usdc.near")
}
fn relayer() -> AccountId {
    acc("relayer.near")
}
fn arbiter() -> AccountId {
    acc("arbiter.near")
}
fn owner() -> AccountId {
    acc("owner.near")
}
fn fee_acc() -> AccountId {
    acc("fees.near")
}

fn creator_key() -> SigningKey {
    SigningKey::from_bytes(&[1u8; 32])
}
fn client_key() -> SigningKey {
    SigningKey::from_bytes(&[2u8; 32])
}
fn stranger_key() -> SigningKey {
    SigningKey::from_bytes(&[3u8; 32])
}
fn pk_str(k: &SigningKey) -> String {
    pk_to_string(&k.verifying_key().to_bytes())
}
fn b64(bytes: &[u8]) -> String {
    near_sdk::base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn ctx_full(predecessor: AccountId, now: u64, gas: Gas, deposit: NearToken) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(contract_id())
        .predecessor_account_id(predecessor.clone())
        .signer_account_id(predecessor)
        .block_timestamp(now)
        .prepaid_gas(gas)
        .attached_deposit(deposit)
        .account_balance(NearToken::from_near(10));
    testing_env!(b.build());
}
fn ctx(predecessor: AccountId, now: u64) {
    ctx_full(predecessor, now, Gas::from_tgas(300), NearToken::from_yoctonear(0));
}
fn ctx_dep(predecessor: AccountId, now: u64, deposit: NearToken) {
    ctx_full(predecessor, now, Gas::from_tgas(300), deposit);
}

fn ctx_callback(now: u64, result: PromiseResult) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(contract_id())
        .predecessor_account_id(contract_id())
        .block_timestamp(now)
        .prepaid_gas(Gas::from_tgas(300));
    testing_env!(b.build(), near_sdk::test_vm_config(), RuntimeFeesConfig::test(), Default::default(), vec![result]);
}

fn sign(key: &SigningKey, deal_id: u64, action: &str, payload: &str) -> String {
    let msg = signed_message(contract_id().as_str(), deal_id, action, payload);
    b64(&key.sign(msg.as_bytes()).to_bytes())
}

fn test_periods() -> Periods {
    Periods {
        min_review_period_ns: Some(U64(MIN_REVIEW)),
        dispute_period_ns: Some(U64(DISPUTE)),
        ..Default::default()
    }
}

fn setup() -> Contract {
    ctx(contract_id(), T0);
    Contract::new(owner(), token(), arbiter(), relayer(), fee_acc(), Some(test_periods()))
}

const OFFER_TTL: u64 = 1800 * SEC;
/// Default fee in the helpers: 0, so amounts in older tests stay exact.
/// Fee tests use `offer_fee`.
const FEE0: u16 = 0;

fn offer_with(creator: &SigningKey, amount: u128, duration: u64, review: u64, nonce: &str) -> String {
    offer_full(creator, amount, duration, review, nonce, T0 + OFFER_TTL, FEE0)
}

fn offer_fee(creator: &SigningKey, amount: u128, fee_bps: u16, nonce: &str) -> String {
    offer_full(creator, amount, DURATION, REVIEW, nonce, T0 + OFFER_TTL, fee_bps)
}

fn offer_full(
    creator: &SigningKey,
    amount: u128,
    duration: u64,
    review: u64,
    nonce: &str,
    expires: u64,
    fee_bps: u16,
) -> String {
    format!(
        r#"{{"creator_pk":"{}","amount":"{amount}","fee_bps":"{fee_bps}","delivery_duration_ns":"{duration}","review_period_ns":"{review}","terms_hash":"{}","offer_nonce":"{nonce}","offer_expires_at_ns":"{expires}"}}"#,
        pk_str(creator),
        "a".repeat(64)
    )
}

fn sign_offer(key: &SigningKey, offer: &str) -> String {
    b64(&key.sign(offer_message(contract_id().as_str(), offer).as_bytes()).to_bytes())
}

fn nonce(c: &Contract) -> String {
    format!("nonce-{:016}", c.get_config().deals_count)
}

/// Client joins a creator-signed offer with its own key.
fn new_deal(c: &mut Contract) -> u64 {
    let offer = offer_with(&creator_key(), AMOUNT, DURATION, REVIEW, &nonce(c));
    let sig = sign_offer(&creator_key(), &offer);
    ctx_dep(relayer(), T0, DEAL_DEPOSIT);
    c.create_deal(offer, sig, pk_str(&client_key()))
}

fn new_deal_fee(c: &mut Contract, fee_bps: u16) -> u64 {
    let offer = offer_fee(&creator_key(), AMOUNT, fee_bps, &nonce(c));
    let sig = sign_offer(&creator_key(), &offer);
    ctx_dep(relayer(), T0, DEAL_DEPOSIT);
    c.create_deal(offer, sig, pk_str(&client_key()))
}

fn fund_at(c: &mut Contract, id: u64, amount: u128, now: u64) -> U128 {
    ctx(token(), now);
    match c.ft_on_transfer(acc("intents.near"), U128(amount), format!("{{\"deal_id\":{id}}}")) {
        PromiseOrValue::Value(v) => v,
        PromiseOrValue::Promise(_) => panic!("unexpected promise"),
    }
}

fn fund(c: &mut Contract, id: u64, amount: u128) -> U128 {
    fund_at(c, id, amount, FUNDED_AT)
}

fn act(c: &mut Contract, key: &SigningKey, id: u64, action: &str, payload: &str, now: u64) -> PromiseOrValue<bool> {
    if action == "withdraw" {
        ctx_dep(relayer(), now, WITHDRAW_DEPOSIT);
    } else {
        ctx(relayer(), now);
    }
    let sig = sign(key, id, action, payload);
    c.act(id, action.into(), payload.into(), sig)
}

fn state(c: &Contract, id: u64) -> DealState {
    c.get_deal(id).unwrap().state
}

fn funded_deal(c: &mut Contract) -> u64 {
    let id = new_deal(c);
    fund(c, id, AMOUNT);
    id
}

const DELIVERED_AT: u64 = T0 + 10 * SEC;

fn delivered_deal(c: &mut Contract) -> u64 {
    let id = funded_deal(c);
    act(c, &creator_key(), id, "deliver", r#"{"deliverable_hash":"h1"}"#, DELIVERED_AT);
    id
}

fn released_deal(c: &mut Contract) -> u64 {
    let id = delivered_deal(c);
    act(c, &client_key(), id, "accept", "{}", T0 + 20 * SEC);
    id
}

fn disputed_deal(c: &mut Contract) -> u64 {
    let id = delivered_deal(c);
    act(c, &client_key(), id, "dispute", "{}", T0 + 30 * SEC);
    id
}

const W_NOW: u64 = T0 + 50 * SEC;
const W_EXPIRES: u64 = T0 + 1800 * SEC;

fn withdraw_payload(amount: u128) -> String {
    format!(r#"{{"destination":"{DEST}","amount":"{amount}","expires_at_ns":"{W_EXPIRES}"}}"#)
}

fn payout_of(c: &Contract, id: u64, party: Party) -> u128 {
    let d = c.get_deal(id).unwrap();
    match party {
        Party::Creator => d.creator_payout.0,
        Party::Client => d.client_payout.0,
    }
}

/// Starts a withdraw of the party's whole payout; returns (party, amount).
fn start_withdraw(c: &mut Contract, key: &SigningKey, id: u64) -> (Party, u128) {
    let party = if key.verifying_key() == creator_key().verifying_key() { Party::Creator } else { Party::Client };
    let amount = payout_of(c, id, party).max(1);
    match act(c, key, id, "withdraw", &withdraw_payload(amount), W_NOW) {
        PromiseOrValue::Promise(_) => {}
        PromiseOrValue::Value(_) => panic!("expected promise"),
    }
    (party, amount)
}

fn pending_id(c: &Contract, id: u64, party: Party) -> u64 {
    let d = c.deals.get(&id).unwrap();
    match party {
        Party::Creator => d.creator_pending_id,
        Party::Client => d.client_pending_id,
    }
}

fn finish_withdraw(c: &mut Contract, id: u64, party: Party, amount: u128, ok: bool) -> bool {
    let wid = pending_id(c, id, party);
    finish_withdraw_id(c, id, party, amount, ok, wid, W_NOW + SEC)
}

fn finish_withdraw_id(c: &mut Contract, id: u64, party: Party, amount: u128, ok: bool, wid: u64, now: u64) -> bool {
    ctx_callback(now, if ok { PromiseResult::Successful(vec![]) } else { PromiseResult::Failed });
    c.on_withdraw(id, party, U128(amount), acc(DEST), wid)
}

// ================================================================ init / owner

#[test]
#[should_panic(expected = "owner must differ")]
fn init_rejects_owner_equal_relayer() {
    ctx(contract_id(), T0);
    Contract::new(relayer(), token(), arbiter(), relayer(), fee_acc(), None);
}

#[test]
#[should_panic(expected = "owner must differ")]
fn init_rejects_owner_equal_arbiter() {
    ctx(contract_id(), T0);
    Contract::new(arbiter(), token(), arbiter(), relayer(), fee_acc(), None);
}

#[test]
fn init_defaults() {
    ctx(contract_id(), T0);
    let c = Contract::new(owner(), token(), arbiter(), relayer(), fee_acc(), None);
    let cfg = c.get_config();
    assert_eq!(cfg.min_review_period_ns, U64(DEFAULT_MIN_REVIEW_NS));
    assert_eq!(cfg.dispute_period_ns, U64(DEFAULT_DISPUTE_NS));
    assert_eq!(cfg.total_liabilities, U128(0));
}

#[test]
fn owner_rotates_relayer_and_arbiter() {
    let mut c = setup();
    ctx(owner(), T0);
    c.set_relayer(acc("relayer2.near"));
    c.set_arbiter(acc("arbiter2.near"));
    let cfg = c.get_config();
    assert_eq!(cfg.relayer_id, acc("relayer2.near"));
    // v2: the arbiter change waits for the admin delay.
    assert_eq!(cfg.arbiter_id, arbiter());
    assert_eq!(cfg.pending_arbiter.as_ref().unwrap().account_id, acc("arbiter2.near"));
    ctx(acc("anyone.near"), T0 + DEFAULT_ADMIN_DELAY_NS);
    c.apply_admin_changes();
    assert_eq!(c.get_config().arbiter_id, arbiter());
    ctx(acc("anyone.near"), T0 + DEFAULT_ADMIN_DELAY_NS + 1);
    c.apply_admin_changes();
    let cfg = c.get_config();
    assert_eq!(cfg.arbiter_id, acc("arbiter2.near"));
    assert!(cfg.pending_arbiter.is_none());
}

#[test]
#[should_panic(expected = "only owner")]
fn set_relayer_rejects_non_owner() {
    let mut c = setup();
    ctx(relayer(), T0);
    c.set_relayer(acc("relayer2.near"));
}

#[test]
#[should_panic(expected = "only owner")]
fn set_arbiter_rejects_non_owner() {
    let mut c = setup();
    ctx(arbiter(), T0);
    c.set_arbiter(acc("arbiter2.near"));
}

#[test]
#[should_panic(expected = "owner must differ from arbiter")]
fn set_arbiter_rejects_owner_itself() {
    let mut c = setup();
    ctx(owner(), T0);
    c.set_arbiter(owner());
}

// ================================================================ create (offer)

#[test]
fn create_deal_from_signed_offer() {
    let mut c = setup();
    let id = new_deal(&mut c);
    assert_eq!(id, 0);
    let d = c.get_deal(0).unwrap();
    assert_eq!(d.state, DealState::Created);
    assert_eq!(d.amount, U128(AMOUNT));
    assert_eq!(d.creator_pk, pk_str(&creator_key()));
    assert_eq!(d.client_pk, pk_str(&client_key()));
    assert_eq!(d.created_at_ns, U64(T0));
    assert!(d.settled);
    assert_eq!(new_deal(&mut c), 1);
    assert_eq!(c.get_deals(0, 10).len(), 2);
    assert_eq!(c.get_deals(5, 10).len(), 0);
    assert!(c.get_deal(u64::from(u32::MAX) + 1).is_none());
}

#[test]
#[should_panic(expected = "only relayer")]
fn create_deal_rejects_non_relayer() {
    let mut c = setup();
    let offer = offer_with(&creator_key(), AMOUNT, DURATION, REVIEW, "nonce-0000000000000001");
    let sig = sign_offer(&creator_key(), &offer);
    ctx(acc("mallory.near"), T0);
    c.create_deal(offer, sig, pk_str(&client_key()));
}

#[test]
#[should_panic(expected = "offer: invalid creator signature")]
fn create_deal_rejects_offer_not_signed_by_creator() {
    let mut c = setup();
    let offer = offer_with(&creator_key(), AMOUNT, DURATION, REVIEW, "nonce-0000000000000001");
    let sig = sign_offer(&stranger_key(), &offer);
    ctx_dep(relayer(), T0, DEAL_DEPOSIT);
    c.create_deal(offer, sig, pk_str(&client_key()));
}

#[test]
#[should_panic(expected = "offer: invalid creator signature")]
fn create_deal_rejects_tampered_offer_amount() {
    let mut c = setup();
    let offer = offer_with(&creator_key(), AMOUNT, DURATION, REVIEW, "nonce-0000000000000001");
    let sig = sign_offer(&creator_key(), &offer);
    let tampered = offer.replace(&format!("\"{AMOUNT}\""), "\"1\"");
    ctx_dep(relayer(), T0, DEAL_DEPOSIT);
    c.create_deal(tampered, sig, pk_str(&client_key()));
}

#[test]
#[should_panic(expected = "offer: invalid creator signature")]
fn create_deal_rejects_offer_for_other_contract() {
    let mut c = setup();
    let offer = offer_with(&creator_key(), AMOUNT, DURATION, REVIEW, "nonce-0000000000000001");
    let sig = b64(&creator_key().sign(offer_message("other.near", &offer).as_bytes()).to_bytes());
    ctx_dep(relayer(), T0, DEAL_DEPOSIT);
    c.create_deal(offer, sig, pk_str(&client_key()));
}

#[test]
#[should_panic(expected = "offer already used")]
fn create_deal_rejects_reused_offer() {
    let mut c = setup();
    let offer = offer_with(&creator_key(), AMOUNT, DURATION, REVIEW, "nonce-0000000000000001");
    let sig = sign_offer(&creator_key(), &offer);
    ctx_dep(relayer(), T0, DEAL_DEPOSIT);
    c.create_deal(offer.clone(), sig.clone(), pk_str(&client_key()));
    assert!(c.is_offer_used(offer.clone()));
    c.create_deal(offer, sig, pk_str(&stranger_key()));
}

#[test]
#[should_panic(expected = "offer: invalid JSON or fields")]
fn create_deal_rejects_unknown_offer_fields() {
    let mut c = setup();
    let offer = offer_with(&creator_key(), AMOUNT, DURATION, REVIEW, "nonce-0000000000000001").replace('}', r#","client_pk":"x"}"#);
    let sig = sign_offer(&creator_key(), &offer);
    ctx_dep(relayer(), T0, DEAL_DEPOSIT);
    c.create_deal(offer, sig, pk_str(&client_key()));
}

#[test]
#[should_panic(expected = "must differ")]
fn create_deal_rejects_client_equal_creator_key() {
    let mut c = setup();
    let offer = offer_with(&creator_key(), AMOUNT, DURATION, REVIEW, "nonce-0000000000000001");
    let sig = sign_offer(&creator_key(), &offer);
    ctx_dep(relayer(), T0, DEAL_DEPOSIT);
    c.create_deal(offer, sig, pk_str(&creator_key()));
}

#[test]
#[should_panic(expected = "delivery_duration_ns must be")]
fn create_deal_rejects_zero_duration() {
    let mut c = setup();
    let offer = offer_with(&creator_key(), AMOUNT, 0, REVIEW, "nonce-0000000000000001");
    let sig = sign_offer(&creator_key(), &offer);
    ctx_dep(relayer(), T0, DEAL_DEPOSIT);
    c.create_deal(offer, sig, pk_str(&client_key()));
}

#[test]
#[should_panic(expected = "review_period_ns outside the allowed range")]
fn create_deal_rejects_short_review_period() {
    let mut c = setup();
    let offer = offer_with(&creator_key(), AMOUNT, DURATION, MIN_REVIEW - 1, "nonce-0000000000000001");
    let sig = sign_offer(&creator_key(), &offer);
    ctx_dep(relayer(), T0, DEAL_DEPOSIT);
    c.create_deal(offer, sig, pk_str(&client_key()));
}

#[test]
#[should_panic(expected = "amount below the minimum (1 USDC)")]
fn create_deal_rejects_zero_amount() {
    let mut c = setup();
    let offer = offer_with(&creator_key(), 0, DURATION, REVIEW, "nonce-0000000000000001");
    let sig = sign_offer(&creator_key(), &offer);
    ctx_dep(relayer(), T0, DEAL_DEPOSIT);
    c.create_deal(offer, sig, pk_str(&client_key()));
}

#[test]
#[should_panic(expected = "offer_nonce must be 16..64 chars")]
fn create_deal_rejects_short_nonce() {
    let mut c = setup();
    let offer = offer_with(&creator_key(), AMOUNT, DURATION, REVIEW, "short");
    let sig = sign_offer(&creator_key(), &offer);
    ctx_dep(relayer(), T0, DEAL_DEPOSIT);
    c.create_deal(offer, sig, pk_str(&client_key()));
}

#[test]
#[should_panic(expected = "public key")]
fn create_deal_rejects_bad_client_key() {
    let mut c = setup();
    let offer = offer_with(&creator_key(), AMOUNT, DURATION, REVIEW, "nonce-0000000000000001");
    let sig = sign_offer(&creator_key(), &offer);
    ctx_dep(relayer(), T0, DEAL_DEPOSIT);
    c.create_deal(offer, sig, "ed25519:xyz".into());
}

// ================================================================ funding

#[test]
fn funding_exact_moves_to_funded_and_tracks_liabilities() {
    let mut c = setup();
    let id = new_deal(&mut c);
    assert_eq!(fund(&mut c, id, AMOUNT), U128(0));
    let d = c.get_deal(id).unwrap();
    assert_eq!(d.state, DealState::Funded);
    assert_eq!(d.funded_amount, U128(AMOUNT));
    assert_eq!(c.get_config().total_liabilities, U128(AMOUNT));
}

/// v2: two partial payments never add up; only one payment >= amount funds.
#[test]
fn two_partial_payments_do_not_fund_then_full_payment_does() {
    let mut c = setup();
    let id = new_deal(&mut c);
    fund(&mut c, id, 2_000_000);
    fund(&mut c, id, 3_000_000);
    assert_eq!(state(&c, id), DealState::Created);
    assert_eq!(c.get_deal(id).unwrap().client_payout, U128(5_000_000));
    fund(&mut c, id, AMOUNT);
    let d = c.get_deal(id).unwrap();
    assert_eq!(d.state, DealState::Funded);
    assert_eq!(d.funded_amount, U128(AMOUNT));
    assert_eq!(d.client_payout, U128(5_000_000));
    assert_eq!(c.get_config().total_liabilities, U128(10_000_000));
}

#[test]
fn funding_bad_msg_or_unknown_deal_is_orphan_never_panics() {
    let mut c = setup();
    new_deal(&mut c);
    ctx(token(), T0);
    for msg in ["", "not json", "{}", r#"{"deal_id":"abc"}"#, r#"{"deal_id":99}"#, r#"{"deal_id":-1}"#, r#"{"deal_id":18446744073709551615}"#] {
        match c.ft_on_transfer(acc("intents.near"), U128(7), msg.into()) {
            PromiseOrValue::Value(v) => assert_eq!(v, U128(0)),
            _ => panic!(),
        }
    }
    let cfg = c.get_config();
    assert_eq!(cfg.orphan_amount, U128(49));
    assert_eq!(cfg.total_liabilities, U128(0));
}

#[test]
fn funding_accepts_string_deal_id() {
    let mut c = setup();
    let id = new_deal(&mut c);
    ctx(token(), T0);
    c.ft_on_transfer(acc("intents.near"), U128(AMOUNT), r#"{"deal_id":"0"}"#.into());
    assert_eq!(state(&c, id), DealState::Funded);
}

#[test]
fn funding_from_other_token_is_returned_and_not_credited() {
    let mut c = setup();
    let id = new_deal(&mut c);
    ctx(acc("fake-usdc.near"), T0);
    match c.ft_on_transfer(acc("intents.near"), U128(AMOUNT), r#"{"deal_id":0}"#.into()) {
        PromiseOrValue::Value(v) => assert_eq!(v, U128(AMOUNT)),
        _ => panic!(),
    }
    assert_eq!(state(&c, id), DealState::Created);
}

#[test]
fn overpayment_goes_back_to_client_on_release() {
    let mut c = setup();
    let id = new_deal(&mut c);
    fund(&mut c, id, AMOUNT + 1_000);
    act(&mut c, &creator_key(), id, "deliver", r#"{"deliverable_hash":"h"}"#, T0 + 10 * SEC);
    act(&mut c, &client_key(), id, "accept", "{}", T0 + 20 * SEC);
    let d = c.get_deal(id).unwrap();
    assert_eq!(d.creator_payout, U128(AMOUNT));
    assert_eq!(d.client_payout, U128(1_000));
    assert!(!d.settled);
}

#[test]
fn late_funds_after_resolution_go_to_client() {
    let mut c = setup();
    let id = released_deal(&mut c);
    fund(&mut c, id, 123);
    let d = c.get_deal(id).unwrap();
    assert_eq!(d.client_payout, U128(123));
    assert_eq!(d.creator_payout, U128(AMOUNT));
}

// ================================================================ cancel

#[test]
fn cancel_by_creator_when_created() {
    let mut c = setup();
    let id = new_deal(&mut c);
    act(&mut c, &creator_key(), id, "cancel", "{}", T0 + SEC);
    assert_eq!(state(&c, id), DealState::Cancelled);
}

#[test]
fn cancel_partially_funded_credits_client() {
    let mut c = setup();
    let id = new_deal(&mut c);
    fund(&mut c, id, 1_000);
    act(&mut c, &creator_key(), id, "cancel", "{}", T0 + SEC);
    assert_eq!(c.get_deal(id).unwrap().client_payout, U128(1_000));
}

#[test]
#[should_panic(expected = "creator key required")]
fn cancel_rejects_client_key() {
    let mut c = setup();
    let id = new_deal(&mut c);
    act(&mut c, &client_key(), id, "cancel", "{}", T0 + SEC);
}

#[test]
#[should_panic(expected = "cancel: deal must be Created")]
fn cancel_rejects_funded() {
    let mut c = setup();
    let id = funded_deal(&mut c);
    act(&mut c, &creator_key(), id, "cancel", "{}", T0 + SEC);
}

// ================================================================ deliver

#[test]
fn deliver_by_creator_when_funded() {
    let mut c = setup();
    let id = delivered_deal(&mut c);
    let d = c.get_deal(id).unwrap();
    assert_eq!(d.state, DealState::Delivered);
    assert_eq!(d.deliverable_hash.as_deref(), Some("h1"));
    assert_eq!(d.review_ends_at_ns, Some(U64(DELIVERED_AT + REVIEW)));
}

#[test]
fn deliver_exactly_at_deadline_allowed() {
    let mut c = setup();
    let id = funded_deal(&mut c);
    act(&mut c, &creator_key(), id, "deliver", r#"{"deliverable_hash":"h"}"#, DEADLINE);
    assert_eq!(state(&c, id), DealState::Delivered);
}

#[test]
#[should_panic(expected = "deliver: deal must be Funded")]
fn deliver_rejects_unfunded() {
    let mut c = setup();
    let id = new_deal(&mut c);
    act(&mut c, &creator_key(), id, "deliver", r#"{"deliverable_hash":"h"}"#, T0 + SEC);
}

#[test]
#[should_panic(expected = "creator key required")]
fn deliver_rejects_client_key() {
    let mut c = setup();
    let id = funded_deal(&mut c);
    act(&mut c, &client_key(), id, "deliver", r#"{"deliverable_hash":"h"}"#, T0 + SEC);
}

#[test]
#[should_panic(expected = "payload.deliverable_hash (string) required")]
fn deliver_rejects_missing_hash() {
    let mut c = setup();
    let id = funded_deal(&mut c);
    act(&mut c, &creator_key(), id, "deliver", "{}", T0 + SEC);
}

#[test]
#[should_panic(expected = "deliver: deal must be Funded")]
fn deliver_twice_rejected() {
    let mut c = setup();
    let id = delivered_deal(&mut c);
    act(&mut c, &creator_key(), id, "deliver", r#"{"deliverable_hash":"h2"}"#, T0 + 30 * SEC);
}

// ================================================================ signatures

#[test]
#[should_panic(expected = "invalid signature")]
fn rejects_stranger_key() {
    let mut c = setup();
    let id = funded_deal(&mut c);
    act(&mut c, &stranger_key(), id, "deliver", r#"{"deliverable_hash":"h"}"#, T0 + SEC);
}

#[test]
#[should_panic(expected = "invalid signature")]
fn rejects_signature_for_other_action() {
    let mut c = setup();
    let id = funded_deal(&mut c);
    ctx(relayer(), T0 + SEC);
    let sig = sign(&creator_key(), id, "cancel", "{}");
    c.act(id, "refund".into(), "{}".into(), sig);
}

#[test]
#[should_panic(expected = "invalid signature")]
fn rejects_replay_on_another_deal() {
    let mut c = setup();
    let a = funded_deal(&mut c);
    let b = funded_deal(&mut c);
    ctx(relayer(), T0 + SEC);
    let sig = sign(&creator_key(), a, "refund", "{}");
    c.act(a, "refund".into(), "{}".into(), sig.clone());
    assert_eq!(state(&c, a), DealState::Refunded);
    c.act(b, "refund".into(), "{}".into(), sig);
}

#[test]
#[should_panic(expected = "invalid signature")]
fn rejects_tampered_payload() {
    let mut c = setup();
    let id = funded_deal(&mut c);
    ctx(relayer(), T0 + SEC);
    let sig = sign(&creator_key(), id, "deliver", r#"{"deliverable_hash":"a"}"#);
    c.act(id, "deliver".into(), r#"{"deliverable_hash":"b"}"#.into(), sig);
}

#[test]
#[should_panic(expected = "invalid signature")]
fn rejects_signature_for_other_contract() {
    let mut c = setup();
    let id = funded_deal(&mut c);
    ctx(relayer(), T0 + SEC);
    let msg = signed_message("other-escrow.near", id, "refund", "{}");
    c.act(id, "refund".into(), "{}".into(), b64(&creator_key().sign(msg.as_bytes()).to_bytes()));
}

#[test]
#[should_panic(expected = "invalid signature")]
fn rejects_offer_signature_used_as_action() {
    let mut c = setup();
    let id = funded_deal(&mut c);
    let offer = offer_with(&creator_key(), AMOUNT, DURATION, REVIEW, &nonce(&c));
    let sig = sign_offer(&creator_key(), &offer);
    ctx(relayer(), T0 + SEC);
    c.act(id, "refund".into(), offer, sig);
}

#[test]
#[should_panic(expected = "signature must be standard base64")]
fn rejects_malformed_signature() {
    let mut c = setup();
    let id = funded_deal(&mut c);
    ctx(relayer(), T0 + SEC);
    c.act(id, "refund".into(), "{}".into(), "!!!".into());
}

#[test]
#[should_panic(expected = "signature must be 64 bytes")]
fn rejects_short_signature() {
    let mut c = setup();
    let id = funded_deal(&mut c);
    ctx(relayer(), T0 + SEC);
    c.act(id, "refund".into(), "{}".into(), "AAAA".into());
}

#[test]
#[should_panic(expected = "unknown action")]
fn rejects_unknown_action() {
    let mut c = setup();
    let id = funded_deal(&mut c);
    act(&mut c, &creator_key(), id, "pay-quote", "{}", T0 + SEC);
}

#[test]
#[should_panic(expected = "payload must be a JSON object")]
fn rejects_non_object_payload() {
    let mut c = setup();
    let id = funded_deal(&mut c);
    act(&mut c, &creator_key(), id, "refund", "[]", T0 + SEC);
}

#[test]
#[should_panic(expected = "deal not found")]
fn rejects_unknown_deal() {
    let mut c = setup();
    act(&mut c, &creator_key(), 42, "cancel", "{}", T0 + SEC);
}

// ================================================================ refund

#[test]
fn creator_refunds_voluntarily() {
    let mut c = setup();
    let id = funded_deal(&mut c);
    act(&mut c, &creator_key(), id, "refund", "{}", T0 + SEC);
    let d = c.get_deal(id).unwrap();
    assert_eq!(d.state, DealState::Refunded);
    assert_eq!(d.client_payout, U128(AMOUNT));
}

#[test]
fn client_refunds_after_deadline() {
    let mut c = setup();
    let id = funded_deal(&mut c);
    act(&mut c, &client_key(), id, "refund", "{}", DEADLINE + 1);
    assert_eq!(state(&c, id), DealState::Refunded);
}

#[test]
#[should_panic(expected = "client may refund only")]
fn client_refund_before_deadline_rejected() {
    let mut c = setup();
    let id = funded_deal(&mut c);
    act(&mut c, &client_key(), id, "refund", "{}", DEADLINE);
}

#[test]
#[should_panic(expected = "refund: deal must be Funded")]
fn client_refund_after_delivery_rejected() {
    let mut c = setup();
    let id = delivered_deal(&mut c);
    act(&mut c, &client_key(), id, "refund", "{}", DEADLINE + 1);
}

/// v2: an underpayment never funds the deal and is withdrawable at once
/// (no Created-state refund any more).
#[test]
fn underpayment_is_client_payout_at_once_and_withdrawable() {
    let mut c = setup();
    let id = new_deal(&mut c);
    fund(&mut c, id, 1_000);
    let d = c.get_deal(id).unwrap();
    assert_eq!(d.state, DealState::Created);
    assert_eq!(d.funded_amount, U128(0));
    assert_eq!(d.client_payout, U128(1_000));
    assert!(d.delivery_deadline_ns.is_none());
    let (party, amount) = start_withdraw(&mut c, &client_key(), id);
    assert!(finish_withdraw(&mut c, id, party, amount, true));
    assert_eq!(state(&c, id), DealState::Created, "a live deal never becomes PaidOut");
}

#[test]
#[should_panic(expected = "refund: deal must be Funded")]
fn client_refund_unfunded_created_rejected() {
    let mut c = setup();
    let id = new_deal(&mut c);
    act(&mut c, &client_key(), id, "refund", "{}", DEADLINE + 1);
}

#[test]
#[should_panic(expected = "refund: deal must be Funded")]
fn creator_refund_after_delivery_rejected() {
    let mut c = setup();
    let id = delivered_deal(&mut c);
    act(&mut c, &creator_key(), id, "refund", "{}", T0 + 30 * SEC);
}

// ================================================================ accept / dispute / timeout

#[test]
fn accept_by_client_releases() {
    let mut c = setup();
    let id = released_deal(&mut c);
    let d = c.get_deal(id).unwrap();
    assert_eq!(d.state, DealState::Released);
    assert_eq!(d.creator_payout, U128(AMOUNT));
}

#[test]
#[should_panic(expected = "client key required")]
fn accept_rejects_creator_key() {
    let mut c = setup();
    let id = delivered_deal(&mut c);
    act(&mut c, &creator_key(), id, "accept", "{}", T0 + 30 * SEC);
}

#[test]
#[should_panic(expected = "accept: deal must be Delivered")]
fn accept_rejects_funded() {
    let mut c = setup();
    let id = funded_deal(&mut c);
    act(&mut c, &client_key(), id, "accept", "{}", T0 + 30 * SEC);
}

#[test]
fn dispute_within_review_period_sets_dispute_deadline() {
    let mut c = setup();
    let id = delivered_deal(&mut c);
    act(&mut c, &client_key(), id, "dispute", "{}", DELIVERED_AT + REVIEW);
    let d = c.get_deal(id).unwrap();
    assert_eq!(d.state, DealState::Disputed);
    assert_eq!(d.disputed_at_ns, Some(U64(DELIVERED_AT + REVIEW)));
    assert_eq!(d.dispute_ends_at_ns, Some(U64(DELIVERED_AT + REVIEW + DISPUTE)));
}

#[test]
#[should_panic(expected = "review period is over")]
fn dispute_after_review_period_rejected() {
    let mut c = setup();
    let id = delivered_deal(&mut c);
    act(&mut c, &client_key(), id, "dispute", "{}", DELIVERED_AT + REVIEW + 1);
}

#[test]
#[should_panic(expected = "client key required")]
fn dispute_rejects_creator_key() {
    let mut c = setup();
    let id = delivered_deal(&mut c);
    act(&mut c, &creator_key(), id, "dispute", "{}", T0 + 30 * SEC);
}

#[test]
fn release_after_timeout_by_anyone() {
    let mut c = setup();
    let id = delivered_deal(&mut c);
    ctx(acc("anyone.near"), DELIVERED_AT + REVIEW + 1);
    c.release_after_timeout(id);
    assert_eq!(state(&c, id), DealState::Released);
}

#[test]
#[should_panic(expected = "review period is not over yet")]
fn release_before_timeout_rejected() {
    let mut c = setup();
    let id = delivered_deal(&mut c);
    ctx(acc("anyone.near"), DELIVERED_AT + REVIEW);
    c.release_after_timeout(id);
}

#[test]
#[should_panic(expected = "deal must be Delivered")]
fn release_after_timeout_rejects_disputed() {
    let mut c = setup();
    let id = disputed_deal(&mut c);
    ctx(acc("anyone.near"), DELIVERED_AT + REVIEW + 1);
    c.release_after_timeout(id);
}

// ================================================================ arbiter

#[test]
fn resolve_split() {
    let mut c = setup();
    let id = disputed_deal(&mut c);
    ctx(arbiter(), T0 + 40 * SEC);
    c.resolve_dispute(id, 6_000);
    let d = c.get_deal(id).unwrap();
    assert_eq!(d.state, DealState::Released);
    assert_eq!(d.creator_payout, U128(3_000_000));
    assert_eq!(d.client_payout, U128(2_000_000));
}

#[test]
fn resolve_full_client_is_refund() {
    let mut c = setup();
    let id = disputed_deal(&mut c);
    ctx(arbiter(), T0 + 40 * SEC);
    c.resolve_dispute(id, 0);
    assert_eq!(state(&c, id), DealState::Refunded);
}

#[test]
#[should_panic(expected = "only arbiter")]
fn resolve_rejects_non_arbiter() {
    let mut c = setup();
    let id = disputed_deal(&mut c);
    ctx(owner(), T0 + 40 * SEC);
    c.resolve_dispute(id, 5_000);
}

#[test]
#[should_panic(expected = "must be <= 10000")]
fn resolve_rejects_bps_over_max() {
    let mut c = setup();
    let id = disputed_deal(&mut c);
    ctx(arbiter(), T0 + 40 * SEC);
    c.resolve_dispute(id, 10_001);
}

#[test]
#[should_panic(expected = "deal must be Disputed")]
fn resolve_rejects_not_disputed() {
    let mut c = setup();
    let id = delivered_deal(&mut c);
    ctx(arbiter(), T0 + 40 * SEC);
    c.resolve_dispute(id, 5_000);
}

#[test]
#[should_panic(expected = "dispute period is not over yet")]
fn dispute_timeout_too_early_rejected() {
    let mut c = setup();
    let id = disputed_deal(&mut c);
    ctx(acc("anyone.near"), T0 + 30 * SEC + DISPUTE);
    c.resolve_dispute_timeout(id);
}

// ================================================================ withdraw

#[test]
fn withdraw_success_marks_paid_out_and_reduces_liabilities() {
    let mut c = setup();
    let id = released_deal(&mut c);
    let (party, amount) = start_withdraw(&mut c, &creator_key(), id);
    assert_eq!(amount, AMOUNT);
    let d = c.get_deal(id).unwrap();
    assert_eq!(d.creator_payout, U128(0));
    assert_eq!(d.creator_pending, U128(AMOUNT));
    assert!(!d.settled);
    assert!(finish_withdraw(&mut c, id, party, amount, true));
    let d = c.get_deal(id).unwrap();
    assert_eq!(d.state, DealState::PaidOut);
    assert_eq!(d.creator_withdrawn, U128(AMOUNT));
    assert!(d.settled);
    assert_eq!(c.get_config().total_liabilities, U128(0));
    assert!(get_logs().iter().any(|l| l.contains("withdraw_done")));
}

#[test]
fn withdraw_failure_restores_payout() {
    let mut c = setup();
    let id = released_deal(&mut c);
    let (party, amount) = start_withdraw(&mut c, &creator_key(), id);
    assert!(!finish_withdraw(&mut c, id, party, amount, false));
    let d = c.get_deal(id).unwrap();
    assert_eq!(d.state, DealState::Released);
    assert_eq!(d.creator_payout, U128(AMOUNT));
    assert_eq!(d.creator_pending, U128(0));
    assert_eq!(c.get_config().total_liabilities, U128(AMOUNT));
    // a FRESH signature (different expiry) works
    let payload = format!(r#"{{"destination":"{DEST}","amount":"{AMOUNT}","expires_at_ns":"{}"}}"#, W_EXPIRES + 1);
    act(&mut c, &creator_key(), id, "withdraw", &payload, W_NOW + 2 * SEC);
    assert_eq!(c.get_deal(id).unwrap().creator_pending, U128(AMOUNT));
}

#[test]
#[should_panic(expected = "another withdrawal is in progress")]
fn withdraw_while_pending_rejected() {
    let mut c = setup();
    let id = new_deal(&mut c);
    fund(&mut c, id, AMOUNT);
    act(&mut c, &creator_key(), id, "refund", "{}", T0 + 3 * SEC);
    act(&mut c, &client_key(), id, "withdraw", &withdraw_payload(1_000), W_NOW);
    act(&mut c, &client_key(), id, "withdraw", &withdraw_payload(2_000), W_NOW);
}

#[test]
#[should_panic(expected = "amount exceeds the withdrawable payout")]
fn withdraw_more_than_payout_rejected() {
    let mut c = setup();
    let id = released_deal(&mut c);
    act(&mut c, &creator_key(), id, "withdraw", &withdraw_payload(AMOUNT + 1), W_NOW);
}

#[test]
#[should_panic(expected = "withdraw: signature expired")]
fn withdraw_after_expiry_rejected() {
    let mut c = setup();
    let id = released_deal(&mut c);
    act(&mut c, &creator_key(), id, "withdraw", &withdraw_payload(AMOUNT), W_EXPIRES + 1);
}

#[test]
#[should_panic(expected = "payload.amount (string) required")]
fn withdraw_without_amount_rejected() {
    let mut c = setup();
    let id = released_deal(&mut c);
    act(&mut c, &creator_key(), id, "withdraw", &format!(r#"{{"destination":"{DEST}","expires_at_ns":"{W_EXPIRES}"}}"#), W_NOW);
}

#[test]
#[should_panic(expected = "payload.expires_at_ns (string) required")]
fn withdraw_without_expiry_rejected() {
    let mut c = setup();
    let id = released_deal(&mut c);
    act(&mut c, &creator_key(), id, "withdraw", &format!(r#"{{"destination":"{DEST}","amount":"{AMOUNT}"}}"#), W_NOW);
}

#[test]
#[should_panic(expected = "signature already used")]
fn withdraw_replay_after_success_rejected() {
    let mut c = setup();
    let id = released_deal(&mut c);
    let (party, amount) = start_withdraw(&mut c, &creator_key(), id);
    finish_withdraw(&mut c, id, party, amount, true);
    fund(&mut c, id, 10); // late funds; creator replay must still fail
    act(&mut c, &creator_key(), id, "withdraw", &withdraw_payload(AMOUNT), W_NOW + 5 * SEC);
}

#[test]
#[should_panic(expected = "nothing to withdraw")]
fn withdraw_by_client_with_zero_payout_rejected() {
    let mut c = setup();
    let id = released_deal(&mut c);
    act(&mut c, &client_key(), id, "withdraw", &withdraw_payload(1), W_NOW);
}

/// v2: no state check on withdraw, but the creator has nothing before release.
#[test]
#[should_panic(expected = "nothing to withdraw for this key")]
fn withdraw_before_release_rejected() {
    let mut c = setup();
    let id = delivered_deal(&mut c);
    act(&mut c, &creator_key(), id, "withdraw", &withdraw_payload(AMOUNT), W_NOW);
}

#[test]
#[should_panic(expected = "invalid signature")]
fn withdraw_stranger_rejected() {
    let mut c = setup();
    let id = released_deal(&mut c);
    act(&mut c, &stranger_key(), id, "withdraw", &withdraw_payload(AMOUNT), W_NOW);
}

#[test]
#[should_panic(expected = "destination must be a valid account id")]
fn withdraw_bad_destination_rejected() {
    let mut c = setup();
    let id = released_deal(&mut c);
    act(&mut c, &creator_key(), id, "withdraw", &format!(r#"{{"destination":"NOT VALID","amount":"1","expires_at_ns":"{W_EXPIRES}"}}"#), W_NOW);
}

#[test]
#[should_panic(expected = "bad destination")]
fn withdraw_to_self_rejected() {
    let mut c = setup();
    let id = released_deal(&mut c);
    act(&mut c, &creator_key(), id, "withdraw", &format!(r#"{{"destination":"escrow.near","amount":"1","expires_at_ns":"{W_EXPIRES}"}}"#), W_NOW);
}

#[test]
#[should_panic(expected = "attach at least 100 TGas")]
fn withdraw_low_gas_rejected() {
    let mut c = setup();
    let id = released_deal(&mut c);
    ctx_full(relayer(), W_NOW, Gas::from_tgas(50), WITHDRAW_DEPOSIT);
    let payload = withdraw_payload(AMOUNT);
    let sig = sign(&creator_key(), id, "withdraw", &payload);
    c.act(id, "withdraw".into(), payload, sig);
}

#[test]
fn split_both_parties_withdraw_then_paid_out() {
    let mut c = setup();
    let id = disputed_deal(&mut c);
    ctx(arbiter(), T0 + 40 * SEC);
    c.resolve_dispute(id, 5_000);
    let (p1, a1) = start_withdraw(&mut c, &creator_key(), id);
    finish_withdraw(&mut c, id, p1, a1, true);
    assert_eq!(state(&c, id), DealState::Released);
    let (p2, a2) = start_withdraw(&mut c, &client_key(), id);
    assert_eq!((p2, a2), (Party::Client, 2_500_000));
    finish_withdraw(&mut c, id, p2, a2, true);
    assert_eq!(state(&c, id), DealState::PaidOut);
    assert_eq!(c.get_config().total_liabilities, U128(0));
}

#[test]
fn late_funds_after_paid_out_withdrawable_by_client_and_unsettled() {
    let mut c = setup();
    let id = released_deal(&mut c);
    let (p, a) = start_withdraw(&mut c, &creator_key(), id);
    finish_withdraw(&mut c, id, p, a, true);
    fund(&mut c, id, 55);
    let d = c.get_deal(id).unwrap();
    assert_eq!(d.state, DealState::PaidOut);
    assert!(!d.settled, "late funds must be visible despite PaidOut");
    let (p, a) = start_withdraw(&mut c, &client_key(), id);
    assert_eq!((p, a), (Party::Client, 55));
}

// ================================================================ reconcile

#[test]
fn reconcile_pending_not_transferred_restores_payout() {
    let mut c = setup();
    let id = released_deal(&mut c);
    start_withdraw(&mut c, &creator_key(), id);
    let wid = pending_id(&c, id, Party::Creator);
    ctx(owner(), W_NOW + RECONCILE_DELAY_NS + 1);
    c.reconcile_pending(id, Party::Creator, false, "FtRcpt111".into());
    let d = c.get_deal(id).unwrap();
    assert_eq!((d.creator_payout, d.creator_pending), (U128(AMOUNT), U128(0)));
    // a late callback is ignored (and logged)
    assert!(finish_withdraw_id(&mut c, id, Party::Creator, AMOUNT, true, wid, W_NOW + RECONCILE_DELAY_NS + 2));
    assert!(get_logs().iter().any(|l| l.contains("withdraw_stale_callback")));
    let d = c.get_deal(id).unwrap();
    assert_eq!((d.creator_payout, d.creator_withdrawn), (U128(AMOUNT), U128(0)));
}

#[test]
fn reconcile_pending_transferred_marks_paid() {
    let mut c = setup();
    let id = released_deal(&mut c);
    start_withdraw(&mut c, &creator_key(), id);
    ctx(owner(), W_NOW + RECONCILE_DELAY_NS + 1);
    c.reconcile_pending(id, Party::Creator, true, "FtRcpt111".into());
    let d = c.get_deal(id).unwrap();
    assert_eq!(d.state, DealState::PaidOut);
    assert_eq!(d.creator_withdrawn, U128(AMOUNT));
    assert_eq!(c.get_config().total_liabilities, U128(0));
}

#[test]
#[should_panic(expected = "too early to reconcile")]
fn reconcile_too_early_rejected() {
    let mut c = setup();
    let id = released_deal(&mut c);
    start_withdraw(&mut c, &creator_key(), id);
    ctx(owner(), W_NOW + 10 * SEC);
    c.reconcile_pending(id, Party::Creator, false, "FtRcpt111".into());
}

#[test]
#[should_panic(expected = "only owner")]
fn reconcile_rejects_non_owner() {
    let mut c = setup();
    let id = released_deal(&mut c);
    start_withdraw(&mut c, &creator_key(), id);
    ctx(relayer(), W_NOW + RECONCILE_DELAY_NS + 1);
    c.reconcile_pending(id, Party::Creator, false, "FtRcpt111".into());
}

// ================================================================ sweep (unit part; cross-contract in sandbox)

fn seq(c: &Contract) -> U64 {
    c.get_config().ledger_seq
}

fn owner_yocto(now: u64) {
    ctx_full(owner(), now, Gas::from_tgas(300), NearToken::from_yoctonear(1));
}

/// Both reads of a two-step `sweep_unaccounted`, 1 h apart, same balance.
fn sweep_two_step(c: &mut Contract, receiver: AccountId, amount: u128, balance: u128, now: u64) -> PromiseOrValue<bool> {
    ctx_callback(now, PromiseResult::Successful(vec![]));
    let s = seq(c);
    let first = c.on_sweep_balance(receiver.clone(), U128(amount), s, Ok(U128(balance)));
    assert!(matches!(first, PromiseOrValue::Value(false)), "the first read only records a snapshot");
    ctx_callback(now + SWEEP_CONFIRM_DELAY_NS, PromiseResult::Successful(vec![]));
    let s = seq(c);
    c.on_sweep_balance(receiver, U128(amount), s, Ok(U128(balance)))
}

/// Orphans are swept without a balance read, capped at orphan_amount.
#[test]
fn sweep_orphans_capped_without_balance_read() {
    let mut c = setup();
    let id = funded_deal(&mut c); // liabilities = AMOUNT
    ctx(token(), T0);
    c.ft_on_transfer(acc("intents.near"), U128(300), "garbage".into()); // orphan 300
    owner_yocto(T0 + SEC);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.sweep_orphans(owner(), U128(301))));
    assert!(r.is_err(), "more than the orphans is refused");
    owner_yocto(T0 + SEC);
    let _ = c.sweep_orphans(owner(), U128(300));
    let cfg = c.get_config();
    assert_eq!((cfg.sweep_reserved, cfg.orphan_amount), (U128(300), U128(0)));
    owner_yocto(T0 + SEC);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.sweep_orphans(owner(), U128(1))));
    assert!(r.is_err(), "the same orphans cannot be swept twice");
    ctx_callback(T0 + 2 * SEC, PromiseResult::Successful(vec![]));
    assert!(c.on_sweep_done(owner(), U128(300), U128(300)));
    let cfg = c.get_config();
    assert_eq!((cfg.sweep_reserved, cfg.orphan_amount), (U128(0), U128(0)));
    assert_eq!(c.get_deal(id).unwrap().funded_amount, U128(AMOUNT));
}

/// sweep_unaccounted takes only untracked tokens (not orphans), after two
/// equal reads 1 h apart.
#[test]
fn sweep_unaccounted_two_step_caps_at_untracked() {
    let mut c = setup();
    let _id = funded_deal(&mut c);
    ctx(token(), T0 + 2 * SEC);
    c.ft_on_transfer(acc("intents.near"), U128(300), "garbage".into()); // orphan 300
    let balance = AMOUNT + 300 + 70; // + a plain ft_transfer of 70
    let r = sweep_two_step(&mut c, owner(), 71, balance, T0 + 10 * SEC);
    assert!(matches!(r, PromiseOrValue::Value(false)), "orphans are not untracked surplus");
    assert_eq!(c.get_config().sweep_reserved, U128(0));
    let r = sweep_two_step(&mut c, owner(), 70, balance, T0 + 2 * SEC_HOUR);
    assert!(matches!(r, PromiseOrValue::Promise(_)));
    let cfg = c.get_config();
    assert_eq!((cfg.sweep_reserved, cfg.orphan_amount), (U128(70), U128(300)));
    assert!(cfg.sweep_snapshot_at_ns.is_none(), "the snapshot is used up");
}

/// Orphan accounting, scenario A: a payment already moved on the token but not yet
/// credited (ft_on_transfer pending) is never swept.
#[test]
fn sweep_never_takes_an_in_flight_payment() {
    let mut c = setup();
    let id = new_deal(&mut c);
    // the client's 5 USDC moved on the token; ft_on_transfer has not run
    ctx_callback(T0 + 10 * SEC, PromiseResult::Successful(vec![]));
    let s = seq(&c);
    assert!(matches!(c.on_sweep_balance(owner(), U128(AMOUNT), s, Ok(U128(AMOUNT))), PromiseOrValue::Value(false)));
    // now the payment is credited (ledger changes) ...
    fund_at(&mut c, id, AMOUNT, T0 + 11 * SEC);
    // ... so the confirming read an hour later finds nothing to sweep
    ctx_callback(T0 + 10 * SEC + SWEEP_CONFIRM_DELAY_NS, PromiseResult::Successful(vec![]));
    let s = seq(&c);
    let r = c.on_sweep_balance(owner(), U128(AMOUNT), s, Ok(U128(AMOUNT)));
    assert!(matches!(r, PromiseOrValue::Value(false)));
    assert_eq!(c.get_config().sweep_reserved, U128(0));
    assert_eq!(state(&c, id), DealState::Funded);
}

/// Orphan accounting as one read: the credit lands between the read and the
/// callback (the ledger changed) -> refused.
#[test]
fn sweep_refused_when_ledger_changes_during_the_read() {
    let mut c = setup();
    let id = new_deal(&mut c);
    let s = seq(&c); // sweep_unaccounted started here
    fund_at(&mut c, id, AMOUNT, T0 + 11 * SEC);
    ctx_callback(T0 + 12 * SEC, PromiseResult::Successful(vec![]));
    let r = c.on_sweep_balance(owner(), U128(1), s, Ok(U128(AMOUNT + 1)));
    assert!(matches!(r, PromiseOrValue::Value(false)));
    assert!(c.get_config().sweep_snapshot_at_ns.is_none());
}

/// Orphan accounting, scenario B: a withdraw that completes between the two reads
/// changes the ledger, so the stale balance is never used.
#[test]
fn sweep_refused_after_a_withdraw_between_reads() {
    let mut c = setup();
    let a = released_deal(&mut c);
    let _b = funded_deal(&mut c);
    let balance = 2 * AMOUNT;
    ctx_callback(W_NOW - SEC, PromiseResult::Successful(vec![]));
    let s = seq(&c);
    assert!(matches!(c.on_sweep_balance(owner(), U128(AMOUNT), s, Ok(U128(balance))), PromiseOrValue::Value(false)));
    let (party, amount) = start_withdraw(&mut c, &creator_key(), a);
    assert!(finish_withdraw(&mut c, a, party, amount, true));
    ctx_callback(W_NOW - SEC + SWEEP_CONFIRM_DELAY_NS, PromiseResult::Successful(vec![]));
    let s = seq(&c);
    let r = c.on_sweep_balance(owner(), U128(AMOUNT), s, Ok(U128(balance)));
    assert!(matches!(r, PromiseOrValue::Value(false)));
    assert_eq!(c.get_config().total_liabilities, U128(AMOUNT));
}

/// A different balance on the second read, a read too early or a stale
/// snapshot only records a new snapshot.
#[test]
fn sweep_needs_equal_balance_delay_and_fresh_snapshot() {
    let mut c = setup();
    let t = T0 + 10 * SEC;
    ctx_callback(t, PromiseResult::Successful(vec![]));
    let s = seq(&c);
    let _ = c.on_sweep_balance(owner(), U128(50), s, Ok(U128(100)));
    // too early
    ctx_callback(t + SWEEP_CONFIRM_DELAY_NS - 1, PromiseResult::Successful(vec![]));
    assert!(matches!(c.on_sweep_balance(owner(), U128(50), s, Ok(U128(100))), PromiseOrValue::Value(false)));
    // the early read replaced the snapshot; a different balance later also fails
    let t2 = t + SWEEP_CONFIRM_DELAY_NS - 1;
    ctx_callback(t2 + SWEEP_CONFIRM_DELAY_NS, PromiseResult::Successful(vec![]));
    assert!(matches!(c.on_sweep_balance(owner(), U128(50), s, Ok(U128(101))), PromiseOrValue::Value(false)));
    // stale (older than the TTL)
    let t3 = t2 + SWEEP_CONFIRM_DELAY_NS;
    ctx_callback(t3 + SWEEP_SNAPSHOT_TTL_NS + 1, PromiseResult::Successful(vec![]));
    assert!(matches!(c.on_sweep_balance(owner(), U128(50), s, Ok(U128(101))), PromiseOrValue::Value(false)));
    // equal, after the delay, fresh -> sweeps
    let t4 = t3 + SWEEP_SNAPSHOT_TTL_NS + 1;
    ctx_callback(t4 + SWEEP_CONFIRM_DELAY_NS, PromiseResult::Successful(vec![]));
    assert!(matches!(c.on_sweep_balance(owner(), U128(50), s, Ok(U128(101))), PromiseOrValue::Promise(_)));
}

#[test]
#[should_panic(expected = "only owner")]
fn sweep_rejects_non_owner() {
    let mut c = setup();
    ctx_full(relayer(), T0, Gas::from_tgas(300), NearToken::from_yoctonear(1));
    c.sweep_unaccounted(relayer(), U128(1));
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn sweep_requires_one_yocto() {
    let mut c = setup();
    ctx(owner(), T0);
    c.sweep_unaccounted(owner(), U128(1));
}

#[test]
#[should_panic(expected = "only owner")]
fn assign_orphan_rejects_non_owner() {
    let mut c = setup();
    let id = new_deal(&mut c);
    ctx(token(), T0);
    c.ft_on_transfer(acc("intents.near"), U128(10), "".into());
    ctx(relayer(), T0);
    c.assign_orphan(id, U128(10));
}

#[test]
#[should_panic(expected = "amount exceeds orphan_amount")]
fn assign_orphan_rejects_more_than_orphans() {
    let mut c = setup();
    let id = new_deal(&mut c);
    ctx(owner(), T0);
    c.assign_orphan(id, U128(1));
}

// ================================================================ security review PoCs, inverted

/// The creator never holds the client key. The deal's client key is the
/// one supplied when the client joins; the creator's key cannot accept, and
/// the creator cannot reuse its offer to open a parallel deal with a client
/// key it controls.
#[test]
fn poc_creator_holding_client_key_takes_funds_fixed() {
    let mut c = setup();
    let offer = offer_with(&creator_key(), AMOUNT, DURATION, REVIEW, "nonce-poc-000000001");
    let sig = sign_offer(&creator_key(), &offer);
    ctx_dep(relayer(), T0, DEAL_DEPOSIT);
    let id = c.create_deal(offer.clone(), sig.clone(), pk_str(&client_key()));
    fund(&mut c, id, AMOUNT);
    act(&mut c, &creator_key(), id, "deliver", r#"{"deliverable_hash":"junk"}"#, T0 + 2 * SEC);
    // creator tries to accept with its own key -> rejected
    ctx(relayer(), T0 + 3 * SEC);
    let forged = sign(&creator_key(), id, "accept", "{}");
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.act(id, "accept".into(), "{}".into(), forged);
    }));
    assert!(r.is_err(), "creator key must not be able to accept");
    // creator tries to reuse the same offer with a client key it controls -> rejected
    ctx_dep(relayer(), T0 + 3 * SEC, DEAL_DEPOSIT);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.create_deal(offer.clone(), sig.clone(), pk_str(&stranger_key()));
    }));
    assert!(r.is_err(), "offer must be single-use");
    assert_eq!(state(&c, id), DealState::Delivered);
    assert_eq!(c.get_deal(id).unwrap().creator_payout, U128(0));
}

/// F-replay: a withdraw signature whose transfer failed stays burned; a
/// stranger cannot re-submit it later (also it would be expired).
#[test]
fn poc_failed_withdraw_signature_replayable_by_anyone_later_fixed() {
    let mut c = setup();
    let id = released_deal(&mut c);
    let payload = withdraw_payload(AMOUNT);
    let sig = sign(&creator_key(), id, "withdraw", &payload);
    ctx_dep(relayer(), W_NOW, WITHDRAW_DEPOSIT);
    c.act(id, "withdraw".into(), payload.clone(), sig.clone());
    assert!(!finish_withdraw(&mut c, id, Party::Creator, AMOUNT, false));
    // immediately: still burned
    ctx_dep(acc("mallory.near"), W_NOW + 2 * SEC, WITHDRAW_DEPOSIT);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.act(id, "withdraw".into(), payload.clone(), sig.clone());
    }));
    assert!(r.is_err());
    // 30 days later: rejected as well
    ctx_dep(acc("mallory.near"), T0 + 30 * 24 * 3600 * SEC, WITHDRAW_DEPOSIT);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.act(id, "withdraw".into(), payload.clone(), sig.clone());
    }));
    assert!(r.is_err());
    let d = c.get_deal(id).unwrap();
    assert_eq!(d.creator_pending, U128(0));
    assert_eq!(d.creator_payout, U128(AMOUNT));
}

/// F-amount: the signed amount is exactly what is transferred; late funds
/// stay on the deal for a separate withdraw.
#[test]
fn poc_withdraw_amount_not_bound_to_quote_fixed() {
    let mut c = setup();
    let id = new_deal(&mut c);
    fund(&mut c, id, AMOUNT);
    act(&mut c, &creator_key(), id, "refund", "{}", T0 + 3 * SEC); // client_payout = AMOUNT
    let payload = withdraw_payload(AMOUNT); // signed for the quoted amount
    fund(&mut c, id, 7); // late delivery before execution
    act(&mut c, &client_key(), id, "withdraw", &payload, W_NOW);
    let d = c.get_deal(id).unwrap();
    assert_eq!(d.client_pending, U128(AMOUNT)); // exactly the quoted amount
    assert_eq!(d.client_payout, U128(7)); // the rest stays withdrawable
}

/// F-dos: on-chain storage per deal is bounded even with maximum-size fields
/// (deals can only be created by the relayer from creator-signed offers).
#[test]
fn poc_storage_cost_per_deal_paid_by_escrow_fixed() {
    let mut c = setup();
    let id = funded_deal(&mut c);
    act(&mut c, &creator_key(), id, "deliver", &format!(r#"{{"deliverable_hash":"{}"}}"#, "h".repeat(MAX_HASH_LEN)), T0 + 2 * SEC);
    // terms_hash in the offer is 64 chars; use the maximum for the bound.
    let mut deal = c.deals.get(&id).unwrap().clone();
    deal.terms_hash = "t".repeat(MAX_HASH_LEN);
    let deal_bytes = near_sdk::borsh::to_vec(&deal).unwrap().len();
    // + vector entry key (~8) + used-offer hash entry (~40) + one used-withdrawal hash (~40)
    // + per-record trie overhead (40 bytes each, 3 records)
    let per_deal = deal_bytes + 8 + 40 + 40 + 3 * 40;
    println!("storage bytes per deal (max fields): {per_deal}");
    assert!(per_deal < 900, "per-deal storage too large: {per_deal}");
}

/// Orphans now have an exit: the owner can credit them to the right deal
/// (sweeping the unaccounted rest is covered by the sandbox test).
#[test]
fn poc_orphan_funds_have_no_exit_fixed() {
    let mut c = setup();
    let id = new_deal(&mut c);
    ctx(token(), T0);
    c.ft_on_transfer(acc("intents.near"), U128(AMOUNT), "".into());
    assert_eq!(c.get_config().orphan_amount, U128(AMOUNT));
    ctx(owner(), T0 + SEC);
    c.assign_orphan(id, U128(AMOUNT));
    let cfg = c.get_config();
    assert_eq!(cfg.orphan_amount, U128(0));
    assert_eq!(cfg.total_liabilities, U128(AMOUNT));
    assert_eq!(state(&c, id), DealState::Funded);
}

/// Disputed deal with an absent arbiter: after the dispute period anyone
/// triggers the default 50/50 split.
#[test]
fn poc_dispute_has_no_timeout_fixed() {
    let mut c = setup();
    let id = disputed_deal(&mut c);
    ctx(acc("anyone.near"), T0 + 30 * SEC + DISPUTE + 1);
    c.resolve_dispute_timeout(id);
    let d = c.get_deal(id).unwrap();
    assert_eq!(d.state, DealState::Released);
    assert_eq!(d.creator_payout, U128(AMOUNT / 2));
    assert_eq!(d.client_payout, U128(AMOUNT / 2));
}

/// Deliver after the delivery deadline is rejected.
#[test]
#[should_panic(expected = "delivery deadline has passed")]
fn poc_deliver_after_deadline_allowed_fixed() {
    let mut c = setup();
    let id = funded_deal(&mut c);
    act(&mut c, &creator_key(), id, "deliver", r#"{"deliverable_hash":"late"}"#, DEADLINE + 3600 * SEC);
}

/// Non-canonical (unpadded) base64 stays rejected on-chain; the server now
/// rejects it before relaying (server test `rejects non-canonical base64`).
#[test]
#[should_panic(expected = "standard base64")]
fn poc_unpadded_signature_rejected_on_chain() {
    let mut c = setup();
    let id = funded_deal(&mut c);
    let payload = r#"{"deliverable_hash":"h"}"#;
    let sig = sign(&creator_key(), id, "deliver", payload);
    let unpadded = sig.trim_end_matches('=').to_string();
    ctx(relayer(), T0 + 2 * SEC);
    c.act(id, "deliver".into(), payload.into(), unpadded);
}

// ================================================================ attacks found in internal review, inverted (they must fail)

fn owner_ctx(now: u64) {
    ctx_full(owner(), now, Gas::from_tgas(300), NearToken::from_yoctonear(1));
}

/// Solvency invariant: what the escrow owes (liabilities) plus recorded
/// orphans never exceeds the tokens it really holds.
fn assert_solvent(c: &Contract, real_balance: u128, step: &str) {
    let cfg = c.get_config();
    assert!(
        cfg.total_liabilities.0 + cfg.orphan_amount.0 <= real_balance,
        "{step}: liabilities {} + orphans {} > balance {real_balance}",
        cfg.total_liabilities.0,
        cfg.orphan_amount.0
    );
}

/// An in-flight sweep can no longer be combined with assign_orphan.
#[test]
fn poc2_sweep_plus_assign_double_spends_orphans_fixed() {
    let mut c = setup();
    let _a = released_deal(&mut c);
    let b = new_deal(&mut c);
    act(&mut c, &creator_key(), b, "cancel", "{}", T0 + 2 * SEC);
    ctx(token(), T0 + 3 * SEC);
    c.ft_on_transfer(acc("intents.near"), U128(100), "garbage".into());
    let mut real_balance: u128 = AMOUNT + 100;
    assert_solvent(&c, real_balance, "start");

    owner_yocto(T0 + 4 * SEC);
    let _ = c.sweep_orphans(acc("owner-wallet.near"), U128(100));
    assert_eq!(c.get_config().orphan_amount, U128(0), "orphans reserved by the sweep");
    // assigning the same orphans while the sweep is in flight is refused
    owner_ctx(T0 + 5 * SEC);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.assign_orphan(b, U128(100))));
    assert!(r.is_err(), "assign_orphan must be blocked during a sweep");
    real_balance -= 100; // the sweep transfer executed
    assert_solvent(&c, real_balance, "sweep transferred");
    ctx_callback(T0 + 6 * SEC, PromiseResult::Successful(vec![]));
    assert!(c.on_sweep_done(acc("owner-wallet.near"), U128(100), U128(100)));
    assert_solvent(&c, real_balance, "sweep done");
    assert_eq!(c.get_config().total_liabilities, U128(AMOUNT));
    assert_eq!(payout_of(&c, b, Party::Client), 0);
    // nothing left to assign afterwards
    owner_ctx(T0 + 7 * SEC);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.assign_orphan(b, U128(1))));
    assert!(r.is_err());
}

/// A failed sweep gives the reserved orphans back.
#[test]
fn sweep_failure_restores_orphans() {
    let mut c = setup();
    ctx(token(), T0);
    c.ft_on_transfer(acc("intents.near"), U128(100), "".into());
    owner_yocto(T0 + SEC);
    let _ = c.sweep_orphans(owner(), U128(60));
    assert_eq!(c.get_config().orphan_amount, U128(40));
    assert_eq!(c.get_config().sweep_reserved, U128(60));
    ctx_callback(T0 + 2 * SEC, PromiseResult::Failed);
    assert!(!c.on_sweep_done(owner(), U128(60), U128(60)));
    assert_eq!(c.get_config().orphan_amount, U128(100));
    assert_eq!(c.get_config().sweep_reserved, U128(0));
}

/// Solvency across funding, orphans, plain transfers, sweep, assign,
/// withdraw success/failure and late funds.
#[test]
fn solvency_invariant_across_operations() {
    let mut c = setup();
    let mut bal: u128 = 0;
    let a = new_deal(&mut c);
    fund(&mut c, a, AMOUNT);
    bal += AMOUNT;
    assert_solvent(&c, bal, "fund a");
    ctx(token(), T0 + 2 * SEC);
    c.ft_on_transfer(acc("intents.near"), U128(500), "bad".into());
    bal += 500;
    bal += 70; // a plain ft_transfer (no callback) arrives
    assert_solvent(&c, bal, "orphan + plain");
    let b = new_deal(&mut c);
    owner_ctx(T0 + 3 * SEC);
    c.assign_orphan(b, U128(200));
    assert_solvent(&c, bal, "assign");
    // sweep everything unaccounted: 300 orphans + 70 plain
    owner_yocto(T0 + 4 * SEC);
    let _ = c.sweep_orphans(owner(), U128(300));
    let r = sweep_two_step(&mut c, owner(), 71, bal, T0 + 5 * SEC);
    assert!(matches!(r, PromiseOrValue::Value(false)), "cannot sweep more than unaccounted");
    let r = sweep_two_step(&mut c, owner(), 70, bal, T0 + 5 * SEC + 2 * SEC_HOUR);
    assert!(matches!(r, PromiseOrValue::Promise(_)));
    bal -= 370;
    assert_solvent(&c, bal, "sweep in flight");
    c.on_sweep_done(owner(), U128(300), U128(300));
    c.on_sweep_done(owner(), U128(70), U128(0));
    assert_solvent(&c, bal, "sweep done");
    // deal a: deliver, accept, withdraw fails then succeeds; late funds
    act(&mut c, &creator_key(), a, "deliver", r#"{"deliverable_hash":"h"}"#, T0 + 10 * SEC);
    act(&mut c, &client_key(), a, "accept", "{}", T0 + 20 * SEC);
    let (p, amt) = start_withdraw(&mut c, &creator_key(), a);
    finish_withdraw(&mut c, a, p, amt, false);
    assert_solvent(&c, bal, "withdraw failed");
    let payload = format!(r#"{{"destination":"{DEST}","amount":"{AMOUNT}","expires_at_ns":"{}"}}"#, W_EXPIRES + 5);
    act(&mut c, &creator_key(), a, "withdraw", &payload, W_NOW + 3 * SEC);
    bal -= AMOUNT; // transfer executed, callback not yet run:
    // liabilities still include the pending amount until the callback
    assert_solvent(&c, bal + c.get_deal(a).unwrap().creator_pending.0, "withdraw in flight");
    finish_withdraw(&mut c, a, Party::Creator, AMOUNT, true);
    assert_solvent(&c, bal, "withdraw done");
    fund(&mut c, a, 9);
    bal += 9;
    assert_solvent(&c, bal, "late funds");
    let cfg = c.get_config();
    assert_eq!(cfg.total_liabilities.0 + cfg.orphan_amount.0, bal, "everything is accounted for");
}

/// A late callback after reconcile can not touch the next withdraw.
#[test]
fn poc2_reconcile_then_late_callback_double_pays_fixed() {
    let mut c = setup();
    let id = released_deal(&mut c);
    let (party, amount) = start_withdraw(&mut c, &creator_key(), id);
    let wid1 = pending_id(&c, id, party);
    owner_ctx(W_NOW + RECONCILE_DELAY_NS + 3600 * SEC);
    c.reconcile_pending(id, party, false, "FtRcpt111".into());
    let p2 = format!(r#"{{"destination":"{DEST}","amount":"{AMOUNT}","expires_at_ns":"{}"}}"#, W_NOW + RECONCILE_DELAY_NS + 7200 * SEC);
    act(&mut c, &creator_key(), id, "withdraw", &p2, W_NOW + RECONCILE_DELAY_NS + 3600 * SEC + SEC);
    let wid2 = pending_id(&c, id, party);
    assert_ne!(wid1, wid2);
    // late callback of #1 (failed) is ignored
    finish_withdraw_id(&mut c, id, party, amount, false, wid1, W_NOW + RECONCILE_DELAY_NS + 3600 * SEC + 2 * SEC);
    assert_eq!(c.get_deal(id).unwrap().creator_pending, U128(AMOUNT));
    // callback of #2 (succeeded) is applied
    finish_withdraw_id(&mut c, id, party, AMOUNT, true, wid2, W_NOW + RECONCILE_DELAY_NS + 3600 * SEC + 3 * SEC);
    let d = c.get_deal(id).unwrap();
    assert_eq!(d.creator_payout, U128(0));
    assert_eq!(d.creator_withdrawn, U128(AMOUNT));
    assert_eq!(d.state, DealState::PaidOut);
}

/// Join squatting: the first join still wins on-chain (the offer does not
/// bind the client), but the window is bounded by the offer expiry and the
/// squat is detectable by the client-key fingerprint.
#[test]
fn poc2_offer_first_join_wins_detectable() {
    let mut c = setup();
    let offer = offer_with(&creator_key(), AMOUNT, DURATION, REVIEW, "nonce-squat-000001");
    let sig = sign_offer(&creator_key(), &offer);
    ctx_dep(relayer(), T0, DEAL_DEPOSIT);
    let id = c.create_deal(offer.clone(), sig.clone(), pk_str(&stranger_key()));
    assert_eq!(c.get_deal_id_by_offer(offer.clone()), Some(id));
    let d = c.get_deal(id).unwrap();
    assert_ne!(d.client_fingerprint, fingerprint(&client_key().verifying_key().to_bytes()));
    assert_eq!(d.client_fingerprint, fingerprint(&stranger_key().verifying_key().to_bytes()));
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.create_deal(offer, sig, pk_str(&client_key()));
    }));
    assert!(r.is_err(), "offer already used");
}

#[test]
#[should_panic(expected = "offer expired")]
fn create_deal_rejects_expired_offer() {
    let mut c = setup();
    let offer = offer_full(&creator_key(), AMOUNT, DURATION, REVIEW, "nonce-0000000000000001", T0 + 10 * SEC, FEE0);
    let sig = sign_offer(&creator_key(), &offer);
    ctx_dep(relayer(), T0 + 11 * SEC, DEAL_DEPOSIT);
    c.create_deal(offer, sig, pk_str(&client_key()));
}

#[test]
#[should_panic(expected = "offer_expires_at_ns too far in the future")]
fn create_deal_rejects_offer_ttl_over_max() {
    let mut c = setup();
    let offer =
        offer_full(&creator_key(), AMOUNT, DURATION, REVIEW, "nonce-0000000000000001", T0 + DEFAULT_MAX_OFFER_TTL_NS + 1, FEE0);
    let sig = sign_offer(&creator_key(), &offer);
    ctx_dep(relayer(), T0, DEAL_DEPOSIT);
    c.create_deal(offer, sig, pk_str(&client_key()));
}

#[test]
fn fingerprint_format() {
    let f = fingerprint(&[7u8; 32]);
    assert_eq!(f.len(), 14);
    assert_eq!(f.matches('-').count(), 2);
    assert!(f.chars().all(|ch| ch == '-' || ch.is_ascii_hexdigit()));
}

#[test]
fn poc2_offer_sig_is_not_an_action_sig() {
    let mut c = setup();
    let id = funded_deal(&mut c);
    let offer = offer_with(&creator_key(), AMOUNT, DURATION, REVIEW, "nonce-x-0000000001");
    let sig = sign_offer(&creator_key(), &offer);
    ctx(relayer(), T0 + 2 * SEC);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.act(id, "refund".into(), offer, sig);
    }));
    assert!(r.is_err());
    assert_eq!(state(&c, id), DealState::Funded);
}

#[test]
fn poc2_withdraw_amount_exact_with_late_funds() {
    let mut c = setup();
    let id = new_deal(&mut c);
    fund(&mut c, id, AMOUNT);
    act(&mut c, &creator_key(), id, "refund", "{}", T0 + 3 * SEC);
    fund(&mut c, id, 7);
    act(&mut c, &client_key(), id, "withdraw", &withdraw_payload(AMOUNT), W_NOW);
    let d = c.get_deal(id).unwrap();
    assert_eq!(d.client_pending, U128(AMOUNT));
    assert_eq!(d.client_payout, U128(7));
}

#[test]
#[should_panic(expected = "signature already used")]
fn poc2_failed_withdraw_not_rearmed() {
    let mut c = setup();
    let id = released_deal(&mut c);
    let (party, amount) = start_withdraw(&mut c, &creator_key(), id);
    finish_withdraw(&mut c, id, party, amount, false);
    assert!(c.is_withdraw_used(id, withdraw_payload(amount), pk_str(&creator_key())));
    ctx_dep(acc("mallory.near"), W_NOW + 10 * SEC, WITHDRAW_DEPOSIT);
    let sig = sign(&creator_key(), id, "withdraw", &withdraw_payload(amount));
    c.act(id, "withdraw".into(), withdraw_payload(amount), sig);
}

#[test]
#[should_panic(expected = "signature expired")]
fn poc2_withdraw_expired() {
    let mut c = setup();
    let id = released_deal(&mut c);
    act(&mut c, &creator_key(), id, "withdraw", &withdraw_payload(AMOUNT), W_EXPIRES + 1);
}

/// The old race is gone: after the dispute period only the
/// default split applies; the arbiter is refused.
#[test]
fn poc2_arbiter_and_timeout_race_after_end() {
    let mut c = setup();
    let id = disputed_deal(&mut c);
    let ends = c.get_deal(id).unwrap().dispute_ends_at_ns.unwrap().0;
    ctx(arbiter(), ends + SEC);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.resolve_dispute(id, 10_000)));
    assert!(r.is_err(), "the arbiter is late");
    ctx(acc("anyone.near"), ends + 2 * SEC);
    c.resolve_dispute_timeout(id);
    assert_eq!(payout_of(&c, id, Party::Creator), AMOUNT / 2);

    let id2 = disputed_deal(&mut c);
    let ends2 = c.get_deal(id2).unwrap().dispute_ends_at_ns.unwrap().0;
    ctx(acc("anyone.near"), ends2 + SEC);
    c.resolve_dispute_timeout(id2);
    ctx(arbiter(), ends2 + 2 * SEC);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.resolve_dispute(id2, 0)));
    assert!(r.is_err());
}

#[test]
fn views_for_relayer_prechecks() {
    let mut c = setup();
    let offer = offer_with(&creator_key(), AMOUNT, DURATION, REVIEW, "nonce-view-00000001");
    assert_eq!(c.get_deal_id_by_offer(offer.clone()), None);
    assert!(!c.is_offer_used(offer.clone()));
    let sig = sign_offer(&creator_key(), &offer);
    ctx_dep(relayer(), T0, DEAL_DEPOSIT);
    let id = c.create_deal(offer.clone(), sig, pk_str(&client_key()));
    assert_eq!(c.get_deal_id_by_offer(offer.clone()), Some(id));
    assert!(c.is_offer_used(offer));
    assert!(!c.is_withdraw_used(id, withdraw_payload(1), pk_str(&creator_key())));
}

// ================================================================ round 3 (documentation PoCs)

fn liab(c: &Contract) -> u128 {
    c.get_config().total_liabilities.0
}
fn orphans(c: &Contract) -> u128 {
    c.get_config().orphan_amount.0
}
const R_AFTER: u64 = W_NOW + RECONCILE_DELAY_NS + 3600 * SEC;

#[test]
#[should_panic(expected = "a sweep is in flight")]
fn poc3_sweep_then_assign_refused() {
    let mut c = setup();
    let _a = released_deal(&mut c);
    let b = new_deal(&mut c);
    act(&mut c, &creator_key(), b, "cancel", "{}", T0 + 2 * SEC);
    ctx(token(), T0 + 3 * SEC);
    c.ft_on_transfer(acc("intents.near"), U128(200), "garbage".into());
    owner_yocto(T0 + 4 * SEC);
    let _ = c.sweep_orphans(acc("owner-wallet.near"), U128(100));
    owner_ctx(T0 + 5 * SEC);
    c.assign_orphan(b, U128(100));
}

/// Assign in the window before the sweep's balance callback: the ledger
/// changed during the read, so the sweep is refused and the escrow stays
/// solvent.
#[test]
fn poc3_assign_in_window_before_sweep_callback_stays_solvent() {
    let mut c = setup();
    let _a = released_deal(&mut c);
    let b = new_deal(&mut c);
    act(&mut c, &creator_key(), b, "cancel", "{}", T0 + 2 * SEC);
    ctx(token(), T0 + 3 * SEC);
    c.ft_on_transfer(acc("intents.near"), U128(100), "garbage".into());
    let balance = AMOUNT + 100 + 30;
    let s = seq(&c); // sweep_unaccounted starts its read here
    owner_ctx(T0 + 4 * SEC);
    c.assign_orphan(b, U128(100));
    ctx_callback(T0 + 5 * SEC, PromiseResult::Successful(vec![]));
    let r = c.on_sweep_balance(acc("owner-wallet.near"), U128(130), s, Ok(U128(balance)));
    assert!(matches!(r, PromiseOrValue::Value(false)));
    assert!(liab(&c) + orphans(&c) <= balance);
}

#[test]
fn poc3_same_callback_twice_applied_once() {
    let mut c = setup();
    let id = released_deal(&mut c);
    let (party, amount) = start_withdraw(&mut c, &creator_key(), id);
    let wid = pending_id(&c, id, party);
    finish_withdraw_id(&mut c, id, party, amount, false, wid, W_NOW + SEC);
    finish_withdraw_id(&mut c, id, party, amount, false, wid, W_NOW + 2 * SEC);
    assert_eq!(c.get_deal(id).unwrap().creator_payout, U128(AMOUNT));
}

/// Documented owner-trust risk: a reconcile that misreports
/// "not transferred" before the old receipt runs double-pays; the stale
/// success is logged together with the owner's receipt id claim.
#[test]
fn poc3_reconcile_false_then_stale_success_is_logged() {
    let mut c = setup();
    let id = released_deal(&mut c);
    let (party, amount) = start_withdraw(&mut c, &creator_key(), id);
    let old = pending_id(&c, id, party);
    owner_ctx(R_AFTER);
    c.reconcile_pending(id, party, false, "FtRcptXYZ".into());
    assert!(get_logs().iter().any(|l| l.contains("pending_reconciled") && l.contains("FtRcptXYZ")));
    finish_withdraw_id(&mut c, id, party, amount, true, old, R_AFTER + SEC);
    assert_eq!(c.get_deal(id).unwrap().creator_payout, U128(AMOUNT));
    assert!(get_logs().iter().any(|l| l.contains("withdraw_stale_callback") && l.contains("\"transfer_succeeded\":true")));
}

/// Documented owner-trust risk: reconcile(true) on a failed transfer makes
/// the party's money "unaccounted" and therefore sweepable by the owner.
#[test]
fn poc3_reconcile_true_on_failed_transfer_makes_funds_sweepable() {
    let mut c = setup();
    let id = released_deal(&mut c);
    let (party, amount) = start_withdraw(&mut c, &creator_key(), id);
    let old = pending_id(&c, id, party);
    owner_ctx(R_AFTER);
    c.reconcile_pending(id, party, true, "FtRcptXYZ".into());
    finish_withdraw_id(&mut c, id, party, amount, false, old, R_AFTER + SEC);
    assert_eq!(liab(&c), 0);
    let r = sweep_two_step(&mut c, acc("owner-wallet.near"), AMOUNT, AMOUNT, R_AFTER + 3 * SEC);
    assert!(matches!(r, PromiseOrValue::Promise(_)));
}

#[test]
#[should_panic(expected = "too early to reconcile")]
fn reconcile_requires_24h() {
    let mut c = setup();
    let id = released_deal(&mut c);
    start_withdraw(&mut c, &creator_key(), id);
    owner_ctx(W_NOW + 23 * 3600 * SEC);
    c.reconcile_pending(id, Party::Creator, false, "FtRcpt".into());
}

#[test]
#[should_panic(expected = "receipt_id")]
fn reconcile_requires_receipt_id() {
    let mut c = setup();
    let id = released_deal(&mut c);
    start_withdraw(&mut c, &creator_key(), id);
    owner_ctx(R_AFTER);
    c.reconcile_pending(id, Party::Creator, false, String::new());
}

// ================================================================ v2 rules

fn settle_payload(bps: u16, state: &str, seq: u32, expires: u64) -> String {
    format!(r#"{{"split_bps":"{bps}","state":"{state}","seq":"{seq}","expires_at_ns":"{expires}","nonce":"n-0001"}}"#)
}

fn do_settle(c: &mut Contract, id: u64, payload: &str, now: u64) {
    ctx(acc("anyone.near"), now);
    let cs = sign(&creator_key(), id, "settle", payload);
    let ks = sign(&client_key(), id, "settle", payload);
    c.settle(id, payload.into(), cs, ks);
}

fn outcome(c: &Contract, id: u64) -> Option<Outcome> {
    c.get_deal(id).unwrap().outcome
}

#[test]
fn init_defaults_v2() {
    ctx(contract_id(), T0);
    let c = Contract::new(owner(), token(), arbiter(), relayer(), fee_acc(), None);
    let cfg = c.get_config();
    assert_eq!(cfg.min_review_period_ns, U64(3 * 24 * 3600 * SEC));
    assert_eq!(cfg.pay_by_period_ns, U64(PAY_BY));
    assert_eq!(cfg.funding_grace_ns, U64(GRACE));
    assert_eq!(cfg.fee_account_id, fee_acc());
    assert_eq!(cfg.max_fee_bps, 300);
}

#[test]
fn weak_keys_are_refused() {
    let mut identity = [0u8; 32];
    identity[0] = 1;
    assert!(is_weak_key(&identity));
    let mut p_minus_1 = [0xffu8; 32];
    p_minus_1[0] = 0xec;
    p_minus_1[31] = 0x7f;
    assert!(is_weak_key(&p_minus_1));
    let mut order8 = SMALL_ORDER[3];
    order8[31] |= 0x80; // sign bit set: still small order
    assert!(is_weak_key(&order8));
    assert!(!is_weak_key(&client_key().verifying_key().to_bytes()));
    let r = std::panic::catch_unwind(|| parse_pk(&pk_to_string(&identity)));
    assert!(r.is_err());
}

#[test]
#[should_panic(expected = "weak")]
fn create_deal_rejects_weak_client_key() {
    let mut c = setup();
    let offer = offer_with(&creator_key(), AMOUNT, DURATION, REVIEW, "nonce-0000000000000001");
    let sig = sign_offer(&creator_key(), &offer);
    let mut identity = [0u8; 32];
    identity[0] = 1;
    ctx_dep(relayer(), T0, DEAL_DEPOSIT);
    c.create_deal(offer, sig, pk_to_string(&identity));
}

#[test]
fn strict_decimal_parsing() {
    assert!(is_canonical_decimal("0"));
    assert!(is_canonical_decimal("5000000"));
    for bad in ["", "+5", "05", "-1", "5 ", "1e3", "0x10"] {
        assert!(!is_canonical_decimal(bad), "{bad}");
    }
}

#[test]
#[should_panic(expected = "amount: must be a canonical decimal string")]
fn create_deal_rejects_plus_sign_amount() {
    let mut c = setup();
    let offer = offer_with(&creator_key(), AMOUNT, DURATION, REVIEW, "nonce-0000000000000001")
        .replace(&format!("\"amount\":\"{AMOUNT}\""), "\"amount\":\"+5000000\"");
    let sig = sign_offer(&creator_key(), &offer);
    ctx_dep(relayer(), T0, DEAL_DEPOSIT);
    c.create_deal(offer, sig, pk_str(&client_key()));
}

#[test]
#[should_panic(expected = "fee_bps above the maximum")]
fn create_deal_rejects_fee_over_3_percent() {
    let mut c = setup();
    let offer = offer_fee(&creator_key(), AMOUNT, 301, "nonce-0000000000000001");
    let sig = sign_offer(&creator_key(), &offer);
    ctx_dep(relayer(), T0, DEAL_DEPOSIT);
    c.create_deal(offer, sig, pk_str(&client_key()));
}

#[test]
#[should_panic(expected = "delivery_duration_ns must be")]
fn create_deal_rejects_duration_over_90_days() {
    let mut c = setup();
    let offer = offer_with(&creator_key(), AMOUNT, MAX_DELIVERY_DURATION_NS + 1, REVIEW, "nonce-0000000000000001");
    let sig = sign_offer(&creator_key(), &offer);
    ctx_dep(relayer(), T0, DEAL_DEPOSIT);
    c.create_deal(offer, sig, pk_str(&client_key()));
}

#[test]
#[should_panic(expected = "review_period_ns outside the allowed range")]
fn create_deal_rejects_review_over_90_days() {
    let mut c = setup();
    let offer = offer_with(&creator_key(), AMOUNT, DURATION, MAX_REVIEW_PERIOD_NS + 1, "nonce-0000000000000001");
    let sig = sign_offer(&creator_key(), &offer);
    ctx_dep(relayer(), T0, DEAL_DEPOSIT);
    c.create_deal(offer, sig, pk_str(&client_key()));
}

#[test]
fn delivery_deadline_starts_at_funding() {
    let mut c = setup();
    let id = new_deal(&mut c);
    assert!(c.get_deal(id).unwrap().delivery_deadline_ns.is_none());
    let later = T0 + 3 * 24 * 3600 * SEC;
    fund_at(&mut c, id, AMOUNT, later);
    let d = c.get_deal(id).unwrap();
    assert_eq!(d.funded_at_ns, Some(U64(later)));
    assert_eq!(d.delivery_deadline_ns, Some(U64(later + DURATION)));
    act(&mut c, &creator_key(), id, "deliver", r#"{"deliverable_hash":"h"}"#, later + DURATION);
    assert_eq!(state(&c, id), DealState::Delivered);
}

#[test]
fn excess_of_funding_payment_goes_to_client_at_once() {
    let mut c = setup();
    let id = new_deal(&mut c);
    fund(&mut c, id, AMOUNT + 1_000);
    let d = c.get_deal(id).unwrap();
    assert_eq!(d.state, DealState::Funded);
    assert_eq!(d.funded_amount, U128(AMOUNT));
    assert_eq!(d.client_payout, U128(1_000));
}

/// The client withdraws extra money while the deal is Funded;
/// the deal stays live and the deal money is not locked.
#[test]
fn client_withdraw_mid_deal_keeps_deal_live() {
    let mut c = setup();
    let id = funded_deal(&mut c);
    fund(&mut c, id, 7); // dust / second payment
    let (party, amount) = start_withdraw(&mut c, &client_key(), id);
    assert_eq!((party, amount), (Party::Client, 7));
    assert!(finish_withdraw(&mut c, id, party, amount, true));
    let d = c.get_deal(id).unwrap();
    assert_eq!(d.state, DealState::Funded);
    assert!(d.settled);
    act(&mut c, &creator_key(), id, "deliver", r#"{"deliverable_hash":"h"}"#, T0 + 100 * SEC);
    act(&mut c, &client_key(), id, "accept", "{}", T0 + 110 * SEC);
    assert_eq!(c.get_deal(id).unwrap().creator_payout, U128(AMOUNT));
}

#[test]
fn payment_in_grace_window_still_funds() {
    let mut c = setup();
    let id = new_deal(&mut c);
    fund_at(&mut c, id, AMOUNT, T0 + PAY_BY + GRACE);
    assert_eq!(state(&c, id), DealState::Funded);
}

#[test]
fn payment_after_cutoff_goes_to_client_and_deal_closes_unpaid() {
    let mut c = setup();
    let id = new_deal(&mut c);
    let late = T0 + PAY_BY + GRACE + 1;
    fund_at(&mut c, id, AMOUNT, late);
    let d = c.get_deal(id).unwrap();
    assert_eq!(d.state, DealState::Created);
    assert_eq!(d.client_payout, U128(AMOUNT));
    ctx(acc("anyone.near"), late);
    c.close_unpaid(id);
    let d = c.get_deal(id).unwrap();
    assert_eq!(d.state, DealState::Expired);
    assert_eq!(d.outcome, Some(Outcome::ClosedUnpaid));
    assert_eq!(d.ended_at_ns, Some(U64(late)));
    let (party, amount) = start_withdraw(&mut c, &client_key(), id);
    assert!(finish_withdraw(&mut c, id, party, amount, true));
    assert_eq!(state(&c, id), DealState::PaidOut);
}

#[test]
#[should_panic(expected = "the funding window is not over yet")]
fn close_unpaid_too_early_rejected() {
    let mut c = setup();
    let id = new_deal(&mut c);
    ctx(acc("anyone.near"), T0 + PAY_BY + GRACE);
    c.close_unpaid(id);
}

#[test]
#[should_panic(expected = "deal must be Created")]
fn close_unpaid_rejects_funded() {
    let mut c = setup();
    let id = funded_deal(&mut c);
    ctx(acc("anyone.near"), T0 + PAY_BY + GRACE + 1);
    c.close_unpaid(id);
}

#[test]
fn outcomes_are_recorded() {
    let mut c = setup();
    let a = released_deal(&mut c);
    assert_eq!(outcome(&c, a), Some(Outcome::Accepted));
    let b = delivered_deal(&mut c);
    ctx(acc("anyone.near"), DELIVERED_AT + REVIEW + 1);
    c.release_after_timeout(b);
    assert_eq!(outcome(&c, b), Some(Outcome::AutoReleased));
    let d = funded_deal(&mut c);
    act(&mut c, &creator_key(), d, "refund", "{}", T0 + 5 * SEC);
    assert_eq!(outcome(&c, d), Some(Outcome::RefundedByCreator));
    let e = funded_deal(&mut c);
    act(&mut c, &client_key(), e, "refund", "{}", DEADLINE + 1);
    assert_eq!(outcome(&c, e), Some(Outcome::RefundedAfterDeadline));
    let f = new_deal(&mut c);
    act(&mut c, &creator_key(), f, "cancel", "{}", T0 + 5 * SEC);
    assert_eq!(outcome(&c, f), Some(Outcome::Cancelled));
    let g = disputed_deal(&mut c);
    ctx(arbiter(), T0 + 40 * SEC);
    c.resolve_dispute(g, 7_000);
    assert_eq!(outcome(&c, g), Some(Outcome::ArbiterSplit { creator_share_bps: 7_000 }));
    let h = disputed_deal(&mut c);
    ctx(acc("anyone.near"), T0 + 30 * SEC + DISPUTE + 1);
    c.resolve_dispute_timeout(h);
    assert_eq!(outcome(&c, h), Some(Outcome::TimeoutSplit { creator_share_bps: 5_000 }));
}

// ---------------------------------------------------------------- fee

#[test]
fn fee_taken_from_creator_on_accept_and_tracked() {
    let mut c = setup();
    let id = new_deal_fee(&mut c, 300);
    fund(&mut c, id, AMOUNT);
    act(&mut c, &creator_key(), id, "deliver", r#"{"deliverable_hash":"h"}"#, DELIVERED_AT);
    act(&mut c, &client_key(), id, "accept", "{}", T0 + 20 * SEC);
    let d = c.get_deal(id).unwrap();
    assert_eq!(d.fee_amount, U128(150_000));
    assert_eq!(d.creator_payout, U128(AMOUNT - 150_000));
    assert_eq!(d.client_payout, U128(0));
    let cfg = c.get_config();
    assert_eq!(cfg.fee_accrued, U128(150_000));
    assert_eq!(cfg.total_liabilities, U128(AMOUNT), "fees stay owed until withdrawn");
}

#[test]
fn fee_only_from_creator_share_in_split_and_none_on_refund() {
    let mut c = setup();
    let id = new_deal_fee(&mut c, 300);
    fund(&mut c, id, AMOUNT);
    act(&mut c, &creator_key(), id, "deliver", r#"{"deliverable_hash":"h"}"#, DELIVERED_AT);
    act(&mut c, &client_key(), id, "dispute", "{}", T0 + 30 * SEC);
    ctx(arbiter(), T0 + 40 * SEC);
    c.resolve_dispute(id, 5_000);
    let d = c.get_deal(id).unwrap();
    assert_eq!(d.fee_amount, U128(75_000));
    assert_eq!(d.creator_payout, U128(2_500_000 - 75_000));
    assert_eq!(d.client_payout, U128(2_500_000));

    let r = new_deal_fee(&mut c, 300);
    fund(&mut c, r, AMOUNT);
    act(&mut c, &creator_key(), r, "refund", "{}", T0 + 5 * SEC);
    let d = c.get_deal(r).unwrap();
    assert_eq!(d.fee_amount, U128(0));
    assert_eq!(d.client_payout, U128(AMOUNT));
}

#[test]
fn withdraw_fees_success_and_failure() {
    let mut c = setup();
    let id = new_deal_fee(&mut c, 300);
    fund(&mut c, id, AMOUNT);
    act(&mut c, &creator_key(), id, "deliver", r#"{"deliverable_hash":"h"}"#, DELIVERED_AT);
    act(&mut c, &client_key(), id, "accept", "{}", T0 + 20 * SEC);
    ctx_dep(fee_acc(), T0 + 30 * SEC, NearToken::from_yoctonear(1));
    c.withdraw_fees(U128(100_000));
    assert_eq!(c.get_config().fee_pending, U128(100_000));
    ctx_callback(T0 + 31 * SEC, PromiseResult::Failed);
    assert!(!c.on_fee_withdraw(U128(100_000), 1));
    assert_eq!(c.get_config().fee_accrued, U128(150_000));
    ctx_dep(fee_acc(), T0 + 32 * SEC, NearToken::from_yoctonear(1));
    c.withdraw_fees(U128(150_000));
    ctx_callback(T0 + 33 * SEC, PromiseResult::Successful(vec![]));
    assert!(c.on_fee_withdraw(U128(150_000), 2));
    let cfg = c.get_config();
    assert_eq!(cfg.fee_accrued, U128(0));
    assert_eq!(cfg.fee_pending, U128(0));
    assert_eq!(cfg.total_liabilities, U128(AMOUNT - 150_000));
}

#[test]
#[should_panic(expected = "only fee account")]
fn withdraw_fees_rejects_others() {
    let mut c = setup();
    ctx_dep(owner(), T0, NearToken::from_yoctonear(1));
    c.withdraw_fees(U128(1));
}

#[test]
#[should_panic(expected = "amount exceeds accrued fees")]
fn withdraw_fees_rejects_more_than_accrued() {
    let mut c = setup();
    ctx_dep(fee_acc(), T0, NearToken::from_yoctonear(1));
    c.withdraw_fees(U128(1));
}

#[test]
fn fee_account_change_is_delayed() {
    let mut c = setup();
    ctx(owner(), T0);
    c.set_fee_account(acc("fees2.near"));
    assert_eq!(c.get_config().fee_account_id, fee_acc());
    ctx(acc("anyone.near"), T0 + DEFAULT_ADMIN_DELAY_NS);
    c.apply_admin_changes();
    assert_eq!(c.get_config().fee_account_id, fee_acc(), "not at exactly the delay");
    ctx(acc("anyone.near"), T0 + DEFAULT_ADMIN_DELAY_NS + 1);
    c.apply_admin_changes();
    assert_eq!(c.get_config().fee_account_id, acc("fees2.near"));
}

#[test]
fn owner_can_cancel_scheduled_changes() {
    let mut c = setup();
    ctx(owner(), T0);
    c.set_arbiter(acc("arbiter2.near"));
    c.cancel_admin_changes();
    ctx(acc("anyone.near"), T0 + DEFAULT_ADMIN_DELAY_NS);
    c.apply_admin_changes();
    assert_eq!(c.get_config().arbiter_id, arbiter());
}

#[test]
#[should_panic(expected = "only owner")]
fn set_fee_account_rejects_non_owner() {
    let mut c = setup();
    ctx(fee_acc(), T0);
    c.set_fee_account(acc("fees2.near"));
}

// ---------------------------------------------------------------- settle

#[test]
fn settle_after_delivery_by_both_keys() {
    let mut c = setup();
    let id = new_deal_fee(&mut c, 300);
    fund(&mut c, id, AMOUNT);
    act(&mut c, &creator_key(), id, "deliver", r#"{"deliverable_hash":"h"}"#, DELIVERED_AT);
    let p = settle_payload(9_000, "Delivered", 0, T0 + 3600 * SEC);
    do_settle(&mut c, id, &p, DELIVERED_AT + 5 * SEC);
    let d = c.get_deal(id).unwrap();
    assert_eq!(d.state, DealState::Released);
    assert_eq!(d.outcome, Some(Outcome::Settled { creator_share_bps: 9_000 }));
    assert_eq!(d.fee_amount, U128(135_000));
    assert_eq!(d.creator_payout, U128(4_500_000 - 135_000));
    assert_eq!(d.client_payout, U128(500_000));
}

#[test]
fn settle_before_delivery_full_refund() {
    let mut c = setup();
    let id = funded_deal(&mut c);
    let p = settle_payload(0, "Funded", 0, T0 + 3600 * SEC);
    do_settle(&mut c, id, &p, T0 + 5 * SEC);
    let d = c.get_deal(id).unwrap();
    assert_eq!(d.state, DealState::Refunded);
    assert_eq!(d.client_payout, U128(AMOUNT));
}

#[test]
fn settle_inside_dispute() {
    let mut c = setup();
    let id = disputed_deal(&mut c);
    let p = settle_payload(6_000, "Disputed", 0, T0 + 3600 * SEC);
    do_settle(&mut c, id, &p, T0 + 40 * SEC);
    assert_eq!(state(&c, id), DealState::Released);
    assert_eq!(c.get_deal(id).unwrap().client_payout, U128(2_000_000));
}

#[test]
#[should_panic(expected = "settle: deal state differs from the signed state")]
fn settle_signed_in_funded_not_usable_after_delivery() {
    let mut c = setup();
    let id = delivered_deal(&mut c);
    let p = settle_payload(0, "Funded", 0, T0 + 3600 * SEC);
    do_settle(&mut c, id, &p, DELIVERED_AT + 5 * SEC);
}

#[test]
#[should_panic(expected = "settle: invalid client signature")]
fn settle_needs_both_signatures() {
    let mut c = setup();
    let id = delivered_deal(&mut c);
    let p = settle_payload(10_000, "Delivered", 0, T0 + 3600 * SEC);
    ctx(acc("anyone.near"), DELIVERED_AT + 5 * SEC);
    let cs = sign(&creator_key(), id, "settle", &p);
    c.settle(id, p, cs.clone(), cs);
}

#[test]
#[should_panic(expected = "settle: signature expired")]
fn settle_expired_rejected() {
    let mut c = setup();
    let id = delivered_deal(&mut c);
    let p = settle_payload(5_000, "Delivered", 0, DELIVERED_AT + 5 * SEC);
    do_settle(&mut c, id, &p, DELIVERED_AT + 6 * SEC);
}

/// A settle cannot land after the review end (timeout rules win).
#[test]
#[should_panic(expected = "settle: the deal timer is over")]
fn settle_after_review_end_rejected() {
    let mut c = setup();
    let id = delivered_deal(&mut c);
    let p = settle_payload(7_000, "Delivered", 0, T0 + 10 * 24 * 3600 * SEC);
    do_settle(&mut c, id, &p, DELIVERED_AT + REVIEW + 1);
}

#[test]
#[should_panic(expected = "settle: the deal timer is over")]
fn settle_after_delivery_deadline_rejected() {
    let mut c = setup();
    let id = funded_deal(&mut c);
    let p = settle_payload(10_000, "Funded", 0, T0 + 10 * 24 * 3600 * SEC);
    do_settle(&mut c, id, &p, DEADLINE + 1);
}

#[test]
#[should_panic(expected = "settle: revoked")]
fn revoke_settle_kills_old_proposals() {
    let mut c = setup();
    let id = delivered_deal(&mut c);
    let p = settle_payload(9_000, "Delivered", 0, T0 + 3600 * SEC);
    act(&mut c, &client_key(), id, "revoke_settle", r#"{"seq":"0"}"#, DELIVERED_AT + 2 * SEC);
    assert_eq!(c.get_deal(id).unwrap().settle_seq, 1);
    do_settle(&mut c, id, &p, DELIVERED_AT + 5 * SEC);
}

#[test]
#[should_panic(expected = "settle: deal must be Funded, Delivered or Disputed")]
fn settle_rejected_in_created() {
    let mut c = setup();
    let id = new_deal(&mut c);
    let p = settle_payload(0, "Created", 0, T0 + 3600 * SEC);
    do_settle(&mut c, id, &p, T0 + 5 * SEC);
}

#[test]
#[should_panic(expected = "split_bps must be <= 10000")]
fn settle_rejects_bps_over_max() {
    let mut c = setup();
    let id = delivered_deal(&mut c);
    let p = settle_payload(10_001, "Delivered", 0, T0 + 3600 * SEC);
    do_settle(&mut c, id, &p, DELIVERED_AT + 5 * SEC);
}

// ---------------------------------------------------------------- deposits

#[test]
#[should_panic(expected = "withdraw: attach 0.00225 NEAR for storage")]
fn withdraw_requires_storage_deposit_from_submitter() {
    let mut c = setup();
    let id = released_deal(&mut c);
    ctx(relayer(), W_NOW);
    let payload = withdraw_payload(AMOUNT);
    let sig = sign(&creator_key(), id, "withdraw", &payload);
    c.act(id, "withdraw".into(), payload, sig);
}

#[test]
#[should_panic(expected = "this action takes no deposit")]
fn other_actions_take_no_deposit() {
    let mut c = setup();
    let id = funded_deal(&mut c);
    ctx_dep(relayer(), T0 + 5 * SEC, NearToken::from_yoctonear(1));
    let sig = sign(&creator_key(), id, "refund", "{}");
    c.act(id, "refund".into(), "{}".into(), sig);
}

#[test]
#[should_panic(expected = "withdraw: amount: must be a canonical decimal string")]
fn withdraw_rejects_plus_sign_amount() {
    let mut c = setup();
    let id = released_deal(&mut c);
    let payload = format!(r#"{{"destination":"{DEST}","amount":"+{AMOUNT}","expires_at_ns":"{W_EXPIRES}"}}"#);
    act(&mut c, &creator_key(), id, "withdraw", &payload, W_NOW);
}

// ---------------------------------------------------------------- revoke offer

fn sign_revoke(key: &SigningKey, offer: &str) -> String {
    b64(&key.sign(revoke_offer_message(contract_id().as_str(), offer).as_bytes()).to_bytes())
}

#[test]
#[should_panic(expected = "offer already used or revoked")]
fn revoked_offer_cannot_be_joined() {
    let mut c = setup();
    let offer = offer_with(&creator_key(), AMOUNT, DURATION, REVIEW, "nonce-0000000000000001");
    ctx_dep(acc("anyone.near"), T0, REVOKE_DEPOSIT);
    c.revoke_offer(offer.clone(), sign_revoke(&creator_key(), &offer));
    assert!(c.is_offer_revoked(offer.clone()));
    assert!(c.get_deal_id_by_offer(offer.clone()).is_none());
    let sig = sign_offer(&creator_key(), &offer);
    ctx_dep(relayer(), T0 + SEC, DEAL_DEPOSIT);
    c.create_deal(offer, sig, pk_str(&client_key()));
}

#[test]
#[should_panic(expected = "revoke_offer: invalid creator signature")]
fn revoke_offer_needs_creator_signature() {
    let mut c = setup();
    let offer = offer_with(&creator_key(), AMOUNT, DURATION, REVIEW, "nonce-0000000000000001");
    ctx_dep(acc("anyone.near"), T0, REVOKE_DEPOSIT);
    c.revoke_offer(offer.clone(), sign_revoke(&stranger_key(), &offer));
}

#[test]
#[should_panic(expected = "offer already used or revoked")]
fn revoke_offer_after_join_rejected() {
    let mut c = setup();
    let offer = offer_with(&creator_key(), AMOUNT, DURATION, REVIEW, "nonce-0000000000000001");
    let sig = sign_offer(&creator_key(), &offer);
    ctx_dep(relayer(), T0, DEAL_DEPOSIT);
    c.create_deal(offer.clone(), sig, pk_str(&client_key()));
    ctx_dep(acc("anyone.near"), T0 + SEC, REVOKE_DEPOSIT);
    c.revoke_offer(offer.clone(), sign_revoke(&creator_key(), &offer));
}

#[test]
#[should_panic(expected = "attach 0.001 NEAR")]
fn revoke_offer_requires_deposit() {
    let mut c = setup();
    let offer = offer_with(&creator_key(), AMOUNT, DURATION, REVIEW, "nonce-0000000000000001");
    ctx(acc("anyone.near"), T0);
    c.revoke_offer(offer.clone(), sign_revoke(&creator_key(), &offer));
}

// ---------------------------------------------------------------- purge

fn expired_deal(c: &mut Contract) -> u64 {
    let id = new_deal(c);
    ctx(acc("anyone.near"), T0 + PAY_BY + GRACE + 1);
    c.close_unpaid(id);
    id
}

const PURGE_AT: u64 = T0 + PAY_BY + GRACE + 1 + DEFAULT_PURGE_AFTER_NS + 1;

/// Client-key withdraw from a purged deal at `now` (payload valid 1 h).
fn tomb_withdraw(c: &mut Contract, key: &SigningKey, id: u64, amount: u128, now: u64) -> PromiseOrValue<bool> {
    let payload = format!(r#"{{"destination":"{DEST}","amount":"{amount}","expires_at_ns":"{}"}}"#, now + 3600 * SEC);
    ctx_dep(relayer(), now, WITHDRAW_DEPOSIT);
    let sig = sign(key, id, "withdraw", &payload);
    c.act(id, "withdraw".into(), payload, sig)
}

#[test]
fn purge_never_funded_expired_deal_late_money_goes_to_tombstone() {
    let mut c = setup();
    let id = expired_deal(&mut c);
    ctx(acc("anyone.near"), PURGE_AT);
    c.purge(id);
    assert!(c.get_deal(id).is_none());
    assert!(c.is_purged(id));
    assert_eq!(c.get_config().deals_count, 1);
    let t = c.get_tombstone(id).unwrap();
    assert_eq!((t.state, t.outcome, t.client_payout), (DealState::Expired, Some(Outcome::ClosedUnpaid), U128(0)));
    // late money is kept in the tombstone; the deal is NOT brought back
    fund_at(&mut c, id, 4_000, PURGE_AT + SEC);
    assert!(c.get_deal(id).is_none(), "no revival");
    assert_eq!(c.get_tombstone(id).unwrap().client_payout, U128(4_000));
    assert_eq!(c.get_config().total_liabilities, U128(4_000));
    assert_eq!(c.get_config().orphan_amount, U128(0));
    // the client key withdraws it from the tombstone
    let tw = PURGE_AT + 2 * SEC;
    assert!(matches!(tomb_withdraw(&mut c, &client_key(), id, 4_000, tw), PromiseOrValue::Promise(_)));
    let t = c.get_tombstone(id).unwrap();
    assert_eq!((t.client_payout, t.client_pending), (U128(0), U128(4_000)));
    let wid = c.next_withdraw_id;
    ctx_callback(tw + SEC, PromiseResult::Successful(vec![]));
    assert!(c.on_withdraw(id, Party::Client, U128(4_000), acc(DEST), wid));
    let t = c.get_tombstone(id).unwrap();
    assert_eq!((t.client_pending, t.client_withdrawn), (U128(0), U128(4_000)));
    assert_eq!(c.get_config().total_liabilities, U128(0));
}

/// 1 unit of dust no longer blocks purge; it moves into the
/// tombstone and stays withdrawable.
#[test]
fn purge_moves_dust_into_tombstone() {
    let mut c = setup();
    let id = new_deal(&mut c);
    fund(&mut c, id, 1);
    ctx(acc("anyone.near"), T0 + PAY_BY + GRACE + 1);
    c.close_unpaid(id);
    ctx(acc("anyone.near"), PURGE_AT);
    c.purge(id);
    let t = c.get_tombstone(id).unwrap();
    assert_eq!(t.client_payout, U128(1));
    assert_eq!(c.get_config().total_liabilities, U128(1));
}

/// A failed tombstone withdraw restores the payout exactly once.
#[test]
fn tombstone_withdraw_failure_restores_payout() {
    let mut c = setup();
    let id = new_deal(&mut c);
    fund(&mut c, id, 700);
    ctx(acc("anyone.near"), T0 + PAY_BY + GRACE + 1);
    c.close_unpaid(id);
    ctx(acc("anyone.near"), PURGE_AT);
    c.purge(id);
    let tw = PURGE_AT + 2 * SEC;
    tomb_withdraw(&mut c, &client_key(), id, 700, tw);
    let wid = c.next_withdraw_id;
    ctx_callback(tw + SEC, PromiseResult::Failed);
    assert!(!c.on_withdraw(id, Party::Client, U128(700), acc(DEST), wid));
    ctx_callback(tw + 2 * SEC, PromiseResult::Failed);
    assert!(!c.on_withdraw(id, Party::Client, U128(700), acc(DEST), wid));
    let t = c.get_tombstone(id).unwrap();
    assert_eq!((t.client_payout, t.client_pending), (U128(700), U128(0)));
    assert_eq!(c.get_config().total_liabilities, U128(700));
}

#[test]
#[should_panic(expected = "invalid signature (client key required)")]
fn tombstone_withdraw_rejects_creator_key() {
    let mut c = setup();
    let id = new_deal(&mut c);
    fund(&mut c, id, 700);
    ctx(acc("anyone.near"), T0 + PAY_BY + GRACE + 1);
    c.close_unpaid(id);
    ctx(acc("anyone.near"), PURGE_AT);
    c.purge(id);
    tomb_withdraw(&mut c, &creator_key(), id, 700, PURGE_AT + 2 * SEC);
}

#[test]
#[should_panic(expected = "only the client's withdraw is possible")]
fn tombstone_rejects_other_actions() {
    let mut c = setup();
    let id = expired_deal(&mut c);
    ctx(acc("anyone.near"), PURGE_AT);
    c.purge(id);
    act(&mut c, &creator_key(), id, "cancel", "{}", PURGE_AT + SEC);
}

/// The owner can reconcile a stuck tombstone withdraw (same 24 h rule).
#[test]
fn tombstone_reconcile_pending() {
    let mut c = setup();
    let id = new_deal(&mut c);
    fund(&mut c, id, 700);
    ctx(acc("anyone.near"), T0 + PAY_BY + GRACE + 1);
    c.close_unpaid(id);
    ctx(acc("anyone.near"), PURGE_AT);
    c.purge(id);
    tomb_withdraw(&mut c, &client_key(), id, 700, PURGE_AT + 2 * SEC);
    owner_ctx(PURGE_AT + 2 * SEC + RECONCILE_DELAY_NS + SEC);
    c.reconcile_pending(id, Party::Client, true, "FtRcpt".into());
    let t = c.get_tombstone(id).unwrap();
    assert_eq!((t.client_pending, t.client_withdrawn), (U128(0), U128(700)));
    assert_eq!(c.get_config().total_liabilities, U128(0));
}

#[test]
#[should_panic(expected = "purge: too early")]
fn purge_too_early_rejected() {
    let mut c = setup();
    let id = expired_deal(&mut c);
    ctx(acc("anyone.near"), PURGE_AT - 2);
    c.purge(id);
}

#[test]
#[should_panic(expected = "purge: only never-funded deals")]
fn purge_funded_deal_rejected() {
    let mut c = setup();
    let id = released_deal(&mut c);
    ctx(acc("anyone.near"), PURGE_AT);
    c.purge(id);
}

#[test]
#[should_panic(expected = "purge: a withdrawal is in flight")]
fn purge_with_withdraw_in_flight_rejected() {
    let mut c = setup();
    let id = new_deal(&mut c);
    fund(&mut c, id, 10);
    let payload = withdraw_payload(10);
    ctx_dep(relayer(), W_NOW, WITHDRAW_DEPOSIT);
    let sig = sign(&client_key(), id, "withdraw", &payload);
    c.act(id, "withdraw".into(), payload, sig);
    ctx(acc("anyone.near"), T0 + PAY_BY + GRACE + 1);
    c.close_unpaid(id);
    ctx(acc("anyone.near"), PURGE_AT);
    c.purge(id);
}

#[test]
#[should_panic(expected = "purge: deal is not closed")]
fn purge_live_deal_rejected() {
    let mut c = setup();
    let id = new_deal(&mut c);
    ctx(acc("anyone.near"), PURGE_AT);
    c.purge(id);
}

#[test]
fn get_deals_skips_purged_ids() {
    let mut c = setup();
    let a = expired_deal(&mut c);
    let _b = new_deal(&mut c);
    ctx(acc("anyone.near"), PURGE_AT);
    c.purge(a);
    let page = c.get_deals(0, 10);
    assert_eq!(page.len(), 1);
    assert_eq!(page[0].id, 1);
}

/// Solvency with fees: balance - liabilities stays exactly the orphans.
#[test]
fn solvency_with_fees_and_mid_deal_withdraws() {
    let mut c = setup();
    let mut balance: u128 = 0;
    let id = new_deal_fee(&mut c, 300);
    fund(&mut c, id, AMOUNT + 50);
    balance += AMOUNT + 50;
    assert_eq!(c.get_config().total_liabilities, U128(balance));
    let (party, amount) = start_withdraw(&mut c, &client_key(), id);
    assert!(finish_withdraw(&mut c, id, party, amount, true));
    balance -= 50;
    act(&mut c, &creator_key(), id, "deliver", r#"{"deliverable_hash":"h"}"#, DELIVERED_AT);
    act(&mut c, &client_key(), id, "accept", "{}", T0 + 20 * SEC);
    let (party, amount) = start_withdraw(&mut c, &creator_key(), id);
    assert!(finish_withdraw(&mut c, id, party, amount, true));
    balance -= amount;
    let cfg = c.get_config();
    assert_eq!(cfg.total_liabilities, U128(balance));
    assert_eq!(cfg.fee_accrued, U128(balance));
    assert_eq!(state(&c, id), DealState::PaidOut);
}


// ================================================================ fixes from the internal review of contract v2

#[test]
#[should_panic(expected = "create_deal: attach 0.01 NEAR for the deal storage")]
fn create_deal_requires_storage_deposit() {
    let mut c = setup();
    let offer = offer_with(&creator_key(), AMOUNT, DURATION, REVIEW, &nonce(&c));
    let sig = sign_offer(&creator_key(), &offer);
    ctx_dep(relayer(), T0, NearToken::from_yoctonear(DEAL_DEPOSIT.as_yoctonear() - 1));
    c.create_deal(offer, sig, pk_str(&client_key()));
}

#[test]
#[should_panic(expected = "amount below the minimum (1 USDC)")]
fn create_deal_rejects_amount_below_one_usdc() {
    let mut c = setup();
    let offer = offer_with(&creator_key(), MIN_AMOUNT - 1, DURATION, REVIEW, &nonce(&c));
    let sig = sign_offer(&creator_key(), &offer);
    ctx_dep(relayer(), T0, DEAL_DEPOSIT);
    c.create_deal(offer, sig, pk_str(&client_key()));
}

#[test]
fn create_deal_accepts_exactly_one_usdc() {
    let mut c = setup();
    let offer = offer_with(&creator_key(), MIN_AMOUNT, DURATION, REVIEW, &nonce(&c));
    let sig = sign_offer(&creator_key(), &offer);
    ctx_dep(relayer(), T0, DEAL_DEPOSIT);
    let id = c.create_deal(offer, sig, pk_str(&client_key()));
    assert_eq!(c.get_deal(id).unwrap().amount, U128(MIN_AMOUNT));
    let cfg = c.get_config();
    assert_eq!((cfg.min_amount, cfg.deal_deposit), (U128(MIN_AMOUNT), U128(DEAL_DEPOSIT.as_yoctonear())));
}

/// A published revoke_settle signature works exactly once.
#[test]
fn revoke_settle_signature_cannot_be_replayed() {
    let mut c = setup();
    let id = delivered_deal(&mut c);
    let payload = r#"{"seq":"0"}"#;
    act(&mut c, &client_key(), id, "revoke_settle", payload, DELIVERED_AT + SEC);
    assert_eq!(c.get_deal(id).unwrap().settle_seq, 1);
    ctx(acc("stranger.near"), DELIVERED_AT + 2 * SEC);
    let sig = sign(&client_key(), id, "revoke_settle", payload);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.act(id, "revoke_settle".into(), payload.into(), sig)
    }));
    assert!(r.is_err(), "the replay must fail");
    // the parties' new settle at seq 1 still works
    let p = settle_payload(7_000, "Delivered", 1, T0 + 3600 * SEC);
    do_settle(&mut c, id, &p, DELIVERED_AT + 3 * SEC);
    assert_eq!(state(&c, id), DealState::Released);
}

#[test]
#[should_panic(expected = "revoke_settle: payload.seq (string) required")]
fn revoke_settle_requires_seq() {
    let mut c = setup();
    let id = delivered_deal(&mut c);
    act(&mut c, &client_key(), id, "revoke_settle", r#"{"nonce":"r1"}"#, DELIVERED_AT + SEC);
}

/// The arbiter cannot decide after the dispute period.
#[test]
#[should_panic(expected = "the dispute period is over")]
fn arbiter_cannot_decide_after_dispute_period() {
    let mut c = setup();
    let id = disputed_deal(&mut c);
    let ends = c.get_deal(id).unwrap().dispute_ends_at_ns.unwrap().0;
    ctx(arbiter(), ends + 1);
    c.resolve_dispute(id, 10_000);
}

#[test]
fn arbiter_can_decide_at_the_last_moment() {
    let mut c = setup();
    let id = disputed_deal(&mut c);
    let ends = c.get_deal(id).unwrap().dispute_ends_at_ns.unwrap().0;
    ctx(arbiter(), ends);
    c.resolve_dispute(id, 10_000);
    assert_eq!(state(&c, id), DealState::Released);
}

/// Inverted attack: a new arbiter scheduled after a dispute opened
/// can never decide that dispute.
#[test]
fn new_arbiter_cannot_decide_dispute_opened_before_change() {
    let mut c = setup();
    let id = disputed_deal(&mut c);
    owner_ctx(T0 + 31 * SEC);
    c.set_arbiter(acc("evil.near"));
    let effective = c.get_config().pending_arbiter.unwrap().effective_at_ns.0;
    ctx(acc("anyone.near"), effective + 1);
    c.apply_admin_changes();
    assert_eq!(c.get_config().arbiter_id, acc("evil.near"));
    ctx(acc("evil.near"), effective + 1);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.resolve_dispute(id, 10_000)));
    assert!(r.is_err(), "the dispute ended before the new arbiter came in");
}

#[test]
#[should_panic(expected = "admin_delay_ns must be >= dispute_period_ns")]
fn init_rejects_admin_delay_shorter_than_dispute() {
    ctx(contract_id(), T0);
    let p = Periods {
        dispute_period_ns: Some(U64(DISPUTE)),
        admin_delay_ns: Some(U64(DISPUTE - 1)),
        ..Default::default()
    };
    Contract::new(owner(), token(), arbiter(), relayer(), fee_acc(), Some(p));
}

/// A plain ft_transfer to intents.near would be lost.
#[test]
#[should_panic(expected = "withdraw: bad destination")]
fn withdraw_to_intents_contract_rejected() {
    let mut c = setup();
    let id = released_deal(&mut c);
    let payload = format!(r#"{{"destination":"intents.near","amount":"{AMOUNT}","expires_at_ns":"{W_EXPIRES}"}}"#);
    act(&mut c, &creator_key(), id, "withdraw", &payload, W_NOW);
}

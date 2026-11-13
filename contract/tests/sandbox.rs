//! Sandbox integration tests: real escrow wasm + mock NEP-141 token on a
//! local near-sandbox node.
//!
//! Run: `CARGO_TARGET_DIR=$HOME/target/escrow cargo test --test sandbox`

use std::sync::OnceLock;

use ed25519_dalek::{Signer as _, SigningKey};
use near_api::{AccountId, NearGas, NearToken, NetworkConfig, Signer};
use near_sdk::base64::Engine;
use near_sdk::serde_json::{json, Value};

type R<T = ()> = testresult::TestResult<T>;
type TxResult = near_api::types::transaction::result::TransactionResult;

const AMOUNT: u128 = 5_000_000; // 5 USDC (6 decimals)
const SEC: u64 = 1_000_000_000;
const DISPUTE_S: u64 = 5;
/// What the relayer attaches to create_deal (contract DEAL_DEPOSIT, 0.01 NEAR).
const DEAL_DEPOSIT: NearToken = NearToken::from_millinear(10);

fn wasms() -> &'static (Vec<u8>, Vec<u8>) {
    static W: OnceLock<(Vec<u8>, Vec<u8>)> = OnceLock::new();
    W.get_or_init(|| {
        let escrow = cargo_near_build::build_with_cli(Default::default()).expect("build escrow");
        let manifest = format!("{}/mock-ft/Cargo.toml", env!("CARGO_MANIFEST_DIR"));
        let opts = cargo_near_build::BuildOpts::builder()
            .manifest_path(cargo_near_build::camino::Utf8PathBuf::from(manifest))
            .no_abi(true)
            .build();
        let ft = cargo_near_build::build_with_cli(opts).expect("build mock-ft");
        (std::fs::read(escrow).unwrap(), std::fs::read(ft).unwrap())
    })
}

struct Env {
    sandbox: near_sandbox::Sandbox,
    net: NetworkConfig,
    signer: std::sync::Arc<Signer>,
    escrow: AccountId,
    ft: AccountId,
    owner: AccountId,
    relayer: AccountId,
    arbiter: AccountId,
    payer: AccountId,
    stranger: AccountId,
    creator: SigningKey,
    client: SigningKey,
    offers: std::cell::Cell<u32>,
    last_offer: std::cell::RefCell<String>,
}

async fn create(sandbox: &near_sandbox::Sandbox, name: &str) -> R<AccountId> {
    let id: AccountId = name.parse()?;
    sandbox.create_account(id.clone()).initial_balance(NearToken::from_near(20)).send().await?;
    Ok(id)
}

fn now_ns() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos() as u64
}

fn b64(bytes: &[u8]) -> String {
    near_sdk::base64::engine::general_purpose::STANDARD.encode(bytes)
}

impl Env {
    async fn new(seed: u8) -> R<Self> {
        let (escrow_wasm, ft_wasm) = wasms().clone();
        let sandbox = near_sandbox::Sandbox::start_sandbox().await?;
        let net = NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse()?);
        let signer = Signer::from_secret_key(near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY.parse().unwrap())?;
        let owner = create(&sandbox, "owner.sandbox").await?;
        let escrow = create(&sandbox, "escrow.sandbox").await?;
        let ft = create(&sandbox, "usdc.sandbox").await?;
        let relayer = create(&sandbox, "relayer.sandbox").await?;
        let arbiter = create(&sandbox, "arbiter.sandbox").await?;
        let payer = create(&sandbox, "intents.sandbox").await?;
        let stranger = create(&sandbox, "stranger.sandbox").await?;

        near_api::Contract::deploy(ft.clone())
            .use_code(ft_wasm)
            .with_init_call("new", json!({}))?
            .with_signer(signer.clone())
            .send_to(&net)
            .await?
            .assert_success();
        // deploy + init in one transaction signed by the escrow account (new is #[private])
        near_api::Contract::deploy(escrow.clone())
            .use_code(escrow_wasm)
            .with_init_call(
                "new",
                json!({
                    "owner_id": owner, "token_id": ft, "arbiter_id": arbiter, "relayer_id": relayer,
                    "fee_account_id": stranger,
                    "periods": {
                        "min_review_period_ns": (SEC).to_string(),
                        "dispute_period_ns": (DISPUTE_S * SEC).to_string(),
                        "sweep_confirm_delay_ns": SEC.to_string(),
                    },
                }),
            )?
            .with_signer(signer.clone())
            .send_to(&net)
            .await?
            .assert_success();

        let env = Self {
            sandbox,
            net,
            signer,
            escrow,
            ft,
            owner,
            relayer,
            arbiter,
            payer,
            stranger,
            creator: SigningKey::from_bytes(&[seed; 32]),
            client: SigningKey::from_bytes(&[seed.wrapping_add(100); 32]),
            offers: std::cell::Cell::new(0),
            last_offer: std::cell::RefCell::new(String::new()),
        };
        // The escrow must be registered with the token to receive ft_transfer_call.
        env.call(&env.owner, &env.ft, "storage_deposit", json!({ "account_id": env.escrow }), NearToken::from_millinear(10))
            .await?
            .assert_success();
        env.call(&env.owner, &env.ft, "mint", json!({ "account_id": env.payer, "amount": "1000000000" }), NearToken::from_yoctonear(0))
            .await?
            .assert_success();
        Ok(env)
    }

    async fn call(&self, from: &AccountId, contract: &AccountId, method: &str, args: Value, deposit: NearToken) -> R<TxResult> {
        Ok(near_api::Contract(contract.clone())
            .call_function(method, args)
            .transaction()
            .deposit(deposit)
            .gas(NearGas::from_tgas(250))
            .with_signer(from.clone(), self.signer.clone())
            .send_to(&self.net)
            .await?)
    }

    async fn view(&self, contract: &AccountId, method: &str, args: Value) -> R<Value> {
        let v: Value = near_api::Contract(contract.clone()).call_function(method, args).read_only().fetch_from(&self.net).await?.data;
        Ok(v)
    }

    async fn storage_usage(&self, account: &AccountId) -> R<u64> {
        Ok(near_api::Account(account.clone()).view().fetch_from(&self.net).await?.data.storage_usage)
    }

    async fn deal(&self, id: u64) -> R<Value> {
        self.view(&self.escrow, "get_deal", json!({ "deal_id": id })).await
    }

    async fn balance(&self, account: &str) -> R<u128> {
        let v = self.view(&self.ft, "ft_balance_of", json!({ "account_id": account })).await?;
        Ok(v.as_str().unwrap().parse()?)
    }

    fn pk(k: &SigningKey) -> String {
        format!("ed25519:{}", near_sdk::bs58::encode(k.verifying_key().to_bytes()).into_string())
    }

    /// Creator signs an offer, the client joins it with its own key.
    async fn create_deal(&self, deadline_in_s: u64, review_s: u64) -> R<u64> {
        self.create_deal_fee(deadline_in_s, review_s, 0).await
    }

    /// `deadline_in_s` is the delivery duration, counted from funding (v2).
    async fn create_deal_fee(&self, deadline_in_s: u64, review_s: u64, fee_bps: u16) -> R<u64> {
        let n = self.offers.get();
        self.offers.set(n + 1);
        let now = now_ns();
        let offer = format!(
            r#"{{"creator_pk":"{}","amount":"{AMOUNT}","fee_bps":"{fee_bps}","delivery_duration_ns":"{}","review_period_ns":"{}","terms_hash":"{}","offer_nonce":"sandbox-nonce-{n:08}","offer_expires_at_ns":"{}"}}"#,
            Self::pk(&self.creator),
            deadline_in_s * SEC,
            review_s * SEC,
            "ab".repeat(32),
            now + 600 * SEC,
        );
        self.last_offer.replace(offer.clone());
        let msg = format!("escrow-v1|{}|offer|{offer}", self.escrow);
        let sig = b64(&self.creator.sign(msg.as_bytes()).to_bytes());
        let res = self
            .call(
                &self.relayer,
                &self.escrow,
                "create_deal",
                json!({ "offer": offer, "offer_signature": sig, "client_pk": Self::pk(&self.client) }),
                DEAL_DEPOSIT,
            )
            .await?;
        Ok(res.assert_success().json::<u64>()?)
    }

    async fn fund(&self, id: u64, amount: u128) -> R {
        self.call(
            &self.payer,
            &self.ft,
            "ft_transfer_call",
            json!({ "receiver_id": self.escrow, "amount": amount.to_string(), "msg": format!("{{\"deal_id\":{id}}}") }),
            NearToken::from_yoctonear(1),
        )
        .await?
        .assert_success();
        Ok(())
    }

    fn sign(&self, key: &SigningKey, id: u64, action: &str, payload: &str) -> String {
        let msg = format!("escrow-v1|{}|{id}|{action}|{payload}", self.escrow);
        b64(&key.sign(msg.as_bytes()).to_bytes())
    }

    async fn act(&self, key: &SigningKey, id: u64, action: &str, payload: &str) -> R<TxResult> {
        let sig = self.sign(key, id, action, payload);
        // v2: the submitter of a withdraw pays its storage (0.00225 NEAR).
        let deposit = if action == "withdraw" {
            NearToken::from_yoctonear(2_250_000_000_000_000_000_000)
        } else {
            NearToken::from_yoctonear(0)
        };
        self.call(
            &self.relayer,
            &self.escrow,
            "act",
            json!({ "deal_id": id, "action": action, "payload": payload, "signature": sig }),
            deposit,
        )
        .await
    }

    async fn settle(&self, id: u64, payload: &str) -> R<TxResult> {
        let cs = self.sign(&self.creator, id, "settle", payload);
        let ks = self.sign(&self.client, id, "settle", payload);
        self.call(
            &self.stranger,
            &self.escrow,
            "settle",
            json!({ "deal_id": id, "payload": payload, "creator_signature": cs, "client_signature": ks }),
            NearToken::from_yoctonear(0),
        )
        .await
    }

    async fn state(&self, id: u64) -> R<String> {
        Ok(self.deal(id).await?["state"].as_str().unwrap().to_string())
    }
}

fn withdraw_payload(dest: &str, amount: u128) -> String {
    format!(r#"{{"destination":"{dest}","amount":"{amount}","expires_at_ns":"{}"}}"#, now_ns() + 1800 * SEC)
}

#[tokio::test]
async fn happy_path_fund_deliver_accept_withdraw() -> R {
    let e = Env::new(1).await?;
    let id = e.create_deal(3600, 600).await?;
    assert_eq!(id, 0);
    assert_eq!(e.state(id).await?, "Created");
    let offer = e.last_offer.borrow().clone();
    let by_offer = e.view(&e.escrow, "get_deal_id_by_offer", json!({ "offer": offer })).await?;
    assert_eq!(by_offer, json!(0));
    assert_eq!(e.deal(id).await?["client_fingerprint"].as_str().unwrap().len(), 14);

    // v2: a partial payment never funds; it is the client's at once.
    e.fund(id, 2_000_000).await?;
    let d = e.deal(id).await?;
    assert_eq!(d["state"], "Created");
    assert_eq!(d["client_payout"], "2000000");
    e.act(&e.client, id, "withdraw", &withdraw_payload("client-back.sandbox", 2_000_000)).await?.assert_success();
    assert_eq!(e.balance("client-back.sandbox").await?, 2_000_000);
    assert_eq!(e.state(id).await?, "Created");
    e.fund(id, AMOUNT).await?;
    let d = e.deal(id).await?;
    assert_eq!(d["state"], "Funded");
    assert!(d["delivery_deadline_ns"].is_string());
    assert_eq!(e.balance(e.escrow.as_str()).await?, AMOUNT);

    e.act(&e.client, id, "deliver", r#"{"deliverable_hash":"h"}"#).await?.assert_failure();
    e.act(&e.creator, id, "deliver", r#"{"deliverable_hash":"sha256:abc"}"#).await?.assert_success();
    e.act(&e.creator, id, "accept", "{}").await?.assert_failure();
    e.act(&e.client, id, "accept", "{}").await?.assert_success();
    assert_eq!(e.deal(id).await?["creator_payout"], AMOUNT.to_string());

    let dest = "payout-dest.sandbox"; // not registered with the token
    let payload = withdraw_payload(dest, AMOUNT);
    let paid: bool = e.act(&e.creator, id, "withdraw", &payload).await?.assert_success().json()?;
    assert!(paid);
    assert_eq!(e.balance(dest).await?, AMOUNT);
    assert_eq!(e.balance(e.escrow.as_str()).await?, 0);
    let d = e.deal(id).await?;
    assert_eq!(d["state"], "PaidOut");
    assert_eq!(d["settled"], true);
    let cfg = e.view(&e.escrow, "get_config", json!({})).await?;
    assert_eq!(cfg["total_liabilities"], "0");

    let used = e
        .view(&e.escrow, "is_withdraw_used", json!({ "deal_id": id, "payload": payload, "signer_pk": Env::pk(&e.creator) }))
        .await?;
    assert_eq!(used, json!(true));
    e.act(&e.creator, id, "withdraw", &payload).await?.assert_failure();
    Ok(())
}

#[tokio::test]
async fn init_is_private_and_offer_single_use() -> R {
    let e = Env::new(7).await?;
    // a fresh deployment without init: a stranger cannot front-run `new`
    let escrow2 = create(&e.sandbox, "escrow2.sandbox").await?;
    near_api::Contract::deploy(escrow2.clone())
        .use_code(wasms().0.clone())
        .without_init_call()
        .with_signer(e.signer.clone())
        .send_to(&e.net)
        .await?
        .assert_success();
    let init = json!({ "owner_id": e.stranger, "token_id": e.ft, "arbiter_id": e.arbiter, "relayer_id": e.relayer, "fee_account_id": e.owner });
    e.call(&e.stranger, &escrow2, "new", init.clone(), NearToken::from_yoctonear(0)).await?.assert_failure();
    // the account itself can
    e.call(&escrow2, &escrow2, "new", init.clone(), NearToken::from_yoctonear(0)).await?.assert_success();
    // and nobody can re-init
    e.call(&escrow2, &escrow2, "new", init, NearToken::from_yoctonear(0)).await?.assert_failure();
    // only the relayer can create deals
    let offer = r#"{"creator_pk":"ed25519:11111111111111111111111111111111","amount":"1","fee_bps":"0","delivery_duration_ns":"1","review_period_ns":"1","terms_hash":"x","offer_nonce":"0123456789abcdef","offer_expires_at_ns":"1"}"#;
    e.call(&e.stranger, &e.escrow, "create_deal", json!({ "offer": offer, "offer_signature": "", "client_pk": Env::pk(&e.client) }), NearToken::from_yoctonear(0))
        .await?
        .assert_failure();
    Ok(())
}

#[tokio::test]
async fn auto_release_after_review_timeout() -> R {
    let e = Env::new(2).await?;
    let id = e.create_deal(3600, 5).await?;
    e.fund(id, AMOUNT).await?;
    e.act(&e.creator, id, "deliver", r#"{"deliverable_hash":"h"}"#).await?.assert_success();
    e.call(&e.stranger, &e.escrow, "release_after_timeout", json!({ "deal_id": id }), NearToken::from_yoctonear(0))
        .await?
        .assert_failure();
    e.sandbox.fast_forward(100).await?;
    e.act(&e.client, id, "dispute", "{}").await?.assert_failure();
    e.call(&e.stranger, &e.escrow, "release_after_timeout", json!({ "deal_id": id }), NearToken::from_yoctonear(0))
        .await?
        .assert_success();
    let dest = "creator-dest.sandbox";
    e.act(&e.creator, id, "withdraw", &withdraw_payload(dest, AMOUNT)).await?.assert_success();
    assert_eq!(e.balance(dest).await?, AMOUNT);
    assert_eq!(e.state(id).await?, "PaidOut");
    Ok(())
}

#[tokio::test]
async fn dispute_and_resolve_split() -> R {
    let e = Env::new(3).await?;
    let id = e.create_deal(3600, 600).await?;
    e.fund(id, AMOUNT + 1_000).await?;
    e.act(&e.creator, id, "deliver", r#"{"deliverable_hash":"h"}"#).await?.assert_success();
    e.act(&e.client, id, "dispute", "{}").await?.assert_success();
    e.call(&e.owner, &e.escrow, "resolve_dispute", json!({ "deal_id": id, "creator_share_bps": 7000 }), NearToken::from_yoctonear(0))
        .await?
        .assert_failure();
    e.call(&e.arbiter, &e.escrow, "resolve_dispute", json!({ "deal_id": id, "creator_share_bps": 7000 }), NearToken::from_yoctonear(0))
        .await?
        .assert_success();
    let d = e.deal(id).await?;
    assert_eq!(d["creator_payout"], "3500000");
    assert_eq!(d["client_payout"], "1501000");
    e.act(&e.creator, id, "withdraw", &withdraw_payload("creator-dest.sandbox", 3_500_000)).await?.assert_success();
    e.act(&e.client, id, "withdraw", &withdraw_payload("client-dest.sandbox", 1_501_000)).await?.assert_success();
    assert_eq!(e.balance("creator-dest.sandbox").await?, 3_500_000);
    assert_eq!(e.balance("client-dest.sandbox").await?, 1_501_000);
    assert_eq!(e.balance(e.escrow.as_str()).await?, 0);
    assert_eq!(e.state(id).await?, "PaidOut");
    Ok(())
}

#[tokio::test]
async fn dispute_timeout_default_split() -> R {
    let e = Env::new(8).await?;
    let id = e.create_deal(3600, 600).await?;
    e.fund(id, AMOUNT).await?;
    e.act(&e.creator, id, "deliver", r#"{"deliverable_hash":"h"}"#).await?.assert_success();
    e.act(&e.client, id, "dispute", "{}").await?.assert_success();
    e.call(&e.stranger, &e.escrow, "resolve_dispute_timeout", json!({ "deal_id": id }), NearToken::from_yoctonear(0))
        .await?
        .assert_failure();
    e.sandbox.fast_forward(100).await?;
    e.call(&e.stranger, &e.escrow, "resolve_dispute_timeout", json!({ "deal_id": id }), NearToken::from_yoctonear(0))
        .await?
        .assert_success();
    let d = e.deal(id).await?;
    assert_eq!(d["state"], "Released");
    assert_eq!(d["creator_payout"], "2500000");
    assert_eq!(d["client_payout"], "2500000");
    Ok(())
}

#[tokio::test]
async fn client_refund_after_deadline() -> R {
    let e = Env::new(4).await?;
    let id = e.create_deal(10, 600).await?;
    e.fund(id, AMOUNT).await?;
    e.act(&e.client, id, "refund", "{}").await?.assert_failure();
    e.sandbox.fast_forward(150).await?;
    // the creator can no longer deliver after the deadline
    e.act(&e.creator, id, "deliver", r#"{"deliverable_hash":"late"}"#).await?.assert_failure();
    e.act(&e.client, id, "refund", "{}").await?.assert_success();
    e.act(&e.creator, id, "withdraw", &withdraw_payload("creator-dest.sandbox", 1)).await?.assert_failure();
    e.act(&e.client, id, "withdraw", &withdraw_payload("client-dest.sandbox", AMOUNT)).await?.assert_success();
    assert_eq!(e.balance("client-dest.sandbox").await?, AMOUNT);
    assert_eq!(e.state(id).await?, "PaidOut");
    Ok(())
}

#[tokio::test]
async fn failed_transfer_reverts_and_needs_fresh_signature() -> R {
    let e = Env::new(5).await?;
    let id = e.create_deal(3600, 600).await?;
    e.fund(id, AMOUNT).await?;
    e.act(&e.creator, id, "deliver", r#"{"deliverable_hash":"h"}"#).await?.assert_success();
    e.act(&e.client, id, "accept", "{}").await?.assert_success();

    e.call(&e.stranger, &e.ft, "set_fail_transfers", json!({ "fail": true }), NearToken::from_yoctonear(0))
        .await?
        .assert_success();
    let dest = "creator-dest.sandbox";
    let payload = withdraw_payload(dest, AMOUNT);
    let paid: bool = e.act(&e.creator, id, "withdraw", &payload).await?.assert_success().json()?;
    assert!(!paid, "transfer must be reported as failed");
    let d = e.deal(id).await?;
    assert_eq!(d["creator_payout"], AMOUNT.to_string());
    assert_eq!(d["creator_pending"], "0");
    assert_eq!(e.balance(e.escrow.as_str()).await?, AMOUNT);

    // the callback is private
    e.call(
        &e.stranger,
        &e.escrow,
        "on_withdraw",
        json!({ "deal_id": id, "party": "Creator", "amount": "1", "destination": dest, "withdraw_id": 1 }),
        NearToken::from_yoctonear(0),
    )
    .await?
    .assert_failure();

    e.call(&e.stranger, &e.ft, "set_fail_transfers", json!({ "fail": false }), NearToken::from_yoctonear(0))
        .await?
        .assert_success();
    // the failed signature is NOT re-armed
    e.act(&e.creator, id, "withdraw", &payload).await?.assert_failure();
    // a fresh signature works
    let paid: bool = e.act(&e.creator, id, "withdraw", &withdraw_payload(dest, AMOUNT)).await?.assert_success().json()?;
    assert!(paid);
    assert_eq!(e.balance(dest).await?, AMOUNT);
    assert_eq!(e.state(id).await?, "PaidOut");
    Ok(())
}

#[tokio::test]
async fn orphans_assign_and_sweep_capped_at_unaccounted() -> R {
    let e = Env::new(6).await?;
    let id = e.create_deal(3600, 600).await?;
    // 1) orphan via ft_transfer_call without a deal id
    e.call(&e.payer, &e.ft, "ft_transfer_call", json!({ "receiver_id": e.escrow, "amount": "42", "msg": "garbage" }), NearToken::from_yoctonear(1))
        .await?
        .assert_success();
    // 2) a plain ft_transfer (no callback at all)
    e.call(&e.payer, &e.ft, "ft_transfer", json!({ "receiver_id": e.escrow, "amount": "100" }), NearToken::from_yoctonear(1))
        .await?
        .assert_success();
    // 3) a real deal payment -> liability
    e.fund(id, AMOUNT).await?;
    let cfg = e.view(&e.escrow, "get_config", json!({})).await?;
    assert_eq!(cfg["orphan_amount"], "42");
    assert_eq!(cfg["total_liabilities"], AMOUNT.to_string());
    assert_eq!(e.balance(e.escrow.as_str()).await?, AMOUNT + 142);

    // register the owner with the token so it can receive
    e.call(&e.owner, &e.ft, "mint", json!({ "account_id": e.owner, "amount": "0" }), NearToken::from_yoctonear(0))
        .await?
        .assert_success();
    // non-owner cannot sweep
    e.call(&e.stranger, &e.escrow, "sweep_orphans", json!({ "receiver_id": e.stranger, "amount": "1" }), NearToken::from_yoctonear(1))
        .await?
        .assert_failure();
    // orphans: more than recorded is refused, exactly 42 works (no balance read)
    e.call(&e.owner, &e.escrow, "sweep_orphans", json!({ "receiver_id": e.owner, "amount": "43" }), NearToken::from_yoctonear(1))
        .await?
        .assert_failure();
    e.call(&e.owner, &e.escrow, "sweep_orphans", json!({ "receiver_id": e.owner, "amount": "42" }), NearToken::from_yoctonear(1))
        .await?
        .assert_success();
    assert_eq!(e.balance(e.owner.as_str()).await?, 42);
    // the plain transfer (100): the first read only records a snapshot
    let sweep = |amount: &'static str| {
        e.call(&e.owner, &e.escrow, "sweep_unaccounted", json!({ "receiver_id": e.owner, "amount": amount }), NearToken::from_yoctonear(1))
    };
    let ok: bool = sweep("100").await?.assert_success().json()?;
    assert!(!ok, "first step records the balance only");
    assert_eq!(e.balance(e.escrow.as_str()).await?, AMOUNT + 100);
    e.sandbox.fast_forward(5).await?;
    // more than the untracked 100 is refused on the confirming read
    let ok: bool = sweep("101").await?.assert_success().json()?;
    assert!(!ok);
    // two equal reads >= 1 s apart: exactly the untracked amount works
    let ok: bool = sweep("100").await?.assert_success().json()?;
    assert!(!ok, "new snapshot after the refused one");
    e.sandbox.fast_forward(5).await?;
    let ok: bool = sweep("100").await?.assert_success().json()?;
    assert!(ok);
    assert_eq!(e.balance(e.owner.as_str()).await?, 142);
    assert_eq!(e.balance(e.escrow.as_str()).await?, AMOUNT);
    let cfg = e.view(&e.escrow, "get_config", json!({})).await?;
    assert_eq!(cfg["orphan_amount"], "0");
    assert_eq!(cfg["sweep_reserved"], "0");
    assert_eq!(e.state(id).await?, "Funded");
    Ok(())
}

#[tokio::test]
async fn v2_settle_with_fee_and_fee_withdraw() -> R {
    let e = Env::new(9).await?;
    let id = e.create_deal_fee(3600, 600, 300).await?;
    e.fund(id, AMOUNT).await?;
    e.act(&e.creator, id, "deliver", r#"{"deliverable_hash":"h"}"#).await?.assert_success();
    let payload = format!(
        r#"{{"split_bps":"9000","state":"Delivered","seq":"0","expires_at_ns":"{}","nonce":"sandbox-1"}}"#,
        now_ns() + 600 * SEC
    );
    e.settle(id, &payload).await?.assert_success();
    let d = e.deal(id).await?;
    assert_eq!(d["state"], "Released");
    assert_eq!(d["fee_amount"], "135000");
    assert_eq!(d["creator_payout"], "4365000");
    assert_eq!(d["client_payout"], "500000");
    let cfg = e.view(&e.escrow, "get_config", json!({})).await?;
    assert_eq!(cfg["fee_accrued"], "135000");
    // the fee account (stranger here) withdraws the fee; it must be registered
    e.call(&e.owner, &e.ft, "storage_deposit", json!({ "account_id": e.stranger }), NearToken::from_millinear(10))
        .await?
        .assert_success();
    e.call(&e.stranger, &e.escrow, "withdraw_fees", json!({ "amount": "135000" }), NearToken::from_yoctonear(1))
        .await?
        .assert_success();
    assert_eq!(e.balance(e.stranger.as_str()).await?, 135_000);
    e.act(&e.creator, id, "withdraw", &withdraw_payload("creator-dest.sandbox", 4_365_000)).await?.assert_success();
    e.act(&e.client, id, "withdraw", &withdraw_payload("client-dest.sandbox", 500_000)).await?.assert_success();
    assert_eq!(e.balance(e.escrow.as_str()).await?, 0);
    assert_eq!(e.state(id).await?, "PaidOut");
    let cfg = e.view(&e.escrow, "get_config", json!({})).await?;
    assert_eq!(cfg["total_liabilities"], "0");
    Ok(())
}

/// The deal deposit covers the escrow storage of a deal over
/// its whole life (longest hashes, funded, delivered, disputed, resolved).
#[tokio::test]
async fn deal_deposit_covers_worst_case_storage() -> R {
    let e = Env::new(11).await?;
    let before = e.storage_usage(&e.escrow).await?;
    let id = e.create_deal(3600, 600).await?;
    e.fund(id, AMOUNT).await?;
    let hash = "h".repeat(192);
    e.act(&e.creator, id, "deliver", &format!(r#"{{"deliverable_hash":"{hash}"}}"#)).await?.assert_success();
    e.act(&e.client, id, "dispute", "{}").await?.assert_success();
    e.call(&e.arbiter, &e.escrow, "resolve_dispute", json!({ "deal_id": id, "creator_share_bps": 7000 }), NearToken::from_yoctonear(0))
        .await?
        .assert_success();
    let used = e.storage_usage(&e.escrow).await? - before;
    // the terms hash in the helper is 64 chars; the max is 128 (+64 B)
    let worst = used + 64;
    let cost = worst as u128 * 10_000_000_000_000_000_000;
    println!("deal storage: {used} B (worst case {worst} B) = {cost} yocto; deposit {}", DEAL_DEPOSIT.as_yoctonear());
    assert!(cost < DEAL_DEPOSIT.as_yoctonear(), "deposit too small: {worst} B");
    // and the relayer cannot skip it
    let offer_res = e
        .call(&e.relayer, &e.escrow, "create_deal", json!({ "offer": "{}", "offer_signature": "", "client_pk": "" }), NearToken::from_yoctonear(0))
        .await?;
    offer_res.assert_failure();
    Ok(())
}

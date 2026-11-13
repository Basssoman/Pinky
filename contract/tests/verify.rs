//! Judge suite: attack attempts + honest paths against the real escrow wasm
//! on a local near-sandbox node, with a mock NEP-141 token standing in for USDC.
//!
//! Every ATTACK line must print `REFUSED` together with the contract's own
//! panic message, and the message must be the expected one (refused for the
//! right reason). Every honest path must print `OK`. Anything else prints
//! `FAIL` and the test fails.
//!
//! Run: `cargo test --test verify -- --nocapture` (or `npm run verify` from the
//! repository root, which also runs the read-only mainnet checks).
//!
//! This file only adds tests; it does not change the contract.

use std::cell::{Cell, RefCell};
use std::sync::Arc;

use ed25519_dalek::{Signer as _, SigningKey};
use near_api::{AccountId, NearGas, NearToken, NetworkConfig, Signer};
use near_sdk::base64::Engine;
use near_sdk::serde_json::{json, Value};

type R<T = ()> = testresult::TestResult<T>;
type TxResult = near_api::types::transaction::result::TransactionResult;

const AMOUNT: u128 = 5_000_000; // 5 USDC (6 decimals)
const SEC: u64 = 1_000_000_000;
/// Short dispute period for this sandbox instance only.
const DISPUTE_S: u64 = 20;
const DEAL_DEPOSIT: NearToken = NearToken::from_millinear(10);
const WITHDRAW_DEPOSIT: NearToken = NearToken::from_yoctonear(2_250_000_000_000_000_000_000);
const NO_DEPOSIT: NearToken = NearToken::from_yoctonear(0);

fn now_ns() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos() as u64
}

fn b64(bytes: &[u8]) -> String {
    near_sdk::base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn pk(k: &SigningKey) -> String {
    format!("ed25519:{}", near_sdk::bs58::encode(k.verifying_key().to_bytes()).into_string())
}

fn withdraw_payload(dest: &str, amount: u128) -> String {
    format!(r#"{{"destination":"{dest}","amount":"{amount}","expires_at_ns":"{}"}}"#, now_ns() + 1800 * SEC)
}

/// The contract's panic text inside a failed transaction, if any.
fn panic_text(res: &TxResult) -> String {
    let dbg = format!("{res:?}");
    const MARK: &str = "Smart contract panicked: ";
    match dbg.find(MARK) {
        Some(i) => {
            let rest = &dbg[i + MARK.len()..];
            let end = rest.find("\\\"").or_else(|| rest.find('"')).unwrap_or(rest.len());
            rest[..end].to_string()
        }
        None => {
            // not a contract panic (e.g. a runtime error): show a short form
            dbg.chars().take(220).collect()
        }
    }
}

struct Report {
    n: Cell<u32>,
    refused: Cell<u32>,
    attacks: Cell<u32>,
    ok: Cell<u32>,
    honest: Cell<u32>,
    fails: RefCell<Vec<String>>,
}

impl Report {
    fn new() -> Self {
        Self { n: Cell::new(0), refused: Cell::new(0), attacks: Cell::new(0), ok: Cell::new(0), honest: Cell::new(0), fails: RefCell::new(vec![]) }
    }
    fn next(&self) -> u32 {
        self.n.set(self.n.get() + 1);
        self.n.get()
    }
    /// An attack: the transaction must fail with a panic containing `expect`.
    fn attack(&self, name: &str, res: TxResult, expect: &str) {
        let i = self.next();
        self.attacks.set(self.attacks.get() + 1);
        if res.is_success() {
            println!("[{i:02}] FAIL     ATTACK {name}\n           the contract ACCEPTED it");
            self.fails.borrow_mut().push(format!("{i:02} {name}: accepted"));
            return;
        }
        let why = panic_text(&res);
        if why.contains(expect) {
            self.refused.set(self.refused.get() + 1);
            println!("[{i:02}] REFUSED  ATTACK {name}\n           contract: \"{why}\"");
        } else {
            println!("[{i:02}] FAIL     ATTACK {name}\n           refused for another reason: \"{why}\" (expected \"{expect}\")");
            self.fails.borrow_mut().push(format!("{i:02} {name}: wrong reason"));
        }
    }
    /// An attack the contract absorbs without a panic (by design), checked by state.
    fn attack_absorbed(&self, name: &str, held: bool, how: &str) {
        let i = self.next();
        self.attacks.set(self.attacks.get() + 1);
        if held {
            self.refused.set(self.refused.get() + 1);
            println!("[{i:02}] REFUSED  ATTACK {name}\n           contract: {how}");
        } else {
            println!("[{i:02}] FAIL     ATTACK {name}\n           state changed");
            self.fails.borrow_mut().push(format!("{i:02} {name}: state changed"));
        }
    }
    /// An honest step: must succeed; `check` = extra state check.
    fn honest(&self, name: &str, res: &TxResult, check: bool, detail: &str) {
        let i = self.next();
        self.honest.set(self.honest.get() + 1);
        if res.is_success() && check {
            self.ok.set(self.ok.get() + 1);
            println!("[{i:02}] OK       {name}\n           {detail}");
        } else {
            let why = if res.is_success() { "state check failed".to_string() } else { panic_text(res) };
            println!("[{i:02}] FAIL     {name}\n           {why}");
            self.fails.borrow_mut().push(format!("{i:02} {name}"));
        }
    }
    fn honest_check(&self, name: &str, check: bool, detail: &str) {
        let i = self.next();
        self.honest.set(self.honest.get() + 1);
        if check {
            self.ok.set(self.ok.get() + 1);
            println!("[{i:02}] OK       {name}\n           {detail}");
        } else {
            println!("[{i:02}] FAIL     {name}\n           {detail}");
            self.fails.borrow_mut().push(format!("{i:02} {name}"));
        }
    }
    fn section(&self, title: &str) {
        println!("\n--- {title} ---");
    }
}

struct Env {
    sandbox: near_sandbox::Sandbox,
    net: NetworkConfig,
    signer: Arc<Signer>,
    escrow: AccountId,
    ft: AccountId,
    owner: AccountId,
    relayer: AccountId,
    arbiter: AccountId,
    payer: AccountId,
    stranger: AccountId,
    fee: AccountId,
    creator: SigningKey,
    client: SigningKey,
    nonce: Cell<u32>,
}

async fn create(sandbox: &near_sandbox::Sandbox, name: &str) -> R<AccountId> {
    let id: AccountId = name.parse()?;
    sandbox.create_account(id.clone()).initial_balance(NearToken::from_near(20)).send().await?;
    Ok(id)
}

impl Env {
    async fn new() -> R<Self> {
        let escrow_wasm = cargo_near_build::build_with_cli(Default::default()).expect("build escrow");
        let manifest = format!("{}/mock-ft/Cargo.toml", env!("CARGO_MANIFEST_DIR"));
        let opts = cargo_near_build::BuildOpts::builder()
            .manifest_path(cargo_near_build::camino::Utf8PathBuf::from(manifest))
            .no_abi(true)
            .build();
        let ft_wasm = cargo_near_build::build_with_cli(opts).expect("build mock-ft");
        let (escrow_wasm, ft_wasm) = (std::fs::read(escrow_wasm)?, std::fs::read(ft_wasm)?);

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
        let fee = create(&sandbox, "fees.sandbox").await?;

        near_api::Contract::deploy(ft.clone())
            .use_code(ft_wasm)
            .with_init_call("new", json!({}))?
            .with_signer(signer.clone())
            .send_to(&net)
            .await?
            .assert_success();
        near_api::Contract::deploy(escrow.clone())
            .use_code(escrow_wasm)
            .with_init_call(
                "new",
                json!({
                    "owner_id": owner, "token_id": ft, "arbiter_id": arbiter, "relayer_id": relayer,
                    "fee_account_id": fee,
                    "periods": {
                        "min_review_period_ns": SEC.to_string(),
                        "dispute_period_ns": (DISPUTE_S * SEC).to_string(),
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
            fee,
            creator: SigningKey::from_bytes(&[41; 32]),
            client: SigningKey::from_bytes(&[42; 32]),
            nonce: Cell::new(0),
        };
        env.call(&env.owner, &env.ft, "storage_deposit", json!({ "account_id": env.escrow }), NearToken::from_millinear(10))
            .await?
            .assert_success();
        env.call(&env.owner, &env.ft, "storage_deposit", json!({ "account_id": env.fee }), NearToken::from_millinear(10))
            .await?
            .assert_success();
        env.call(&env.owner, &env.ft, "mint", json!({ "account_id": env.payer, "amount": "1000000000" }), NO_DEPOSIT)
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
        Ok(near_api::Contract(contract.clone()).call_function(method, args).read_only().fetch_from(&self.net).await?.data)
    }

    async fn deal(&self, id: u64) -> R<Value> {
        self.view(&self.escrow, "get_deal", json!({ "deal_id": id })).await
    }

    async fn state(&self, id: u64) -> R<String> {
        Ok(self.deal(id).await?["state"].as_str().unwrap_or("?").to_string())
    }

    async fn balance(&self, account: &str) -> R<u128> {
        let v = self.view(&self.ft, "ft_balance_of", json!({ "account_id": account })).await?;
        Ok(v.as_str().unwrap_or("0").parse()?)
    }

    /// A creator-signed offer (exact compact JSON, as the web builds it).
    fn offer(&self, delivery_s: u64, review_s: u64, fee_bps: u16) -> String {
        let n = self.nonce.get();
        self.nonce.set(n + 1);
        format!(
            r#"{{"creator_pk":"{}","amount":"{AMOUNT}","fee_bps":"{fee_bps}","delivery_duration_ns":"{}","review_period_ns":"{}","terms_hash":"{}","offer_nonce":"verify-nonce-{n:08}","offer_expires_at_ns":"{}"}}"#,
            pk(&self.creator),
            delivery_s * SEC,
            review_s * SEC,
            "ab".repeat(32),
            now_ns() + 600 * SEC,
        )
    }

    fn sign_offer(&self, key: &SigningKey, offer: &str) -> String {
        b64(&key.sign(format!("escrow-v1|{}|offer|{offer}", self.escrow).as_bytes()).to_bytes())
    }

    async fn create_deal_raw(&self, from: &AccountId, offer: &str, sig: &str, client_pk: &str) -> R<TxResult> {
        self.call(from, &self.escrow, "create_deal", json!({ "offer": offer, "offer_signature": sig, "client_pk": client_pk }), DEAL_DEPOSIT)
            .await
    }

    async fn new_deal(&self, delivery_s: u64, review_s: u64, fee_bps: u16) -> R<(u64, String)> {
        let offer = self.offer(delivery_s, review_s, fee_bps);
        let sig = self.sign_offer(&self.creator, &offer);
        let id = self.create_deal_raw(&self.relayer, &offer, &sig, &pk(&self.client)).await?.assert_success().json::<u64>()?;
        Ok((id, offer))
    }

    async fn fund(&self, id: u64, amount: u128) -> R<TxResult> {
        self.call(
            &self.payer,
            &self.ft,
            "ft_transfer_call",
            json!({ "receiver_id": self.escrow, "amount": amount.to_string(), "msg": format!("{{\"deal_id\":{id}}}") }),
            NearToken::from_yoctonear(1),
        )
        .await
    }

    fn sign_for(&self, contract: &str, key: &SigningKey, id: u64, action: &str, payload: &str) -> String {
        b64(&key.sign(format!("escrow-v1|{contract}|{id}|{action}|{payload}").as_bytes()).to_bytes())
    }

    fn sign(&self, key: &SigningKey, id: u64, action: &str, payload: &str) -> String {
        self.sign_for(self.escrow.as_str(), key, id, action, payload)
    }

    /// Submit an `act` with an explicit signature (any submitter may send it).
    async fn act_sig(&self, id: u64, action: &str, payload: &str, sig: &str) -> R<TxResult> {
        let deposit = if action == "withdraw" { WITHDRAW_DEPOSIT } else { NO_DEPOSIT };
        self.call(&self.relayer, &self.escrow, "act", json!({ "deal_id": id, "action": action, "payload": payload, "signature": sig }), deposit)
            .await
    }

    async fn act(&self, key: &SigningKey, id: u64, action: &str, payload: &str) -> R<TxResult> {
        let sig = self.sign(key, id, action, payload);
        self.act_sig(id, action, payload, &sig).await
    }

    async fn anyone(&self, from: &AccountId, method: &str, args: Value) -> R<TxResult> {
        self.call(from, &self.escrow, method, args, NO_DEPOSIT).await
    }
}

#[tokio::test]
async fn verify_attacks_and_honest_paths() -> R {
    let e = Env::new().await?;
    let r = Report::new();
    let (creator, client) = (&e.creator, &e.client);
    let mallory = SigningKey::from_bytes(&[66; 32]); // an outsider's key
    println!("\nPinky escrow judge suite: real escrow wasm on a local near-sandbox, mock USDC token");
    println!("parties: creator key {}, client key {}, attacker key {}", pk(creator), pk(client), pk(&mallory));

    // ------------------------------------------------------------ joining
    r.section("Starting a deal (offer signed by the creator, joined by the client)");
    let offer = e.offer(3600, 600, 300);
    let good_sig = e.sign_offer(creator, &offer);
    let res = e.create_deal_raw(&e.stranger, &offer, &good_sig, &pk(client)).await?;
    r.attack("a stranger account creates a deal directly (only the relayer may)", res, "only relayer");

    let forged = e.sign_offer(&mallory, &offer);
    let res = e.create_deal_raw(&e.relayer, &offer, &forged, &pk(client)).await?;
    r.attack("offer signed by someone else's key in the creator's name", res, "offer: invalid creator signature");

    let tampered = offer.replace(&format!(r#""amount":"{AMOUNT}""#), r#""amount":"50000000""#);
    let res = e.create_deal_raw(&e.relayer, &tampered, &good_sig, &pk(client)).await?;
    r.attack("server changes the price in a signed offer (5 -> 50 USDC)", res, "offer: invalid creator signature");

    let weak = format!("ed25519:{}", near_sdk::bs58::encode([1u8].iter().chain([0u8; 31].iter()).copied().collect::<Vec<u8>>()).into_string());
    let res = e.create_deal_raw(&e.relayer, &offer, &good_sig, &weak).await?;
    r.attack("join with a weak (small-order) client key that verifies any signature", res, "public key: weak");

    let res = e.create_deal_raw(&e.relayer, &offer, &good_sig, &pk(client)).await?;
    let d1: u64 = if res.is_success() { res.clone().assert_success().json()? } else { u64::MAX };
    r.honest("honest join: the relayer creates deal 0 from the signed offer", &res, d1 == 0, "deal 0 state Created");

    let res = e.create_deal_raw(&e.relayer, &offer, &good_sig, &pk(&mallory)).await?;
    r.attack("replay the same offer to start a second deal (link used twice)", res, "offer already used or revoked");

    let revoked = e.offer(3600, 600, 0);
    let rsig = b64(&creator.sign(format!("escrow-v1|{}|revoke_offer|{revoked}", e.escrow).as_bytes()).to_bytes());
    let res = e.call(&e.stranger, &e.escrow, "revoke_offer", json!({ "offer": revoked, "signature": rsig }), NearToken::from_millinear(1)).await?;
    r.honest("creator revokes an unused link", &res, true, "revoke_offer accepted");
    let res = e.create_deal_raw(&e.relayer, &revoked, &e.sign_offer(creator, &revoked), &pk(client)).await?;
    r.attack("start a deal from a revoked link", res, "offer already used or revoked");

    // ------------------------------------------------------------ funding
    r.section("Funding (only the USDC token contract can fund a deal)");
    let res = e.act(creator, d1, "deliver", r#"{"deliverable_hash":"sha256:early"}"#).await?;
    r.attack("creator marks work delivered before the client paid", res, "deliver: deal must be Funded");

    let res = e.call(&e.stranger, &e.escrow, "ft_on_transfer", json!({ "sender_id": e.payer, "amount": AMOUNT.to_string(), "msg": format!("{{\"deal_id\":{d1}}}") }), NO_DEPOSIT).await?;
    let d = e.deal(d1).await?;
    r.attack_absorbed(
        "fake payment: a stranger calls ft_on_transfer itself, claiming 5 USDC arrived",
        res.is_success() && d["state"] == "Created" && d["funded_amount"] == "0",
        "logged \"unsupported token, returning all\"; deal 0 stays Created, funded_amount 0",
    );

    let res = e.fund(d1, AMOUNT).await?;
    let d = e.deal(d1).await?;
    r.honest("client pays 5 USDC (ft_transfer_call from the token)", &res, d["state"] == "Funded", "deal 0 state Funded, escrow holds 5 USDC");

    // ------------------------------------------------------------ while funded
    r.section("While the work is in progress (Funded)");
    let res = e.act(client, d1, "deliver", r#"{"deliverable_hash":"sha256:fake"}"#).await?;
    r.attack("client signs a fake delivery (wrong signer)", res, "invalid signature (creator key required)");
    let res = e.act(&mallory, d1, "deliver", r#"{"deliverable_hash":"sha256:fake"}"#).await?;
    r.attack("outsider signs a fake delivery", res, "invalid signature (creator key required)");
    let res = e.act(creator, d1, "withdraw", &withdraw_payload("creator-dest.sandbox", AMOUNT)).await?;
    r.attack("creator takes the money before delivery/acceptance", res, "withdraw: nothing to withdraw for this key");
    let res = e.act(client, d1, "withdraw", &withdraw_payload("client-dest.sandbox", AMOUNT)).await?;
    r.attack("client withdraws the paid money early", res, "withdraw: nothing to withdraw for this key");
    let res = e.act(client, d1, "refund", "{}").await?;
    r.attack("client refunds before the delivery deadline", res, "refund: client may refund only after the delivery deadline");
    let res = e.call(&e.arbiter, &e.escrow, "resolve_dispute", json!({ "deal_id": d1, "creator_share_bps": 0 }), NO_DEPOSIT).await?;
    r.attack("arbiter overreach: decides a deal nobody disputed", res, "deal must be Disputed");

    let res = e.act(creator, d1, "deliver", r#"{"deliverable_hash":"sha256:0f1e2d"}"#).await?;
    let d = e.deal(d1).await?;
    r.honest("creator delivers (signed, stores the file fingerprint)", &res, d["state"] == "Delivered", "deal 0 state Delivered, deliverable_hash sha256:0f1e2d");

    // ------------------------------------------------------------ delivered
    r.section("After delivery, during the client's review");
    let res = e.act(creator, d1, "accept", "{}").await?;
    r.attack("creator accepts their own work", res, "invalid signature (client key required)");
    let res = e.act(creator, d1, "withdraw", &withdraw_payload("creator-dest.sandbox", AMOUNT)).await?;
    r.attack("creator takes the money before the client accepted", res, "withdraw: nothing to withdraw for this key");
    let res = e.anyone(&e.stranger, "release_after_timeout", json!({ "deal_id": d1 })).await?;
    r.attack("anyone releases the money before the review period ends", res, "review period is not over yet");
    let other_sig = e.sign_for("other-escrow.sandbox", client, d1, "accept", "{}");
    let res = e.act_sig(d1, "accept", "{}", &other_sig).await?;
    r.attack("client signature made for another contract, replayed here", res, "invalid signature (client key required)");

    let accept_sig = e.sign(client, d1, "accept", "{}");
    let res = e.act_sig(d1, "accept", "{}", &accept_sig).await?;
    let d = e.deal(d1).await?;
    r.honest(
        "client accepts (3% fee from the creator's share only)",
        &res,
        d["state"] == "Released" && d["creator_payout"] == "4850000" && d["fee_amount"] == "150000",
        "deal 0 Released: creator_payout 4.85 USDC, fee 0.15 USDC",
    );

    // ------------------------------------------------------------ payout
    r.section("Payout (the signed payload names destination, amount and expiry)");
    let signed = withdraw_payload("creator-dest.sandbox", 4_850_000);
    let sig = e.sign(creator, d1, "withdraw", &signed);
    let redirected = signed.replace("creator-dest.sandbox", "relayer-pocket.sandbox");
    let res = e.act_sig(d1, "withdraw", &redirected, &sig).await?;
    r.attack("relayer redirects the creator's payout to its own account", res, "invalid signature");
    let res = e.act(creator, d1, "withdraw", &withdraw_payload("creator-dest.sandbox", 9_999_999)).await?;
    r.attack("creator withdraws more than their payout", res, "withdraw: amount exceeds the withdrawable payout");
    let expired = r#"{"destination":"creator-dest.sandbox","amount":"4850000","expires_at_ns":"1"}"#;
    let res = e.act(creator, d1, "withdraw", expired).await?;
    r.attack("old (expired) withdraw signature used later", res, "withdraw: signature expired");
    let res = e.act(creator, d1, "withdraw", &withdraw_payload(e.escrow.as_str(), 4_850_000)).await?;
    r.attack("withdraw into the escrow itself (accounting loop)", res, "withdraw: bad destination");
    let res = e.act(client, d1, "withdraw", &withdraw_payload("client-dest.sandbox", 4_850_000)).await?;
    r.attack("client withdraws the creator's released money", res, "withdraw: nothing to withdraw for this key");

    let res = e.act_sig(d1, "withdraw", &signed, &sig).await?;
    let bal = e.balance("creator-dest.sandbox").await?;
    r.honest("creator withdraws 4.85 USDC to the signed destination", &res, bal == 4_850_000 && e.state(d1).await? == "PaidOut", "creator-dest.sandbox received 4850000, deal 0 PaidOut");
    let res = e.act_sig(d1, "withdraw", &signed, &sig).await?;
    r.attack("replay the same withdraw signature (pay twice)", res, "withdraw: signature already used");

    // ------------------------------------------------------------ dispute
    r.section("Dispute and the arbiter's limits");
    let (d2, _) = e.new_deal(3600, 600, 0).await?;
    e.fund(d2, AMOUNT).await?.assert_success();
    e.act(creator, d2, "deliver", r#"{"deliverable_hash":"sha256:d2"}"#).await?.assert_success();
    let res = e.act_sig(d2, "accept", "{}", &accept_sig).await?;
    r.attack("replay deal 0's accept signature on deal 1 (same keys)", res, "invalid signature (client key required)");
    let res = e.act(client, d2, "dispute", "{}").await?;
    r.honest("client opens a dispute during the review period", &res, e.state(d2).await? == "Disputed", "deal 1 Disputed");
    let res = e.call(&e.owner, &e.escrow, "resolve_dispute", json!({ "deal_id": d2, "creator_share_bps": 10000 }), NO_DEPOSIT).await?;
    r.attack("contract owner decides the dispute (only the arbiter may)", res, "only arbiter");
    let res = e.call(&e.relayer, &e.escrow, "resolve_dispute", json!({ "deal_id": d2, "creator_share_bps": 10000 }), NO_DEPOSIT).await?;
    r.attack("relayer decides the dispute", res, "only arbiter");
    let res = e.call(&e.arbiter, &e.escrow, "resolve_dispute", json!({ "deal_id": d2, "creator_share_bps": 20000 }), NO_DEPOSIT).await?;
    r.attack("arbiter gives the creator more than 100%", res, "creator_share_bps must be <= 10000");
    let res = e.call(&e.arbiter, &e.escrow, "resolve_dispute", json!({ "deal_id": d2, "creator_share_bps": 7000 }), NO_DEPOSIT).await?;
    let d = e.deal(d2).await?;
    r.honest("arbiter splits 70/30 while the dispute period runs", &res, d["creator_payout"] == "3500000" && d["client_payout"] == "1500000", "deal 1: creator 3.5 USDC, client 1.5 USDC");
    let res = e.call(&e.arbiter, &e.escrow, "resolve_dispute", json!({ "deal_id": d2, "creator_share_bps": 0 }), NO_DEPOSIT).await?;
    r.attack("arbiter changes a decided dispute", res, "deal must be Disputed");
    let a = e.act(creator, d2, "withdraw", &withdraw_payload("creator-dest-2.sandbox", 3_500_000)).await?;
    let b = e.act(client, d2, "withdraw", &withdraw_payload("client-dest-2.sandbox", 1_500_000)).await?;
    r.honest(
        "both sides withdraw their split",
        &a,
        b.is_success() && e.balance("creator-dest-2.sandbox").await? == 3_500_000 && e.balance("client-dest-2.sandbox").await? == 1_500_000,
        "3500000 + 1500000 paid, deal 1 PaidOut",
    );

    // ------------------------------------------------------------ settle
    r.section("Agreement between the two sides (settle)");
    let (d3, _) = e.new_deal(3600, 600, 300).await?;
    e.fund(d3, AMOUNT).await?.assert_success();
    e.act(creator, d3, "deliver", r#"{"deliverable_hash":"sha256:d3"}"#).await?.assert_success();
    let p0 = format!(r#"{{"split_bps":"9000","state":"Delivered","seq":"0","expires_at_ns":"{}","nonce":"verify-0"}}"#, now_ns() + 600 * SEC);
    let res = e
        .call(&e.stranger, &e.escrow, "settle", json!({ "deal_id": d3, "payload": p0, "creator_signature": e.sign(creator, d3, "settle", &p0), "client_signature": e.sign(creator, d3, "settle", &p0) }), NO_DEPOSIT)
        .await?;
    r.attack("creator signs the settle for both sides", res, "settle: invalid client signature");
    let res = e.act(client, d3, "revoke_settle", r#"{"seq":"0"}"#).await?;
    r.honest("client takes back a settle proposal it signed (revoke_settle)", &res, true, "settle_seq 0 -> 1");
    let res = e
        .call(&e.stranger, &e.escrow, "settle", json!({ "deal_id": d3, "payload": p0, "creator_signature": e.sign(creator, d3, "settle", &p0), "client_signature": e.sign(client, d3, "settle", &p0) }), NO_DEPOSIT)
        .await?;
    r.attack("submit the settle proposal the client took back", res, "settle: revoked (settle_seq changed)");
    let p1 = p0.replace(r#""seq":"0""#, r#""seq":"1""#).replace("judge-0", "judge-1");
    let res = e
        .call(&e.stranger, &e.escrow, "settle", json!({ "deal_id": d3, "payload": p1, "creator_signature": e.sign(creator, d3, "settle", &p1), "client_signature": e.sign(client, d3, "settle", &p1) }), NO_DEPOSIT)
        .await?;
    let d = e.deal(d3).await?;
    r.honest("both sign a 90/10 settle", &res, d["creator_payout"] == "4365000" && d["client_payout"] == "500000", "deal 2: creator 4.365 USDC (after 3% fee), client 0.5 USDC");
    let res = e
        .call(&e.stranger, &e.escrow, "settle", json!({ "deal_id": d3, "payload": p1, "creator_signature": e.sign(creator, d3, "settle", &p1), "client_signature": e.sign(client, d3, "settle", &p1) }), NO_DEPOSIT)
        .await?;
    r.attack("replay the same settle", res, "settle: deal state differs from the signed state");

    // ------------------------------------------------------------ admin
    r.section("Operator powers (fees, sweeps)");
    let res = e.call(&e.stranger, &e.escrow, "withdraw_fees", json!({ "amount": "1" }), NearToken::from_yoctonear(1)).await?;
    r.attack("a stranger takes the collected fees", res, "only fee account");
    let res = e.call(&e.fee, &e.escrow, "withdraw_fees", json!({ "amount": "10000000" }), NearToken::from_yoctonear(1)).await?;
    r.attack("fee account takes more than the fees (deal money)", res, "amount exceeds accrued fees");
    let res = e.call(&e.stranger, &e.escrow, "sweep_unaccounted", json!({ "receiver_id": e.stranger, "amount": "1" }), NearToken::from_yoctonear(1)).await?;
    r.attack("a stranger sweeps tokens out of the escrow", res, "only owner");
    let res = e.call(&e.owner, &e.escrow, "sweep_orphans", json!({ "receiver_id": e.owner, "amount": "1" }), NearToken::from_yoctonear(1)).await?;
    r.attack("owner sweeps deal money as 'orphans' (there are none)", res, "amount exceeds orphan_amount");
    let res = e.call(&e.relayer, &e.escrow, "set_arbiter", json!({ "arbiter_id": e.relayer }), NO_DEPOSIT).await?;
    r.attack("relayer appoints itself arbiter", res, "only owner");

    // ------------------------------------------------------------ timeouts
    r.section("Deadlines (sandbox clock moved forward)");
    let (d4, _) = e.new_deal(5, 600, 0).await?; // delivery deadline 5 s after funding
    e.fund(d4, AMOUNT).await?.assert_success();
    let (d5, _) = e.new_deal(3600, 5, 300).await?; // review 5 s
    e.fund(d5, AMOUNT).await?.assert_success();
    e.act(creator, d5, "deliver", r#"{"deliverable_hash":"sha256:d5"}"#).await?.assert_success();
    let (d6, _) = e.new_deal(3600, 600, 0).await?; // dispute period 20 s
    e.fund(d6, AMOUNT).await?.assert_success();
    e.act(creator, d6, "deliver", r#"{"deliverable_hash":"sha256:d6"}"#).await?.assert_success();
    e.act(client, d6, "dispute", "{}").await?.assert_success();
    let res = e.anyone(&e.stranger, "resolve_dispute_timeout", json!({ "deal_id": d6 })).await?;
    r.attack("anyone forces the 50/50 timeout split before the dispute period ends", res, "dispute period is not over yet");

    e.sandbox.fast_forward(400).await?;

    let res = e.act(creator, d4, "deliver", r#"{"deliverable_hash":"sha256:late"}"#).await?;
    r.attack("creator delivers after the delivery deadline", res, "deliver: delivery deadline has passed");
    let res = e.act(client, d4, "refund", "{}").await?;
    r.honest("client refunds after the missed deadline", &res, e.state(d4).await? == "Refunded", "deal 3 Refunded");
    let res = e.act(creator, d4, "withdraw", &withdraw_payload("creator-dest-4.sandbox", 1)).await?;
    r.attack("creator withdraws from a refunded deal", res, "withdraw: nothing to withdraw for this key");
    let res = e.act(client, d4, "withdraw", &withdraw_payload("client-dest-4.sandbox", AMOUNT)).await?;
    r.honest("client gets 100% back (no fee on refunds)", &res, e.balance("client-dest-4.sandbox").await? == AMOUNT, "client-dest-4.sandbox received 5000000");

    let res = e.act(client, d5, "dispute", "{}").await?;
    r.attack("client disputes after the review period ended", res, "dispute: review period is over");
    let res = e.anyone(&e.stranger, "release_after_timeout", json!({ "deal_id": d5 })).await?;
    let d = e.deal(d5).await?;
    r.honest("anyone triggers auto-release after the review period", &res, d["state"] == "Released" && d["creator_payout"] == "4850000", "deal 4 Released to the creator (4.85 USDC after fee)");

    let res = e.call(&e.arbiter, &e.escrow, "resolve_dispute", json!({ "deal_id": d6, "creator_share_bps": 10000 }), NO_DEPOSIT).await?;
    r.attack("arbiter decides after the dispute period is over", res, "the dispute period is over; only the timeout split applies");
    let res = e.anyone(&e.stranger, "resolve_dispute_timeout", json!({ "deal_id": d6 })).await?;
    let d = e.deal(d6).await?;
    r.honest("anyone applies the 50/50 timeout split", &res, d["creator_payout"] == "2500000" && d["client_payout"] == "2500000", "deal 5: 2.5 USDC each");

    // ------------------------------------------------------------ solvency
    r.section("Accounting");
    let cfg = e.view(&e.escrow, "get_config", json!({})).await?;
    let liab: u128 = cfg["total_liabilities"].as_str().unwrap_or("0").parse()?;
    let orphans: u128 = cfg["orphan_amount"].as_str().unwrap_or("0").parse()?;
    let bal = e.balance(e.escrow.as_str()).await?;
    r.honest_check(
        "escrow balance covers every payout owed (liabilities + orphans <= balance)",
        liab + orphans <= bal && liab == bal,
        &format!("token balance {bal}, total_liabilities {liab} (= unpaid payouts + fees), orphans {orphans}"),
    );

    let fails = r.fails.borrow().clone();
    println!(
        "\nVERIFY_SANDBOX attacks_refused={}/{} honest_ok={}/{} failures={}",
        r.refused.get(),
        r.attacks.get(),
        r.ok.get(),
        r.honest.get(),
        fails.len()
    );
    assert!(fails.is_empty(), "judge failures: {fails:?}");
    let _ = (&e.payer, &e.arbiter);
    Ok(())
}

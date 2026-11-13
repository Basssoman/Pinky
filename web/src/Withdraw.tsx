// Withdraw: send your share to any address on any chain, or to the private
// NEAR Intents balance of the person's own NEAR account (withdraw screen).
// That account is required: the deal key alone cannot move an intents balance
// (an open question). The withdraw is signed only after the payout quote
// passed every browser-side check (lib/flows.ts withdraw).
import { useState } from 'react';
import { useT } from './i18n';
import { coinsOn, networksOf, PRIVATE_BALANCE, type Coin, type CoinNetwork } from './lib/tokens';
import { Chips, hintFor, Problem, useRun } from './ui';

export interface WithdrawChoice {
  coin: Coin;
  network: CoinNetwork;
  address: string;
}

export function Withdraw(props: {
  /** Withdrawable now, USDC as text. */
  amount: string;
  /** null while the list is loading. */
  coins: Coin[] | null;
  /** A withdrawal of this key is on its way (from the chain). */
  pending?: boolean;
  onWithdraw: (choice: WithdrawChoice) => Promise<void> | void;
  network?: string;
}) {
  const { amount } = props;
  const coins = props.coins ?? [];
  const [symbol, setSymbol] = useState('');
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [sent, setSent] = useState<WithdrawChoice | null>(null);
  const sending = useRun();
  const tt = useT();
  const t = tt.withdraw;

  // Network first, then the coins on it; by default USDC on its first network.
  const nets = networksOf(coins);
  const usdc = coins.find((c) => c.symbol === 'USDC');
  const netName = (nets.find((n) => n.name === name) ?? usdc?.networks[0] ?? nets[0])?.name ?? '';
  const onNet = coinsOn(coins, netName);
  const coin = onNet.find((c) => c.symbol === symbol) ?? onNet.find((c) => c.symbol === 'USDC') ?? onNet[0];
  const network = coin?.networks.find((n) => n.name === netName);
  const isPrivate = network?.private === true;

  if (sent || props.pending) {
    return (
      <div className="panel">
        <p className="panel-title">{t.onItsWay}</p>
        <p className="hint">
          {sent
            ? sent.network.private
              ? t.sentPrivate(amount, sent.coin.symbol, sent.address)
              : t.sentOn(amount, sent.coin.symbol, sent.network.name)
            : t.leftSafe}
        </p>
      </div>
    );
  }

  if (props.coins === null) {
    return (
      <div className="panel">
        <p className="panel-title">{t.title(amount)}</p>
        <p className="hint" role="status">
          {t.loadingCoins}
        </p>
      </div>
    );
  }
  if (!coin || !network) {
    return (
      <div className="panel">
        <p className="panel-title">{t.title(amount)}</p>
        <p className="alert alert-inline" role="alert">
          {tt.pay.coinsFailed}
        </p>
      </div>
    );
  }

  const go = () =>
    sending.run(async () => {
      const choice = { coin, network, address: address.trim() };
      await props.onWithdraw(choice);
      setSent(choice);
    });

  return (
    <div className="panel">
      <p className="panel-title">{t.title(amount)}</p>
      <div className="pay-form">
        <Chips
          label={t.network}
          options={nets.map((n) => n.name)}
          value={network.name}
          onChange={setName}
          name={(n) => (n === PRIVATE_BALANCE ? t.privateBalance : n)}
        />
        <Chips label={t.getAs} options={onNet.map((c) => c.symbol)} value={coin.symbol} onChange={setSymbol} />
        {isPrivate && <p className="hint">{t.privateHint}</p>}
        <label className="field">
          <span className="field-label">{isPrivate ? t.nearAccount : t.addressOn(network.name)}</span>
          <input
            type="text"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder={isPrivate ? 'name.near' : hintFor(network.code)}
            autoComplete="off"
            spellCheck={false}
          />
          <span className="hint">
            {isPrivate ? t.privateCheck : t.addressCheck}
          </span>
        </label>
        <Problem error={sending.error} network={props.network} />
        <div className="actions">
          <button className="cta cta-inline" type="button" disabled={address.trim().length < 2 || sending.busy} onClick={go}>
            {sending.busy ? t.sending : t.send}
          </button>
        </div>
      </div>
    </div>
  );
}

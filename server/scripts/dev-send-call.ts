// Dev stack only: sends a ready `act` call (the one the site shows under
// "Server not responding? Send it yourself") from an ordinary sandbox
// account, to show that the contract takes it from anyone.
//
// Usage (WSL, while scripts/devstack.sh runs):
//   node dist/scripts/dev-send-call.js '<the arguments JSON copied from the page>'

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Account, JsonRpcProvider, teraToGas, type KeyPairString } from 'near-api-js';

const HOME = process.env.DEVSTACK_HOME || `${process.env.HOME}/kept-devstack`;
const info = JSON.parse(readFileSync(join(HOME, 'devstack.json'), 'utf8')) as { rpcUrl: string; contractId: string; payoutAccounts: string[] };
const key = (JSON.parse(readFileSync(join(HOME, 'chain', 'validator_key.json'), 'utf8')) as { secret_key: string }).secret_key;
const args = JSON.parse(process.argv[2] ?? '') as { deal_id: number; action: string; payload: string; signature: string };

const sender = new Account(info.payoutAccounts[0], new JsonRpcProvider({ url: info.rpcUrl }), key as KeyPairString);
const withdraw = args.action === 'withdraw';
await sender.callFunction({
  contractId: info.contractId,
  methodName: 'act',
  args,
  gas: teraToGas(withdraw ? 150 : 30),
  deposit: withdraw ? 2_250_000_000_000_000_000_000n : 0n,
});
const deal = (await new JsonRpcProvider({ url: info.rpcUrl }).callFunction({ contractId: info.contractId, method: 'get_deal', args: { deal_id: args.deal_id } })) as { state: string };
console.log(`sent "${args.action}" for deal ${args.deal_id} from ${sender.accountId}; the deal is now ${deal.state}`);

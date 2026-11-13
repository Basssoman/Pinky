// Entry point: `npm start` (Node >= 22.13, uses built-in TS type stripping).

import { buildApp } from './app.ts';
import { NearChain } from './chain.ts';
import { alignWithContract, assertRunnable, describeConfig, loadEnvFiles, readConfig, type ContractLimits } from './config.ts';
import { OneClickClient } from './oneclick.ts';
import { SqliteStore } from './store.ts';

loadEnvFiles();
const config = readConfig();
assertRunnable(config);

const chain = new NearChain({
  rpcUrl: config.rpcUrl,
  rpcSendUrl: config.rpcSendUrl,
  sendTimeoutMs: config.relayerSendTimeoutSeconds * 1000,
  contractId: config.contractId,
  relayerAccountId: config.relayerAccountId,
  relayerPrivateKey: config.relayerPrivateKey,
});
// The server never accepts offers the deployed contract would refuse.
let aligned: string[] = [];
try {
  aligned = alignWithContract(config, await chain.view<ContractLimits>('get_config', {}));
} catch {
  aligned = ['could not read the contract config; using the env limits'];
}
const oneClick = new OneClickClient({ baseUrl: config.oneClickBaseUrl, apiKey: config.oneClickApiKey });
const store = new SqliteStore(config.dbPath);

const app = await buildApp({
  config,
  chain,
  oneClick,
  store,
  // Default request logs contain method/url/status only, never bodies or headers.
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
});

app.log.info(describeConfig(config), 'config');
if (aligned.length) app.log.warn({ aligned }, 'server limits aligned with the contract');
await app.listen({ port: config.port, host: config.host });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void app.close().then(() => {
      store.close();
      process.exit(0);
    });
  });
}

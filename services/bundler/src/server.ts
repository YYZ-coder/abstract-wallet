import { resolve } from 'node:path';
import type { Address, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createBundler } from './bundler.js';
import { createViemAdapter } from './runtime.js';
import { createBundlerHttpServer } from './http.js';

async function main() {
  if (process.env.BUNDLER_ENV_FILE) process.loadEnvFile(process.env.BUNDLER_ENV_FILE);
  const env = process.env;
  if (env.CHAIN_ID && env.CHAIN_ID !== '421614') throw new Error('TESTNET_ONLY');
  if (!env.RPC_URL || !env.ENTRY_POINT || !env.DELEGATE) throw new Error('MISSING_RPC_OR_DEPLOYMENT');
  if (!env.ENTRY_POINT_CODE_HASH || !env.DELEGATE_CODE_HASH || (env.PAYMASTER && !env.PAYMASTER_CODE_HASH)) throw new Error('MISSING_DEPLOYMENT_CODE_HASH');
  if (!/^0x[0-9a-fA-F]{64}$/.test(env.BUNDLER_PRIVATE_KEY ?? '')) throw new Error('INVALID_BUNDLER_PRIVATE_KEY');
  let account;
  try { account = privateKeyToAccount(env.BUNDLER_PRIVATE_KEY as Hex); } catch { throw new Error('INVALID_BUNDLER_PRIVATE_KEY'); }
  const adapter = createViemAdapter({ rpcUrl: env.RPC_URL, entryPoint: env.ENTRY_POINT as Address, delegate: env.DELEGATE as Address, account });
  const service = createBundler({ chainId: 421614, entryPoint: env.ENTRY_POINT as Address, delegate: env.DELEGATE as Address, ...(env.PAYMASTER ? { paymaster: env.PAYMASTER as Address } : {}), beneficiary: account.address, adapter,
    statePath: env.BUNDLER_STATE_PATH ?? resolve('.secrets/bundler-state-421614.json'),
    expectedCodeHashes: { entryPoint: env.ENTRY_POINT_CODE_HASH as Hex, delegate: env.DELEGATE_CODE_HASH as Hex, ...(env.PAYMASTER_CODE_HASH ? { paymaster: env.PAYMASTER_CODE_HASH as Hex } : {}) },
    maxOuterGas: BigInt(env.BUNDLER_MAX_OUTER_GAS ?? '5000000'), maxFeePerGas: BigInt(env.BUNDLER_MAX_FEE_PER_GAS ?? '20000000000') });
  const ready = await service.handle({ jsonrpc:'2.0',id:0,method:'eth_supportedEntryPoints',params:[] });
  if (ready.error) throw new Error(ready.error.message);
  const origins = env.WALLET_ORIGINS?.split(',').map(value=>value.trim());
  const server = createBundlerHttpServer(service.handle, origins);
  server.listen(4337,'127.0.0.1',()=>console.log('Development Bundler listening on http://127.0.0.1:4337 for chain 421614'));
  server.on('error',()=>{ console.error('BUNDLER_LISTEN_FAILED'); process.exitCode=1; });
  process.once('SIGTERM',()=>server.close()); process.once('SIGINT',()=>server.close());
}
main().catch(error=>{ console.error(`Bundler startup failed: ${error instanceof Error ? error.message : 'UNKNOWN'}`); process.exitCode=1; });

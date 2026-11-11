import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createPublicClient, createWalletClient, defineChain, http, keccak256, parseEther, type Hex } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';

// Published fixture keys are restricted to this fixed local endpoint and Anvil client.
const rpcUrl = 'http://127.0.0.1:9545';
const chain = defineChain({ id: 421614, name: 'Local Prague fixture', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
const client = createPublicClient({ chain, transport: http(rpcUrl) });
assert.equal(await client.getChainId(), 421614);
assert.match(await client.request({ method: 'web3_clientVersion' }), /anvil/i);
const funder = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const wallet = createWalletClient({ chain, account: funder, transport: http(rpcUrl) });
const fixtureKey = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;
const sponsor = privateKeyToAccount(fixtureKey(2));
const relayer = privateKeyToAccount(fixtureKey(3));
const user = privateKeyToAccount(fixtureKey(6));
fs.mkdirSync('.secrets', { recursive: true, mode: 0o700 });
const keyFile = '.secrets/local-bundler-key';
if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, generatePrivateKey(), { mode: 0o600 });
const bundlerKey = fs.readFileSync(keyFile, 'utf8').trim() as Hex;
const bundler = privateKeyToAccount(bundlerKey);
const artifact = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));
const epArtifact = artifact('integration/out/EntryPoint.sol/EntryPoint.json');
const dArtifact = artifact('contracts/out/WalletDelegate.sol/WalletDelegate.json');
const pArtifact = artifact('contracts/out/SignaturePaymaster.sol/SignaturePaymaster.json');
async function confirmed(hash: Hex) { const r = await client.waitForTransactionReceipt({ hash }); assert.equal(r.status, 'success'); return r; }
async function deploy(a: any, args: readonly unknown[] = []) { const r = await confirmed(await wallet.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args })); assert.ok(r.contractAddress); return { address: r.contractAddress, block: r.blockNumber, hash: r.transactionHash }; }
for (const [address, amount] of [[bundler.address, '1'], [relayer.address, '1'], [user.address, '0.1']] as const) {
  if (await client.getBalance({ address }) < parseEther(amount)) await confirmed(await wallet.sendTransaction({ to: address, value: parseEther(amount) }));
}
const ep = await deploy(epArtifact), d = await deploy(dArtifact, [ep.address]), pm = await deploy(pArtifact, [ep.address, sponsor.address, funder.address]);
await confirmed(await wallet.writeContract({ address: pm.address, abi: pArtifact.abi, functionName: 'deposit', value: parseEther('0.5') }));
const hashes = { ep: keccak256((await client.getCode({ address: ep.address }))!), d: keccak256((await client.getCode({ address: d.address }))!), pm: keccak256((await client.getCode({ address: pm.address }))!) };
const deployment = (version: string, address: string, runtimeCodeHash: string) => ({ version, address: address.toLowerCase(), runtimeCodeHash, verified: true });
const manifest = { schemaVersion: '1', manifestVersion: 'local-prague-mvp-v1', chainId: '421614', name: 'Local Prague fixture (not public Arbitrum Sepolia)', nativeCurrency: { symbol: 'ETH', decimals: '18' }, capabilityStatus: 'unverified',
  entryPoint: deployment('v0.9.0', ep.address, hashes.ep), delegate: deployment('v1', d.address, hashes.d), paymaster: deployment('v1', pm.address, hashes.pm), rpcEndpoints: [{ id: 'local-anvil', url: rpcUrl, verified: true }], bundlerEndpoints: [{ id: 'local-development', url: 'http://127.0.0.1:4337', verified: false, supportedEntryPointVersions: ['v0.9.0'] }],
  feeModel: { policyId: 'local-upper-bound-v1', status: 'draft', nativeCostUnit: 'wei', components: [] }, confirmationPolicy: { policyId: 'local-canonical-1-v1', status: 'frozen', description: 'Local canonical block with one confirmation only. This is not Arbitrum L1 finality.', requiredConfirmations: '1' }, relay: { mode: 'backend_relayer', supported: true, verified: false, maxNativeCost: '5000000000000000' } };
fs.mkdirSync('deployments/local', { recursive: true });
fs.writeFileSync('deployments/local/manifest.json', JSON.stringify(manifest, null, 2) + '\n');
fs.writeFileSync('deployments/local/deployments.json', JSON.stringify({ network: 'local-anvil-prague', publicTestnet: false, ep, d, pm, sponsor: sponsor.address, relayer: relayer.address, bundler: bundler.address, fixtureUser: user.address }, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2) + '\n');
const runtime = { authDomain: '127.0.0.1:5173', authUri: 'http://127.0.0.1:5173', mode: 'local', chainId: 421614, rpcUrl: '/rpc', bundlerUrl: '/bundler', backendBaseUrl: '/api', entryPoint: ep.address, delegate: d.address, paymaster: pm.address, entryPointCodeHash: hashes.ep, delegateCodeHash: hashes.d, paymasterCodeHash: hashes.pm, sponsorSigner: sponsor.address, manifestVersion: manifest.manifestVersion };
fs.mkdirSync('apps/wallet/public', { recursive: true });
fs.writeFileSync('apps/wallet/public/runtime-network.json', JSON.stringify(runtime, null, 2) + '\n');
function envFile(file: string, env: Record<string, string>) { fs.writeFileSync(file, Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 }); }
envFile('.secrets/local-bundler.env', { CHAIN_ID: '421614', RPC_URL: rpcUrl, ENTRY_POINT: ep.address, DELEGATE: d.address, PAYMASTER: pm.address, ENTRY_POINT_CODE_HASH: hashes.ep, DELEGATE_CODE_HASH: hashes.d, PAYMASTER_CODE_HASH: hashes.pm, BUNDLER_PRIVATE_KEY: bundlerKey, BUNDLER_STATE_PATH: path.resolve('.secrets/bundler-local-state.json'), WALLET_ORIGINS: 'http://127.0.0.1:5173' });
const stateKeyFile = '.secrets/local-state-key';
if (!fs.existsSync(stateKeyFile)) fs.writeFileSync(stateKeyFile, randomBytes(32).toString('hex'), { mode: 0o600 });
envFile('.secrets/local-api.env', { WALLET_API_LISTEN: '127.0.0.1:8787', WALLET_DOMAIN: '127.0.0.1:5173', WALLET_URI: 'http://127.0.0.1:5173', WALLET_PROJECT_ID: 'abstract_wallet_mvp', WALLET_SCHEMA_PATH: path.resolve('protocol/openapi.v1.json'), WALLET_MANIFEST_PATH: path.resolve('deployments/local/manifest.json'), WALLET_RPC_URL: rpcUrl, WALLET_ALLOWED_ORIGIN: 'http://127.0.0.1:5173', SPONSORSHIP_DATABASE_URL: 'postgres://wallet_test:wallet_test_only@127.0.0.1:55432/wallet_mvp?sslmode=disable', SPONSORSHIP_STATE_KEY: fs.readFileSync(stateKeyFile, 'utf8'), SPONSORSHIP_NAMESPACE: `local-${ep.address.toLowerCase()}`, SPONSOR_ACCOUNT_POLICY: 'authenticated', SPONSOR_PRIVATE_KEY: fixtureKey(2), SPONSOR_ALLOWED_ACCOUNTS: user.address.toLowerCase(), PER_USER_BUDGET_WEI: parseEther('0.1').toString(), CHAIN_BUDGET_WEI: parseEther('0.2').toString(), MAX_SPONSOR_COST_WEI: parseEther('0.005').toString(), BUDGET_PERIOD: 'local-fixture', WALLET_INDEXER_START_BLOCK: ep.block.toString(), RELAY_PRIVATE_KEY: fixtureKey(3), RELAY_ALLOWED_ACCOUNTS: user.address.toLowerCase(), MAX_RELAY_COST_WEI: parseEther('0.005').toString(), RELAY_USER_BUDGET_WEI: parseEther('0.02').toString(), RELAY_CHAIN_BUDGET_WEI: parseEther('0.05').toString() });
console.log(JSON.stringify({ status: 'ready', network: 'local-anvil-only', manifest: 'deployments/local/manifest.json', fixtureUser: user.address, entryPoint: ep.address, delegate: d.address, paymaster: pm.address }));

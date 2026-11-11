import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createPublicClient, createWalletClient, defineChain, http, decodeEventLog, keccak256, parseEther, zeroAddress, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { entryPoint09Abi } from 'viem/account-abstraction';
import { createBrowserServices, type RuntimeNetwork } from '../apps/wallet/src/browser-services.js';
import type { WalletHost, WalletProvider } from '../apps/wallet/src/external-wallet.js';
import { createBundler } from '../services/bundler/src/bundler.js';
import { createViemAdapter } from '../services/bundler/src/runtime.js';
import { createBundlerHttpServer } from '../services/bundler/src/http.js';

// Published fixture keys and fixed loopback only. Never load a user's root key.
const rpcUrl = 'http://127.0.0.1:9545';
const bundlerUrl = 'http://127.0.0.1:14337';
const backendBaseUrl = 'http://127.0.0.1:18787';
const chain = defineChain({ id: 421614, name: 'Local Prague external-provider fixture', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
const client = createPublicClient({ chain, transport: http(rpcUrl) });
const publicKey = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;
const authority = privateKeyToAccount(publicKey(12));
const bundlerAccount = privateKeyToAccount(publicKey(14));
const sponsor = privateKeyToAccount(publicKey(2));
const funder = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const recipient = '0x1212121212121212121212121212121212121212' as Address;
const wallet = createWalletClient({ chain, account: funder, transport: http(rpcUrl) });
const nativeAuthority = createWalletClient({ chain, account: authority, transport: http(rpcUrl) });
const manifest = JSON.parse(fs.readFileSync('deployments/local/manifest.json', 'utf8'));
const runtime: RuntimeNetwork = {
  mode: 'local', chainId: 421614, rpcUrl, bundlerUrl, backendBaseUrl,
  entryPoint: manifest.entryPoint.address, delegate: manifest.delegate.address, paymaster: manifest.paymaster.address,
  entryPointCodeHash: manifest.entryPoint.runtimeCodeHash, delegateCodeHash: manifest.delegate.runtimeCodeHash, paymasterCodeHash: manifest.paymaster.runtimeCodeHash,
  sponsorSigner: sponsor.address, manifestVersion: manifest.manifestVersion,
  authDomain: '127.0.0.1:5173', authUri: 'http://127.0.0.1:5173',
};
const sourceFiles = ['scripts/external-wallet-integration.ts','apps/wallet/src/external-wallet.ts','apps/wallet/src/browser-services.ts','packages/sdk/src/index.ts','services/bundler/src/bundler.ts','services/bundler/src/runtime.ts','services/bundler/src/http.ts',
  ...fs.readdirSync('services/sponsorship').filter(file => file.endsWith('.go') && !file.endsWith('_test.go')).map(file => `services/sponsorship/${file}`), 'services/sponsorship/cmd/server/main.go','deployments/local/manifest.json'];
const hashes = () => Object.fromEntries(sourceFiles.map(file => [file, createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
const report: Record<string, any> = {
  startedAt: new Date().toISOString(), command: 'npx tsx scripts/external-wallet-integration.ts',
  kind: 'actual_http_evm_integration_with_eip1193_system_boundary_fixture', network: 'local-anvil-prague', publicTestnet: false,
  chainId: 421614, rpcUrl, bundlerUrl, backendBaseUrl, account: authority.address, recipient,
  providerFixtureIsRealWalletBrand: false, privateUserKeyLoaded: false, evmEtchOrFakeReceipt: false,
  sourceHashesBefore: hashes(), checks: [], status: 'running',
};
const evidence = 'evidence/integration/external-wallet-local.json';
const save = () => { fs.mkdirSync(path.dirname(evidence), { recursive: true }); fs.writeFileSync(evidence, JSON.stringify(report, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2) + '\n'); };
const parseEnv = (file: string) => Object.fromEntries(fs.readFileSync(file, 'utf8').split('\n').filter(line => line && !line.startsWith('#')).map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
let api: ChildProcess | undefined;
let apiLog = '';
let bundlerServer: ReturnType<typeof createBundlerHttpServer> | undefined;
// Node controls the browser public-record storage boundary explicitly.
// This process-local Map does not prove persistence across processes or page reloads.
const publicRecordValues = new Map<string, string>();
const publicRecordStorage = {
  getItem: (key: string) => publicRecordValues.get(key) ?? null,
  setItem: (key: string, value: string) => { publicRecordValues.set(key, value); },
};
let services: ReturnType<typeof createBrowserServices> | undefined;
let token = '';
const providerMethods: string[] = [], httpObservations: any[] = [], permitRecords: any[] = [];

async function confirmed(hash: Hex) { const r = await client.waitForTransactionReceipt({ hash }); assert.equal(r.status, 'success'); return r; }
async function snapshot() {
  const [native, recipientNative, accountDeposit, paymasterDeposit, eoaNonce, entryPointNonce, code] = await Promise.all([
    client.getBalance({ address: authority.address }), client.getBalance({ address: recipient }),
    client.readContract({ address: runtime.entryPoint!, abi: entryPoint09Abi, functionName: 'balanceOf', args: [authority.address] }),
    client.readContract({ address: runtime.entryPoint!, abi: entryPoint09Abi, functionName: 'balanceOf', args: [runtime.paymaster!] }),
    client.getTransactionCount({ address: authority.address }),
    client.readContract({ address: runtime.entryPoint!, abi: entryPoint09Abi, functionName: 'getNonce', args: [authority.address, 0n] }),
    client.getCode({ address: authority.address }),
  ]);
  return { native, recipientNative, accountDeposit, paymasterDeposit, eoaNonce, entryPointNonce, code: code ?? '0x' };
}
async function awaitAPI() {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (api?.exitCode !== null) throw new Error(`Isolated API exited before ready: ${apiLog.slice(-500)}`);
    try { const response = await fetch(`${backendBaseUrl}/v1/chains`, { signal: AbortSignal.timeout(700) }); if (response.ok) return; } catch { /* Wait only for the isolated service we started. */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('Isolated API did not become ready');
}
async function chainProof(hash: string) {
  let state;
  for (let attempt = 0; attempt < 30; attempt++) {
    state = await services!.status(hash);
    if (state.execution !== 'unknown') break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.equal(state?.execution, 'succeeded');
  const response = await fetch(bundlerUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'eth_getUserOperationReceipt', params: [hash] }) });
  const hint = (await response.json()).result;
  const receipt = await client.getTransactionReceipt({ hash: hint.receipt.transactionHash });
  assert.equal(receipt.status, 'success');
  const events = receipt.logs.flatMap(log => {
    if (log.address.toLowerCase() !== runtime.entryPoint!.toLowerCase()) return [];
    try { const parsed = decodeEventLog({ abi: entryPoint09Abi, topics: log.topics, data: log.data }); return parsed.eventName === 'UserOperationEvent' && parsed.args.userOpHash.toLowerCase() === hash.toLowerCase() ? [parsed.args] : []; } catch { return []; }
  });
  assert.equal(events.length, 1); assert.equal(events[0].success, true); assert.equal(events[0].sender.toLowerCase(), authority.address.toLowerCase());
  return { state, receipt: { transactionHash: receipt.transactionHash, blockHash: receipt.blockHash, blockNumber: receipt.blockNumber, type: receipt.type }, event: events[0] };
}

async function main() {
  assert.equal(new URL(rpcUrl).hostname, '127.0.0.1');
  assert.equal(await client.getChainId(), 421614);
  assert.match(await client.request({ method: 'web3_clientVersion' }), /anvil/i, 'Published fixture keys must never touch a public network');
  for (const key of ['entryPoint','delegate','paymaster'] as const) {
    const code = await client.getCode({ address: runtime[key]! });
    assert.ok(code); assert.equal(keccak256(code), manifest[key].runtimeCodeHash);
  }
  await client.request({ method: 'evm_mine' as any });
  for (const [address, value] of [[authority.address, parseEther('0.1')], [bundlerAccount.address, parseEther('0.5')]] as const) {
    const balance = await client.getBalance({ address });
    if (balance < value) await confirmed(await wallet.sendTransaction({ to: address, value: value - balance }));
  }
  const existingCode = (await client.getCode({ address: authority.address })) ?? '0x';
  if (existingCode !== '0x') {
    assert.equal(existingCode.toLowerCase(), `0xef0100${runtime.delegate!.slice(2).toLowerCase()}`, 'Never modify a fixture delegated to an unrelated implementation');
    const nonce = await client.getTransactionCount({ address: authority.address });
    const auth = await nativeAuthority.signAuthorization({ contractAddress: zeroAddress, nonce: nonce + 1, executor: 'self' });
    const receipt = await confirmed(await nativeAuthority.sendTransaction({ to: zeroAddress, value: 0n, data: '0x', authorizationList: [auth] }));
    report.fixtureReset = { mechanism: 'genuine native type4 by the published fixture root, not an EVM state override', transactionHash: receipt.transactionHash, blockNumber: receipt.blockNumber, type: receipt.type };
  }
  const initialCode = (await client.getCode({ address: authority.address })) ?? '0x';
  assert.equal(initialCode, '0x', 'Use an undelegated fixture EOA; never etch it empty');
  const context = createBundler({ chainId: 421614, entryPoint: runtime.entryPoint!, delegate: runtime.delegate!, paymaster: runtime.paymaster!, beneficiary: bundlerAccount.address,
    adapter: createViemAdapter({ rpcUrl, entryPoint: runtime.entryPoint!, delegate: runtime.delegate!, account: bundlerAccount }),
    statePath: path.resolve(`.secrets/external-bundler-${randomUUID()}.json`),
    expectedCodeHashes: { entryPoint: runtime.entryPointCodeHash!, delegate: runtime.delegateCodeHash!, paymaster: runtime.paymasterCodeHash! } });
  bundlerServer = createBundlerHttpServer(context.handle);
  bundlerServer.listen(14337, '127.0.0.1'); await once(bundlerServer, 'listening');
  const env = parseEnv('.secrets/local-api.env');
  assert.equal(env.SPONSOR_PRIVATE_KEY, publicKey(2), 'Only the known local fixture sponsor key is accepted');
  const allowlisted = privateKeyToAccount(publicKey(6)).address.toLowerCase();
  assert.ok(env.SPONSOR_ALLOWED_ACCOUNTS.toLowerCase().split(',').includes(allowlisted));
  assert.ok(!env.SPONSOR_ALLOWED_ACCOUNTS.toLowerCase().split(',').includes(authority.address.toLowerCase()));
  Object.assign(env, { SPONSOR_ACCOUNT_POLICY: 'authenticated', WALLET_API_LISTEN: '127.0.0.1:18787', SPONSORSHIP_NAMESPACE: `external-fixture-${randomUUID()}`, WALLET_DOMAIN: runtime.authDomain, WALLET_URI: runtime.authUri });
  for (const key of ['PER_USER_BUDGET_WEI','CHAIN_BUDGET_WEI','MAX_SPONSOR_COST_WEI']) assert.ok(BigInt(env[key]) > 0n && BigInt(env[key]) <= parseEther('1'), 'Explicit finite test budgets only');
  const envFile = '.secrets/external-integration-api.env';
  fs.writeFileSync(envFile, Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { mode: 0o600 }); fs.chmodSync(envFile, 0o600);
  api = spawn('python3', ['scripts/run-api.py', envFile], { cwd: process.cwd(), detached: true, stdio: ['ignore','pipe','pipe'] });
  api.stdout?.on('data', data => { apiLog += data.toString(); }); api.stderr?.on('data', data => { apiLog += data.toString(); });
  await awaitAPI();
  report.sponsorPolicy = { mode: 'authenticated', fixtureRootNotAllowlisted: true, preservedAllowlistedAccount: allowlisted, finiteBudgets: true, namespace: env.SPONSORSHIP_NAMESPACE };

  const provider: WalletProvider = {
    async request(args) {
      providerMethods.push(args.method);
      const params = args.params as any[] | undefined;
      if (args.method === 'eth_requestAccounts' || args.method === 'eth_accounts') return [authority.address];
      if (args.method === 'eth_chainId') return '0x66eee';
      if (args.method === 'eth_signTypedData_v4') { assert.equal(params?.[0].toLowerCase(), authority.address.toLowerCase()); return authority.signTypedData(JSON.parse(params![1])); }
      if (args.method === 'personal_sign') { assert.equal(params?.[1].toLowerCase(), authority.address.toLowerCase()); return authority.signMessage({ message: { raw: params![0] } }); }
      throw { code: 4200, message: 'The system-boundary fixture does not provide arbitrary authorization signing' };
    },
  };
  const host = Object.assign(new EventTarget(), { ethereum: provider }) as WalletHost;
  const observedFetch: typeof fetch = async (input, init) => {
    const response = await fetch(input, init); const url = String(input);
    if (url.startsWith(backendBaseUrl)) {
      const body = await response.clone().json();
      if (url.endsWith('/v1/auth/sessions') && body.accessToken) token = body.accessToken;
      if (url.endsWith('/v1/sponsorships') && body.permit) permitRecords.push(body);
      httpObservations.push({ path: new URL(url).pathname, status: response.status, state: body.state, code: body.code ?? body.error?.code });
    }
    return response;
  };
  services = createBrowserServices(runtime, { walletHost: host, fetch: observedFetch, storage: publicRecordStorage });
  const choices = await services.listWallets!(); assert.equal(choices.length, 1);
  const empty = await services.connectWallet!(choices[0].id);
  assert.equal(empty.address.toLowerCase(), authority.address.toLowerCase()); assert.equal(empty.availability?.canSubmit, false);
  await assert.rejects(services.preview({ recipient, amount: '0.00001', sponsored: false }), /7702/);
  assert.ok(providerMethods.every(method => ['eth_chainId','eth_accounts','eth_requestAccounts'].includes(method)));
  assert.equal((await client.getCode({ address: authority.address })) ?? '0x', '0x');
  report.checks.push({ name: 'undelegated_external_connection_preserves_address_and_refuses_unsupported_enablement', snapshot: empty, providerMethods: [...providerMethods] }); save();
  await services.disconnectWallet!();

  // Explicit fixture setup, outside the injected provider. This is a genuine native
  // type-4 authorization, not evidence of an arbitrary extension supporting 7702.
  const nonce = await client.getTransactionCount({ address: authority.address });
  const auth = await nativeAuthority.signAuthorization({ contractAddress: runtime.delegate!, nonce: nonce + 1, executor: 'self' });
  const setupReceipt = await confirmed(await nativeAuthority.sendTransaction({ to: zeroAddress, value: 0n, data: '0x', authorizationList: [auth] }));
  assert.equal(setupReceipt.type, 'eip7702');
  assert.equal((await client.getCode({ address: authority.address }))!.toLowerCase(), `0xef0100${runtime.delegate!.slice(2).toLowerCase()}`);
  report.authorizationSetup = { source: 'explicit native transaction using published fixture key, outside injected provider', transactionHash: setupReceipt.transactionHash, blockHash: setupReceipt.blockHash, blockNumber: setupReceipt.blockNumber, type: setupReceipt.type, account: authority.address };
  const enabled = await services.connectWallet!(choices[0].id);
  assert.equal(enabled.address.toLowerCase(), authority.address.toLowerCase()); assert.equal(enabled.availability?.canSubmit, true); assert.equal(enabled.availability?.canRevoke, false);
  for (const sponsored of [false, true]) {
    const amount = sponsored ? '0.00002' : '0.00001', value = parseEther(amount), before = await snapshot();
    const preview = await services.preview({ recipient, amount, sponsored });
    assert.equal(preview.payment, sponsored ? 'sponsored' : 'self');
    const submitted = await services.submit(preview); assert.equal(submitted.submission, 'accepted');
    const proof = await chainProof(submitted.hash), after = await snapshot();
    assert.equal(after.recipientNative - before.recipientNative, value); assert.equal(after.entryPointNonce, before.entryPointNonce + 1n);
    assert.equal(after.eoaNonce, before.eoaNonce); assert.equal(after.code, before.code);
    if (sponsored) {
      assert.equal(before.native - after.native, value); assert.equal(after.accountDeposit, before.accountDeposit);
      assert.equal(before.paymasterDeposit - after.paymasterDeposit, proof.event.actualGasCost);
      assert.equal(proof.event.paymaster.toLowerCase(), runtime.paymaster!.toLowerCase());
    } else {
      assert.equal(before.native + before.accountDeposit - after.native - after.accountDeposit, value + proof.event.actualGasCost);
      assert.equal(before.paymasterDeposit, after.paymasterDeposit);
    }
    report.checks.push({ name: sponsored ? 'non_allowlisted_authenticated_external_wallet_sponsored_operation' : 'external_wallet_typed_signature_selfpay_operation', before, preview, submitted, proof, after }); save();
  }
  assert.ok(token && permitRecords.length === 1); assert.ok(providerMethods.includes('personal_sign') && providerMethods.includes('eth_signTypedData_v4'));
  assert.ok(!providerMethods.some(method => ['eth_sign','eth_signAuthorization','eth_sendTransaction','eth_sendRawTransaction'].includes(method)));
  await client.request({ method: 'anvil_mine' as any, params: ['0x40','0x1'] as any });
  const sponsored = report.checks.at(-1);
  let budget: any;
  for (let attempt = 0; attempt < 20; attempt++) {
    const response = await fetch(`${backendBaseUrl}/v1/budgets?chainId=421614&period=${env.BUDGET_PERIOD}`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200); budget = await response.json();
    if (BigInt(budget.accountBudget.settledNative) === sponsored.proof.event.actualGasCost) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.equal(budget.accountBudget.settledNative, sponsored.proof.event.actualGasCost.toString());
  assert.equal(budget.accountBudget.pendingNative, '0'); assert.equal(budget.accountBudget.reservedRiskNative, '0');
  const operationResponse = await fetch(`${backendBaseUrl}/v1/operations/${sponsored.submitted.hash}?chainId=421614&entryPoint=${runtime.entryPoint!.toLowerCase()}`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(operationResponse.status, 200); const operation = await operationResponse.json();
  assert.equal(operation.executionState, 'succeeded'); assert.equal(operation.fee.entryPointCostNative, sponsored.proof.event.actualGasCost.toString());
  report.budget = budget; report.operation = operation; report.permits = permitRecords.map(record => ({ sponsorshipId: record.sponsorshipId, permitDigest: record.permit.permitDigest, maxCost: record.permit.maxCost }));
  report.checks.push({ name: 'actual_rpc_indexer_postgres_finalized_cost_and_risk_release', actualCost: sponsored.proof.event.actualGasCost, finalizedBlock: (await client.getBlock({ blockTag: 'finalized' })).number });
  await services.disconnectWallet!();
  assert.ok(publicRecordValues.size > 0, 'Successful submissions must save their public record at the storage boundary');
  const publicRecords = [...publicRecordValues.values()].map(raw => {
    const record = JSON.parse(raw);
    assert.deepEqual(Object.keys(record).sort(), ['address', 'chainId', 'hash', 'schemaVersion']);
    assert.equal(record.schemaVersion, '1'); assert.equal(record.chainId, '421614');
    assert.equal(record.address, authority.address.toLowerCase()); assert.match(record.hash, /^0x[0-9a-f]{64}$/);
    return record;
  });
  report.publicRecordStorage = { kind: 'Node browser-storage boundary fixture', implementation: 'process-local Map', crossProcessPersistenceProven: false, payloadKeys: ['address', 'chainId', 'hash', 'schemaVersion'], records: publicRecords, privateKeyPersistedInPublicRecord: false };
  report.status = 'passed'; report.completedAt = new Date().toISOString();
}

try { await main(); }
catch (error) { report.status = 'failed'; report.error = error instanceof Error ? error.message : String(error); process.exitCode = 1; }
finally {
  await services?.disconnectWallet?.().catch(() => {});
  if (bundlerServer?.listening) await new Promise<void>(resolve => { bundlerServer!.close(() => resolve()); bundlerServer!.closeAllConnections(); });
  if (api?.pid) {
    try { process.kill(-api.pid, 'SIGTERM'); } catch { /* The isolated child may already have exited. */ }
    await Promise.race([once(api, 'exit').catch(() => {}), new Promise(resolve => setTimeout(resolve, 1000))]);
    try { process.kill(-api.pid, 'SIGKILL'); } catch { /* Only the process group created by this script is addressed. */ }
  }
  report.providerMethods = providerMethods; report.httpObservations = httpObservations; report.sourceHashesAfter = hashes();
  report.sourceHashesUnchanged = JSON.stringify(report.sourceHashesBefore) === JSON.stringify(report.sourceHashesAfter);
  report.cleanup = { isolatedBundlerClosed: !bundlerServer?.listening, isolatedApiStopped: true, publicPortsUntouched: [4337,8787,5173], sharedLocalPortsKept: [9545,55432] };
  save();
}
console.log(JSON.stringify({ status: report.status, checks: report.checks.map((check: any) => check.name), sourceHashesUnchanged: report.sourceHashesUnchanged, report: evidence, error: report.error }));

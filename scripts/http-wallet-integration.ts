import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createPublicClient, defineChain, http, decodeEventLog, parseEther, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { entryPoint09Abi } from 'viem/account-abstraction';
import { createBrowserServices, type RuntimeNetwork } from '../apps/wallet/src/browser-services.js';

const mode = process.argv[2] ?? 'local';
assert.ok(mode === 'local' || mode === 'arb', 'Choose local or arb explicitly');
const local = mode === 'local';
const base = local ? 'deployments/local' : 'deployments/arbitrum-sepolia';
const manifest = JSON.parse(fs.readFileSync(`${base}/manifest.json`, 'utf8'));
const rpcUrl = local ? 'http://127.0.0.1:9545' : 'https://sepolia-rollup.arbitrum.io/rpc';
const runtime: RuntimeNetwork = { mode: local ? 'local' : 'arbitrum-sepolia', chainId: 421614, rpcUrl, bundlerUrl: 'http://127.0.0.1:4337', backendBaseUrl: 'http://127.0.0.1:8787', entryPoint: manifest.entryPoint.address, delegate: manifest.delegate.address, paymaster: manifest.paymaster.address, entryPointCodeHash: manifest.entryPoint.runtimeCodeHash, delegateCodeHash: manifest.delegate.runtimeCodeHash, paymasterCodeHash: manifest.paymaster.runtimeCodeHash, sponsorSigner: local ? privateKeyToAccount(`0x${'2'.padStart(64, '0')}`).address : JSON.parse(fs.readFileSync('deployments/arbitrum-sepolia/accounts.json','utf8')).sponsor.address, manifestVersion: manifest.manifestVersion, authDomain: '127.0.0.1:5173', authUri: 'http://127.0.0.1:5173' };
const chain = defineChain({ id: 421614, name: local ? 'Local fixture' : 'Arbitrum Sepolia', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
const client = createPublicClient({ chain, transport: http(rpcUrl, { fetchOptions: { headers: { 'User-Agent': 'Mozilla/5.0' } } }) });
assert.equal(await client.getChainId(), 421614);
if (local) { assert.match(await client.request({ method: 'web3_clientVersion' }), /anvil/i); await client.request({ method: 'evm_mine' as any }); }
const testKey = local ? `0x${'6'.padStart(64, '0')}` as Hex : fs.readFileSync('.secrets/test-user.env', 'utf8').match(/^PRIVATE_KEY=(0x[0-9a-fA-F]{64})/m)![1] as Hex;
const authority = privateKeyToAccount(testKey);
const recipient = '0x7777777777777777777777777777777777777777' as Address;
const config = { ...runtime, rpcUrl, bundlerUrl: 'http://127.0.0.1:4337', backendBaseUrl: 'http://127.0.0.1:8787' };
let token = '';
const permits: any[] = [], httpObservations: any[] = [];
const fetchObserved: typeof fetch = async (input, init) => {
  const response = await fetch(input, init);
  const url = String(input);
  if (url.includes(':8787')) {
    const body = await response.clone().json();
    if (url.endsWith('/v1/auth/sessions') && body.accessToken) token = body.accessToken;
    if (url.endsWith('/v1/sponsorships') && body.permit) permits.push(body);
    httpObservations.push({ path: new URL(url).pathname, status: response.status, code: body.code ?? body.error?.code, state: body.state });
  }
  return response;
};
// Node controls the browser public-record storage boundary explicitly.
// This process-local Map does not prove persistence across processes or page reloads.
const publicRecordValues = new Map<string, string>();
const publicRecordStorage = {
  getItem: (key: string) => publicRecordValues.get(key) ?? null,
  setItem: (key: string, value: string) => { publicRecordValues.set(key, value); },
};
const services = createBrowserServices(config, { fetch: fetchObserved, accountFactory: () => authority, storage: publicRecordStorage });
const report: Record<string, any> = { startedAt: new Date().toISOString(), kind: 'actual_http_integration_first_pass_or_regression', network: local ? 'local-anvil-prague' : 'arbitrum-sepolia', publicTestnet: !local, chainId: 421614, manifestVersion: manifest.manifestVersion, account: authority.address, recipient, checks: [], status: 'running' };
const reportPath = `evidence/integration/${local ? 'local' : 'arbitrum-sepolia'}-http-wallet.json`;
const save = () => fs.writeFileSync(reportPath, JSON.stringify(report, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2) + '\n');
async function snapshot() {
  const [native, recipientBalance, accountDeposit, paymasterDeposit, eoaNonce, entryPointNonce, code] = await Promise.all([
    client.getBalance({ address: authority.address }), client.getBalance({ address: recipient }),
    client.readContract({ address: runtime.entryPoint!, abi: entryPoint09Abi, functionName: 'balanceOf', args: [authority.address] }),
    client.readContract({ address: runtime.entryPoint!, abi: entryPoint09Abi, functionName: 'balanceOf', args: [runtime.paymaster!] }),
    client.getTransactionCount({ address: authority.address }),
    client.readContract({ address: runtime.entryPoint!, abi: entryPoint09Abi, functionName: 'getNonce', args: [authority.address, 0n] }),
    client.getCode({ address: authority.address }),
  ]);
  return { native, recipientBalance, accountDeposit, paymasterDeposit, eoaNonce, entryPointNonce, code: code ?? '0x' };
}
async function observed(hash: string) {
  let status;
  for (let i = 0; i < 30; i++) {
    status = await services.status(hash);
    if (status.execution !== 'unknown') break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.equal(status?.execution, 'succeeded', 'Actual RPC event must prove execution');
  const response = await fetch(config.bundlerUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getUserOperationReceipt', params: [hash] }) });
  const hint = (await response.json()).result;
  const receipt = await client.getTransactionReceipt({ hash: hint.receipt.transactionHash });
  assert.equal(receipt.status, 'success');
  const event = receipt.logs.flatMap(log => {
    if (log.address.toLowerCase() !== runtime.entryPoint!.toLowerCase()) return [];
    try { const p = decodeEventLog({ abi: entryPoint09Abi, data: log.data, topics: log.topics }); return p.eventName === 'UserOperationEvent' && p.args.userOpHash.toLowerCase() === hash.toLowerCase() ? [p.args] : []; } catch { return []; }
  });
  assert.equal(event.length, 1); assert.equal(event[0].success, true);
  return { status, receipt: { transactionHash: receipt.transactionHash, blockHash: receipt.blockHash, blockNumber: receipt.blockNumber, status: receipt.status, type: receipt.type }, event: event[0] };
}
try {
  await services.createAccount();
  for (const sponsored of [false, true]) {
    const value = parseEther(sponsored ? '0.00002' : '0.00001'), before = await snapshot();
    const preview = await services.preview({ recipient, amount: sponsored ? '0.00002' : '0.00001', sponsored });
    assert.equal(preview.payment, sponsored ? 'sponsored' : 'self');
    const submitted = await services.submit(preview); assert.notEqual(submitted.submission, 'rejected');
    const proof = await observed(submitted.hash), after = await snapshot();
    assert.equal(after.recipientBalance - before.recipientBalance, value);
    assert.equal(after.entryPointNonce, before.entryPointNonce + 1n);
    assert.equal(after.code.toLowerCase(), `0xef0100${runtime.delegate!.slice(2).toLowerCase()}`);
    if (sponsored) {
      assert.equal(before.native - after.native, value, 'Sponsor pays all operation Gas; A only sends principal');
      assert.equal(after.accountDeposit, before.accountDeposit);
      assert.equal(before.paymasterDeposit - after.paymasterDeposit, proof.event.actualGasCost);
      assert.equal(proof.event.paymaster.toLowerCase(), runtime.paymaster!.toLowerCase());
    } else {
      assert.equal(before.native + before.accountDeposit - after.native - after.accountDeposit, value + proof.event.actualGasCost, 'Count A native balance and refundable EP Deposit separately');
      assert.equal(after.paymasterDeposit, before.paymasterDeposit);
    }
    report.checks.push({ name: sponsored ? 'backend_permit_http_paymaster_execution' : 'browser_services_http_selfpay', before, preview, submitted, proof, after }); save();
    if (!sponsored) await assert.rejects(services.cancel(submitted.hash), /nonce 已被消费/);
  }
  assert.ok(token && permits.length > 0, 'Actual API issued permit under authenticated session');
  if (local) {
    // Anvil reports finalized 64 blocks behind latest. Advance real fixture blocks;
    // never fabricate finality by changing RPC responses or EVM account state.
    const finalityBefore = await client.getBlock({ blockTag: 'finalized' });
    await client.request({ method: 'anvil_mine' as any, params: ['0x40', '0x1'] as any });
    const finalityAfter = await client.getBlock({ blockTag: 'finalized' });
    report.localFinalityProgress = { before: finalityBefore.number, after: finalityAfter.number, mechanism: 'mine 64 actual local fixture blocks; not public Arbitrum finality evidence' };
  }
  await new Promise(resolve => setTimeout(resolve, 5500));
  const budgetResponse = await fetch(`${config.backendBaseUrl}/v1/budgets?chainId=421614&period=${local ? 'local-fixture' : 'arb-sepolia-mvp'}`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(budgetResponse.status, 200); report.budget = await budgetResponse.json();
  const sponsoredCost = report.checks.find((c: any) => c.name === 'backend_permit_http_paymaster_execution').proof.event.actualGasCost;
  if (local) {
    assert.equal(report.budget.accountBudget.reservedRiskNative, '0', 'Executed finalized permits must release remaining risk');
    assert.equal(report.budget.accountBudget.pendingNative, '0');
    assert.ok(BigInt(report.budget.accountBudget.settledNative) >= sponsoredCost);
  } else {
    assert.ok(BigInt(report.budget.accountBudget.pendingNative) >= sponsoredCost, 'Unfrozen public policy keeps actual cost pending');
    assert.equal(report.budget.accountBudget.settledNative, '0', 'No unsupported public finality claim');
  }
  report.permits = permits.map(p => ({ sponsorshipId: p.sponsorshipId, state: p.state, permitDigest: p.permit.permitDigest, maxCost: p.permit.maxCost }));
  const beforeRevoke = await snapshot(), revocation = await services.revoke(), afterRevoke = await snapshot();
  assert.equal(afterRevoke.code, '0x'); assert.equal(afterRevoke.entryPointNonce, beforeRevoke.entryPointNonce);
  assert.equal(afterRevoke.eoaNonce, beforeRevoke.eoaNonce + 2, 'A-native outer nonce plus authorization nonce');
  assert.equal(afterRevoke.accountDeposit, beforeRevoke.accountDeposit);
  assert.equal(afterRevoke.paymasterDeposit, beforeRevoke.paymasterDeposit);
  report.checks.push({ name: 'independent_native_revocation', before: beforeRevoke, result: revocation, after: afterRevoke });
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
} catch (error) { report.status = 'failed'; report.error = error instanceof Error ? error.message : String(error); process.exitCode = 1; }
report.httpObservations = httpObservations; save();
console.log(JSON.stringify({ status: report.status, report: reportPath, checks: report.checks.map((c: any) => c.name), error: report.error }));

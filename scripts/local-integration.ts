import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createPublicClient, createWalletClient, http, defineChain, encodeFunctionData, parseEther, decodeEventLog, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { prepareOperation, createLocalSignerAdapter, signOperation, packUserOperation } from '../packages/sdk/src/index.js';

// Published fixture keys; only the fixed loopback Anvil endpoint is allowed.
const rpc = 'http://127.0.0.1:9545';
const chain = defineChain({ id: 421614, name: 'Local Arbitrum Sepolia protocol fixture', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
const publicClient = createPublicClient({ chain, transport: http(rpc) });
const relayer = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const authority = privateKeyToAccount(`0x${'1'.padStart(64, '0')}`);
const recipient = privateKeyToAccount(`0x${'2'.padStart(64, '0')}`).address;
const walletClient = createWalletClient({ chain, account: relayer, transport: http(rpc) });
const artifact = (path: string) => JSON.parse(fs.readFileSync(path, 'utf8'));
const epArtifact = artifact('integration/out/EntryPoint.sol/EntryPoint.json');
const walletArtifact = artifact('contracts/out/WalletDelegate.sol/WalletDelegate.json');
const tokenArtifact = artifact('integration/out/ProtocolArtifacts.sol/TestToken.json');
const report: Record<string, unknown> = { network: 'local-anvil', chainId: 421614, realType4: true, reference: 'EntryPoint v0.9.0 source', checks: [] };
const checks = report.checks as string[];
async function deploy(a: any, args: unknown[] = []) {
  const hash = await walletClient.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, 'success'); assert.ok(receipt.contractAddress);
  return receipt.contractAddress as Address;
}
async function readBalance(token: Address, address: Address) {
  return await publicClient.readContract({ address: token, abi: tokenArtifact.abi, functionName: 'balanceOf', args: [address] }) as bigint;
}
async function main() {
  assert.equal(await publicClient.getChainId(), 421614);
  const entryPoint = await deploy(epArtifact);
  const delegate = await deploy(walletArtifact, [entryPoint]);
  const token = await deploy(tokenArtifact, [authority.address]);
  await publicClient.waitForTransactionReceipt({ hash: await walletClient.sendTransaction({ to: authority.address, value: parseEther('0.05') }) });
  const config = { chainId: 421614, rpcUrl: rpc, bundlerUrls: [], entryPoint, delegate };
  const signer = createLocalSignerAdapter(authority);
  const gas = { verificationGasLimit: 600_000n, callGasLimit: 300_000n, preVerificationGas: 100_000n, maxPriorityFeePerGas: 1_000_000_000n, maxFeePerGas: 2_000_000_000n };
  const firstNonce = BigInt(await publicClient.getTransactionCount({ address: authority.address }));
  let first = true;
  async function submit(calls: { target: Address; value: bigint; data: Hex }[]) {
    const nonce = await publicClient.readContract({ address: entryPoint, abi: epArtifact.abi, functionName: 'getNonce', args: [authority.address, 0n] }) as bigint;
    const now = (await publicClient.getBlock()).timestamp;
    const prepared = prepareOperation({ config, account: authority.address, calls, nonce, gas, window: { validAfter: now - 1n, validUntil: now + 600n }, ...(first ? { authorizationNonce: firstNonce } : {}) });
    const signed = await signOperation(prepared, signer);
    const op = { ...packUserOperation(prepared), signature: signed.rpcUserOperation.signature! };
    const auth = signed.eip7702Auth;
    const authorizationList = auth ? [{ address: auth.address, chainId: Number(BigInt(auth.chainId)), nonce: Number(BigInt(auth.nonce)), yParity: Number(BigInt(auth.yParity)), r: auth.r, s: auth.s }] : undefined;
    const hash = await walletClient.sendTransaction({ to: entryPoint, data: encodeFunctionData({ abi: epArtifact.abi, functionName: 'handleOps', args: [[op], relayer.address] }), gas: 3_000_000n, ...(authorizationList ? { authorizationList } : {}) } as any);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, 'success');
    const decoded = receipt.logs.flatMap(log => {
      if (log.address.toLowerCase() !== entryPoint.toLowerCase()) return [];
      try { const parsed = decodeEventLog({ abi: epArtifact.abi, data: log.data, topics: log.topics }); return parsed.eventName === 'UserOperationEvent' ? [parsed] : []; } catch { return []; }
    });
    assert.equal(decoded.length, 1, 'must observe a real UserOperationEvent');
    const event = decoded[0].args as any;
    assert.equal(event.userOpHash.toLowerCase(), signed.userOpHash.toLowerCase(), 'independent EntryPoint event hash must match SDK');
    first = false;
    return { hash, event, prepared, op };
  }
  const transfer = (amount: bigint) => ({ target: token, value: 0n, data: encodeFunctionData({ abi: tokenArtifact.abi, functionName: 'transfer', args: [recipient, amount] }) });
  const before = await publicClient.getBalance({ address: authority.address });
  const success = await submit([transfer(25_000_000n)]);
  assert.equal(success.event.success, true);
  assert.equal(await readBalance(token, authority.address), 975_000_000n);
  assert.equal(await readBalance(token, recipient), 25_000_000n);
  assert.equal((await publicClient.getCode({ address: authority.address }))?.toLowerCase(), `0xef0100${delegate.slice(2).toLowerCase()}`);
  assert.ok((await publicClient.getBalance({ address: authority.address })) < before, 'self-pay authority must actually pay');
  checks.push('real type-4 authorization retains A and delegates to D', 'SDK hash equals real EntryPoint event', 'root signed transfer has independent 975000000/25000000 balances', 'self-pay actually funds and consumes gas');
  const failed = await submit([transfer(10_000_000n), { target: token, value: 0n, data: '0xdeadbeef' }]);
  assert.equal(failed.event.success, false);
  assert.equal(await readBalance(token, authority.address), 975_000_000n);
  assert.equal(await readBalance(token, recipient), 25_000_000n);
  assert.equal(failed.event.nonce, success.event.nonce + 1n);
  assert.equal((await publicClient.getCode({ address: authority.address }))?.toLowerCase(), `0xef0100${delegate.slice(2).toLowerCase()}`);
  checks.push('failed business batch rolls back its first token transfer', 'outer success is distinct from failed UserOperation', 'failed business consumes EntryPoint nonce and keeps delegation');
  report.entryPoint = entryPoint; report.delegate = delegate; report.token = token;
  report.transactions = [success.hash, failed.hash];
  report.status = 'passed';
}
try { await main(); } catch (error) { report.status = 'failed'; report.error = error instanceof Error ? error.message : String(error); process.exitCode = 1; }
fs.mkdirSync('evidence/integration', { recursive: true });
fs.writeFileSync('evidence/integration/local-entrypoint.json', JSON.stringify(report, (_, x) => typeof x === 'bigint' ? String(x) : x, 2) + '\n');
console.log(JSON.stringify(report, (_, x) => typeof x === 'bigint' ? String(x) : x, 2));

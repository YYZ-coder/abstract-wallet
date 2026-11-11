import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {
  createPublicClient, createWalletClient, http, defineChain, encodeFunctionData,
  decodeEventLog, decodeFunctionResult, keccak256, parseEther, zeroAddress,
  type Address, type Hex, type TransactionReceipt,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  prepareOperation, createLocalSignerAdapter, signOperation, packUserOperation,
  permitDigest, encodePaymasterData, operationTypedData, encodeOperationSignature,
  prepareDelegationChange, signDelegationChange,
  type Call, type PermitFields, type SignedOperation,
} from '../packages/sdk/src/index.js';

// Published fixture keys. This script has no endpoint override and refuses non-loopback/non-fixture chains.
const rpc = 'http://127.0.0.1:9545';
assert.equal(new URL(rpc).hostname, '127.0.0.1');
const chain = defineChain({
  id: 421614, name: 'Local Prague protocol fixture',
  nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [rpc] } },
});
const client = createPublicClient({ chain, transport: http(rpc) });
const funder = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const relayer = privateKeyToAccount(`0x${'3'.padStart(64, '0')}`);
const authority = privateKeyToAccount(`0x${'4'.padStart(64, '0')}`);
const sponsor = privateKeyToAccount(`0x${'2'.padStart(64, '0')}`);
const recipient = privateKeyToAccount(`0x${'5'.padStart(64, '0')}`).address;
const funderClient = createWalletClient({ chain, account: funder, transport: http(rpc) });
const wallet = createWalletClient({ chain, account: relayer, transport: http(rpc) });
const readArtifact = (path: string) => JSON.parse(fs.readFileSync(path, 'utf8'));
const artifacts = {
  entryPoint: readArtifact('integration/out/EntryPoint.sol/EntryPoint.json'),
  delegate: readArtifact('contracts/out/WalletDelegate.sol/WalletDelegate.json'),
  paymaster: readArtifact('contracts/out/SignaturePaymaster.sol/SignaturePaymaster.json'),
  token: readArtifact('integration/out/ProtocolArtifacts.sol/TestToken.json'),
};
const report: Record<string, any> = {
  startedAt: new Date().toISOString(), command: 'npx tsx scripts/paymaster-integration.ts',
  network: 'local-anvil-prague', rpc, chainId: 421614, publicArbitrumSepolia: false,
  evidenceKind: 'integration_first_pass', reference: 'official EntryPoint v0.9.0 source artifact',
  stateOverrideOrEtch: false, thirdPartyBundler: false,
  identities: { authority: authority.address, relayer: relayer.address, sponsor: sponsor.address, recipient },
  artifacts: Object.fromEntries(Object.entries(artifacts).map(([key, value]) => [key, {
    creationBytecodeSha256: crypto.createHash('sha256').update(value.bytecode.object).digest('hex'),
  }])),
  deployments: [], transactions: [], checks: [], status: 'running',
};
const serialise = (_key: string, value: unknown) => typeof value === 'bigint' ? value.toString() : value;
function save() {
  fs.mkdirSync('evidence/integration', { recursive: true });
  fs.writeFileSync('evidence/integration/local-paymaster.json', JSON.stringify(report, serialise, 2) + '\n');
}
function describe(receipt: TransactionReceipt) {
  return { hash: receipt.transactionHash, blockHash: receipt.blockHash, blockNumber: receipt.blockNumber,
    status: receipt.status, gasUsed: receipt.gasUsed, effectiveGasPrice: receipt.effectiveGasPrice, type: receipt.type };
}
async function confirmed(hash: Hex) {
  const receipt = await client.waitForTransactionReceipt({ hash });
  report.transactions.push(describe(receipt)); save();
  return receipt;
}
async function deploy(kind: keyof typeof artifacts, args: readonly unknown[] = []) {
  const a = artifacts[kind];
  const hash = await wallet.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args });
  const receipt = await confirmed(hash);
  assert.equal(receipt.status, 'success'); assert.ok(receipt.contractAddress);
  report.deployments.push({ kind, address: receipt.contractAddress, ...describe(receipt) }); save();
  return receipt.contractAddress as Address;
}
function authorizationList(auth: NonNullable<SignedOperation['eip7702Auth']>) {
  const nonce = Number(BigInt(auth.nonce)), chainId = Number(BigInt(auth.chainId));
  assert.ok(Number.isSafeInteger(nonce) && Number.isSafeInteger(chainId));
  return [{ address: auth.address, nonce, chainId, yParity: Number(BigInt(auth.yParity)), r: auth.r, s: auth.s }];
}

async function main() {
  assert.equal(await client.getChainId(), 421614, 'refuse every chain except local fixture 421614');
  const clientVersion = await client.request({ method: 'web3_clientVersion' });
  assert.match(clientVersion, /anvil/i, 'public network is forbidden even if its chain ID matches');
  report.clientVersion = clientVersion;
  if ((await client.getBalance({ address: relayer.address })) < parseEther('2')) {
    const receipt = await confirmed(await funderClient.sendTransaction({ to: relayer.address, value: parseEther('3') }));
    assert.equal(receipt.status, 'success'); report.relayerFunding = describe(receipt);
  }
  const entryPoint = await deploy('entryPoint');
  const delegate = await deploy('delegate', [entryPoint]);
  const paymaster = await deploy('paymaster', [entryPoint, sponsor.address, relayer.address]);
  const token = await deploy('token', [authority.address]);
  report.addresses = { entryPoint, delegate, paymaster, token }; save();
  assert.equal((await confirmed(await wallet.sendTransaction({ to: authority.address, value: parseEther('0.05') }))).status, 'success');
  assert.equal((await confirmed(await wallet.writeContract({ address: paymaster, abi: artifacts.paymaster.abi, functionName: 'deposit', value: parseEther('1') }))).status, 'success');
  const config = { chainId: 421614, rpcUrl: rpc, bundlerUrls: [], entryPoint, delegate, paymaster };
  const signer = createLocalSignerAdapter(authority);
  const gas = { verificationGasLimit: 600_000n, callGasLimit: 300_000n, preVerificationGas: 100_000n,
    maxPriorityFeePerGas: 1_000_000_000n, maxFeePerGas: 2_000_000_000n };
  const pmGas = { verificationGasLimit: 200_000n, postOpGasLimit: 0n };
  const getNonce = () => client.readContract({ address: entryPoint, abi: artifacts.entryPoint.abi, functionName: 'getNonce', args: [authority.address, 0n] }) as Promise<bigint>;
  async function snapshot() {
    const [native, tokenAuthority, tokenRecipient, deposit, nonce, eoaNonce, code, block] = await Promise.all([
      client.getBalance({ address: authority.address }),
      client.readContract({ address: token, abi: artifacts.token.abi, functionName: 'balanceOf', args: [authority.address] }),
      client.readContract({ address: token, abi: artifacts.token.abi, functionName: 'balanceOf', args: [recipient] }),
      client.readContract({ address: entryPoint, abi: artifacts.entryPoint.abi, functionName: 'balanceOf', args: [paymaster] }),
      getNonce(), client.getTransactionCount({ address: authority.address }), client.getCode({ address: authority.address }), client.getBlock(),
    ]);
    return { native, tokenAuthority: tokenAuthority as bigint, tokenRecipient: tokenRecipient as bigint,
      paymasterDeposit: deposit as bigint, entryPointNonce: nonce, eoaNonce: BigInt(eoaNonce), code: code ?? '0x',
      observation: { blockNumber: block.number, blockHash: block.hash, timestamp: block.timestamp } };
  }
  const transfer = (amount: bigint): Call => ({ target: token, value: 0n,
    data: encodeFunctionData({ abi: artifacts.token.abi, functionName: 'transfer', args: [recipient, amount] }) });
  let sequence = 0n;
  async function prepareSponsored(calls: Call[], first = false) {
    const nonce = await getNonce(), now = (await client.getBlock()).timestamp;
    const window = { validAfter: now - 1n, validUntil: now + 600n };
    const authorizationNonce = first ? BigInt(await client.getTransactionCount({ address: authority.address })) : undefined;
    const draft = prepareOperation({ config, account: authority.address, calls, nonce, gas, window,
      paymaster: { address: paymaster, ...pmGas, data: '0x' }, ...(first ? { authorizationNonce } : {}) });
    const packed = packUserOperation(draft);
    const fields: PermitFields = { chainId: 421614, paymaster, expectedDelegate: delegate, sender: authority.address,
      entryPoint, nonce, initCodeHash: keccak256(packed.initCode), callDataHash: keccak256(packed.callData),
      accountGasLimits: packed.accountGasLimits, preVerificationGas: gas.preVerificationGas, gasFees: packed.gasFees,
      paymasterVerificationGasLimit: pmGas.verificationGasLimit, paymasterPostOpGasLimit: pmGas.postOpGasLimit,
      ...window, maxCost: parseEther('0.01'), reservationId: `0x${(++sequence).toString(16).padStart(64, '0')}` };
    const digest = permitDigest(fields), feeSignature = await sponsor.sign({ hash: digest });
    const prepared = prepareOperation({ ...draft, paymaster: { address: paymaster, ...pmGas, data: encodePaymasterData(fields, feeSignature) } });
    const signed = await signOperation(prepared, signer);
    return { fields, digest, signed, op: { ...packUserOperation(prepared), signature: signed.rpcUserOperation.signature! } };
  }
  async function sendBundle(prepared: Awaited<ReturnType<typeof prepareSponsored>>, expected: boolean | 'outer-revert') {
    const auth = prepared.signed.eip7702Auth;
    const hash = await wallet.sendTransaction({ to: entryPoint,
      data: encodeFunctionData({ abi: artifacts.entryPoint.abi, functionName: 'handleOps', args: [[prepared.op], relayer.address] }),
      gas: 3_500_000n, ...(auth ? { authorizationList: authorizationList(auth) } : {}) } as any);
    const receipt = await confirmed(hash);
    const events = receipt.logs.flatMap(log => {
      if (log.address.toLowerCase() !== entryPoint.toLowerCase()) return [];
      try {
        const parsed = decodeEventLog({ abi: artifacts.entryPoint.abi, data: log.data, topics: log.topics });
        return parsed.eventName === 'UserOperationEvent' ? [parsed.args as any] : [];
      } catch { return []; }
    });
    if (expected === 'outer-revert') {
      assert.equal(receipt.status, 'reverted'); assert.equal(events.length, 0, 'reverted bundle retains no op event');
      return { receipt: describe(receipt), events, userOpHash: prepared.signed.userOpHash, permitDigest: prepared.digest };
    }
    assert.equal(receipt.status, 'success'); assert.equal(events.length, 1);
    const event = events[0];
    assert.equal(event.success, expected); assert.equal(event.sender.toLowerCase(), authority.address.toLowerCase());
    assert.equal(event.paymaster.toLowerCase(), paymaster.toLowerCase());
    assert.equal(event.userOpHash.toLowerCase(), prepared.signed.userOpHash.toLowerCase(), 'SDK and real EP hash agree');
    return { receipt: describe(receipt), event, userOpHash: prepared.signed.userOpHash, permitDigest: prepared.digest };
  }

  const before = await snapshot();
  assert.equal(before.tokenAuthority, 1_000_000_000n); assert.equal(before.tokenRecipient, 0n);
  const first = await prepareSponsored([transfer(25_000_000n)], true);
  const success = await sendBundle(first, true), after = await snapshot();
  assert.equal(after.tokenAuthority, 975_000_000n); assert.equal(after.tokenRecipient, 25_000_000n);
  assert.equal(after.native, before.native, 'A pays no native gas in sponsored R!=A path');
  assert.ok(before.paymasterDeposit > after.paymasterDeposit);
  assert.equal(before.paymasterDeposit - after.paymasterDeposit, success.event!.actualGasCost);
  assert.equal(after.entryPointNonce, before.entryPointNonce + 1n);
  assert.equal(after.eoaNonce, before.eoaNonce + 1n);
  assert.equal(after.code.toLowerCase(), `0xef0100${delegate.slice(2).toLowerCase()}`);
  report.checks.push({ name: 'sponsored_success_real_type4', before, after, ...success }); save();

  const failedBefore = await snapshot();
  const failedPrepared = await prepareSponsored([transfer(10_000_000n), { target: token, value: 0n, data: '0xdeadbeef' }]);
  const failed = await sendBundle(failedPrepared, false), failedAfter = await snapshot();
  assert.equal(failedAfter.tokenAuthority, 975_000_000n); assert.equal(failedAfter.tokenRecipient, 25_000_000n);
  assert.equal(failedAfter.native, failedBefore.native);
  assert.ok(failedBefore.paymasterDeposit > failedAfter.paymasterDeposit);
  assert.equal(failedBefore.paymasterDeposit - failedAfter.paymasterDeposit, failed.event!.actualGasCost);
  assert.equal(failedAfter.entryPointNonce, failedBefore.entryPointNonce + 1n);
  assert.equal(failedAfter.code, failedBefore.code);
  report.checks.push({ name: 'sponsored_business_revert_still_pays', before: failedBefore, after: failedAfter, ...failed }); save();

  const invalidBefore = await snapshot(), invalidPrepared = await prepareSponsored([transfer(1_000_000n)]);
  const wrongRoot = await sponsor.signTypedData(operationTypedData(invalidPrepared.signed.prepared));
  invalidPrepared.op.signature = encodeOperationSignature(wrongRoot, invalidPrepared.signed.prepared.window);
  const permitCall = await client.call({ account: entryPoint, to: paymaster,
    data: encodeFunctionData({ abi: artifacts.paymaster.abi, functionName: 'validatePaymasterUserOp',
      args: [invalidPrepared.op, invalidPrepared.signed.userOpHash, 2_400_000_000_000_000n] }) });
  assert.ok(permitCall.data);
  const [, permitValidation] = decodeFunctionResult({ abi: artifacts.paymaster.abi, functionName: 'validatePaymasterUserOp', data: permitCall.data }) as [Hex, bigint];
  assert.equal(permitValidation & ((1n << 160n) - 1n), 0n, 'deployed PM accepts this permit despite wrong root; eth_call is simulation only');
  const invalid = await sendBundle(invalidPrepared, 'outer-revert'), invalidAfter = await snapshot();
  for (const key of ['native', 'tokenAuthority', 'tokenRecipient', 'paymasterDeposit', 'entryPointNonce', 'eoaNonce', 'code'] as const)
    assert.equal(invalidAfter[key], invalidBefore[key], `whole bundle revert must preserve ${key}`);
  report.checks.push({ name: 'valid_permit_wrong_root_outer_revert', before: invalidBefore, after: invalidAfter,
    permitSimulation: { validationData: permitValidation, stateful: false }, ...invalid }); save();

  const revokeBefore = await snapshot();
  assert.equal((await client.getCode({ address: zeroAddress })) ?? '0x', '0x', 'outer destination has no code');
  const change = prepareDelegationChange({ config, account: authority.address, target: zeroAddress,
    eoaNonce: revokeBefore.eoaNonce, outerSender: relayer.address });
  const authorization = await signDelegationChange(change, signer);
  const revokeReceipt = await confirmed(await wallet.sendTransaction({ to: zeroAddress, value: 0n, data: '0x',
    gas: 100_000n, authorizationList: authorizationList(authorization) } as any));
  assert.equal(revokeReceipt.status, 'success');
  const revokeAfter = await snapshot();
  assert.equal(revokeAfter.code, '0x'); assert.equal(revokeAfter.eoaNonce, revokeBefore.eoaNonce + 1n);
  assert.equal(revokeAfter.entryPointNonce, revokeBefore.entryPointNonce);
  assert.equal(revokeAfter.tokenAuthority, 975_000_000n); assert.equal(revokeAfter.tokenRecipient, 25_000_000n);
  assert.equal(revokeAfter.native, revokeBefore.native);
  assert.equal(revokeAfter.paymasterDeposit, revokeBefore.paymasterDeposit);
  report.checks.push({ name: 'root_direct_native_type4_revocation_keeps_tokens', before: revokeBefore, after: revokeAfter, receipt: describe(revokeReceipt) });
  report.status = 'passed'; report.completedAt = new Date().toISOString();
}

try { await main(); } catch (error) {
  report.status = 'failed'; report.error = error instanceof Error ? error.message : String(error); process.exitCode = 1;
}
save();
console.log(JSON.stringify(report, serialise, 2));

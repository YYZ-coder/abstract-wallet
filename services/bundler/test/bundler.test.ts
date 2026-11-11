import { signedFixture } from './fixtures.js';
import { expect, it } from 'vitest';
import { createBundler } from '../src/bundler.js';
import type { ChainAdapter, Options } from '../src/bundler.js';
import type { Hex } from 'viem';
import { encodeAbiParameters, encodeEventTopics, parseAbiParameters, parseAbi } from 'viem';
import { encodeCalls, createUnsignedAuthorization } from '../../../packages/sdk/src/index.js';
import { createLocalSignerAdapter, prepareOperation, signOperation } from '../../../packages/sdk/src/index.js';
import { privateKeyToAccount } from 'viem/accounts';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const EP = '0x3333333333333333333333333333333333333333';
const D = '0x2222222222222222222222222222222222222222';
const B = '0x5555555555555555555555555555555555555555';
export function adapter(overrides: Partial<ChainAdapter> = {}): ChainAdapter {
  return { chainId: async () => 421614, code: async () => '0x6000', eoaNonce: async () => 0n, timestamp: async () => 1001n, simulate: async () => {}, prepare: async () => ({ rawTransaction: '0x01', transactionHash: `0x${'aa'.repeat(32)}` }), broadcast: async () => `0x${'aa'.repeat(32)}`, receipt: async () => null, ...overrides };
}
export function options(overrides: Partial<Options> = {}): Options { return { chainId: 421614, entryPoint: EP, delegate: D, beneficiary: B, adapter: adapter(), ...overrides }; }
it('advertises only verified Arbitrum Sepolia deployment context', async () => {
  expect(() => createBundler(options({ chainId: 1 }))).toThrow('TESTNET_ONLY');
  const rpc = { jsonrpc: '2.0', id: 1, method: 'eth_supportedEntryPoints', params: [] };
  expect((await createBundler(options()).handle(rpc)).result).toEqual([EP]);
  expect((await createBundler(options({ adapter: adapter({ chainId: async () => 1 }) })).handle(rpc)).error.message).toContain('CHAIN_MISMATCH');
});
it('estimates unsigned operations with an explicit conservative gas policy', async () => {
  const A = '0x1111111111111111111111111111111111111111';
  const wire: Hex[] = [];
  const service = createBundler(options({ adapter: adapter({ broadcast: async raw => { wire.push(raw); return `0x${'aa'.repeat(32)}`; } }) }));
  const response = await service.handle({ jsonrpc: '2.0', id: 2, method: 'eth_estimateUserOperationGas', params: [{ sender: A, nonce: '0x0', factory: '0x7702', factoryData: '0x', callData: encodeCalls([{ target: A, value: 0n, data: '0x' }]), signature: '0x', eip7702Auth: createUnsignedAuthorization(421614, D, 0n) }, EP] });
  expect(response.result?.verificationGasLimit).toBe('0x927c0');
  expect(response.result?.callGasLimit).toBe('0x493e0');
  expect(response.result?.estimationSource).toBe('configured-conservative-upper-bound');
  expect(BigInt(response.result.preVerificationGas)).toBeGreaterThanOrEqual(100000n);
  expect(wire).toEqual([]);
});

it('broadcasts only a verified real root operation after successful simulation', async () => {
  const signed = await signedFixture(); const wire: Hex[] = []; const simulated: any[] = [];
  const service = createBundler(options({ adapter: adapter({ simulate: async bundle => { simulated.push(bundle); }, broadcast: async raw => { wire.push(raw); return `0x${'aa'.repeat(32)}`; } }) }));
  const op = { ...signed.rpcUserOperation, eip7702Auth: signed.eip7702Auth };
  const request = { jsonrpc: '2.0', id: 3, method: 'eth_sendUserOperation', params: [op, EP] };
  expect((await service.handle(request)).result).toBe(signed.userOpHash);
  expect(wire).toEqual(['0x01']); expect(simulated[0].userOpHash).toBe(signed.userOpHash);
  expect((await service.handle({ ...request, params: [{ ...op, signature: '0x' }, EP] })).error.code).toBe(-32507);
  expect((await service.handle({ ...request, params: [{ ...op, eip7702Auth: { ...op.eip7702Auth, chainId: '0x1' } }, EP] })).error.code).toBe(-32602);
  expect(wire).toEqual(['0x01']);
});
it('retries a durably saved ambiguous outer transaction without another nonce', async () => {
  const signed = await signedFixture(); const wire: Hex[] = []; let sequence = 0;
  const statePath = join(mkdtempSync(join(tmpdir(), 'wallet-bundler-')), 'state.json');
  const chain = adapter({
    prepare: async () => { sequence++; return { rawTransaction: `0x0${sequence}`, transactionHash: `0x${String(sequence).repeat(64)}` as Hex }; },
    broadcast: async raw => { wire.push(raw); if (wire.length === 1) throw new Error('timeout after dispatch'); return `0x${'1'.repeat(64)}`; }
  });
  const request = { jsonrpc: '2.0', id: 4, method: 'eth_sendUserOperation', params: [{ ...signed.rpcUserOperation, eip7702Auth: signed.eip7702Auth }, EP] };
  const first = await createBundler(options({ adapter: chain, statePath })).handle(request);
  expect(first.error.message).toBe('BROADCAST_RESULT_UNKNOWN');
  expect(JSON.parse(readFileSync(statePath, 'utf8')).records[0].rawTransaction).toBe('0x01');
  const restarted = createBundler(options({ adapter: chain, statePath }));
  expect((await restarted.handle(request)).result).toBe(signed.userOpHash);
  expect(wire).toEqual(['0x01', '0x01']);
  expect((await restarted.handle(request)).result).toBe(signed.userOpHash);
  expect(wire).toEqual(['0x01', '0x01']);
});
it('derives an exact UserOperation receipt from chain events instead of outer success', async () => {
  const signed = await signedFixture(); let receipt: any = null;
  const service = createBundler(options({ adapter: adapter({ receipt: async () => receipt }) }));
  await service.handle({ jsonrpc: '2.0', id: 5, method: 'eth_sendUserOperation', params: [{ ...signed.rpcUserOperation, eip7702Auth: signed.eip7702Auth }, EP] });
  const query = { jsonrpc: '2.0', id: 6, method: 'eth_getUserOperationReceipt', params: [signed.userOpHash] };
  expect((await service.handle(query)).result).toBeNull();
  const abi = parseAbi(['event UserOperationEvent(bytes32 indexed userOpHash,address indexed sender,address indexed paymaster,uint256 nonce,bool success,uint256 actualGasCost,uint256 actualGasUsed)']);
  const topics = encodeEventTopics({ abi, eventName: 'UserOperationEvent', args: { userOpHash: signed.userOpHash, sender: signed.prepared.account, paymaster: '0x0000000000000000000000000000000000000000' } });
  receipt = { status: '0x1', blockHash: `0x${'bb'.repeat(32)}`, transactionHash: `0x${'aa'.repeat(32)}`, logs: [{ address: EP, topics, data: encodeAbiParameters(parseAbiParameters('uint256,bool,uint256,uint256'), [0n,false,25n,250000n]) }] };
  const result = (await service.handle(query)).result;
  expect(result.success).toBe(false); expect(result.userOpHash).toBe(signed.userOpHash); expect(result.actualGasCost).toBe('0x19');
  expect(result.receipt.status).toBe('0x1');
});
it('fails closed on every retry when signed transaction persistence fails', async () => {
  const signed = await signedFixture(); const wire: Hex[] = [];
  const blocked = join(mkdtempSync(join(tmpdir(), 'wallet-bundler-blocked-')), 'file'); writeFileSync(blocked,'not a directory');
  const service = createBundler(options({ statePath:join(blocked,'state.json'),adapter:adapter({broadcast:async raw=>{wire.push(raw);return `0x${'aa'.repeat(32)}`;}}) }));
  const request = { jsonrpc:'2.0',id:10,method:'eth_sendUserOperation',params:[{...signed.rpcUserOperation,eip7702Auth:signed.eip7702Auth},EP] };
  await service.handle(request); await service.handle(request);
  expect(wire).toEqual([]);
});

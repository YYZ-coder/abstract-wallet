import { expect, it } from 'vitest';
import { parseTransaction, decodeFunctionData, keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { entryPoint09Abi } from 'viem/account-abstraction';
import { createViemAdapter } from '../src/runtime.js';
import { packUserOperation } from '../../../packages/sdk/src/index.js';
import { signedFixture } from './fixtures.js';
import type { Bundle } from '../src/bundler.js';

it('prepares an exact offline type4 bundle without broadcasting or truncating nonce', async () => {
  const signed = await signedFixture(); let outerNonce = '0x0'; const wire: string[] = [];
  const account = privateKeyToAccount(`0x${'00'.repeat(31)}02`);
  const adapter = createViemAdapter({ rpcUrl: 'https://rpc.invalid', entryPoint: signed.prepared.config.entryPoint, delegate: signed.prepared.config.delegate, account,
    fetchImpl: async (_url, init) => { const body = JSON.parse(init!.body as string); wire.push(body.method); return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: outerNonce })); } });
  const bundle: Bundle = { sender: signed.prepared.account, op: { ...packUserOperation(signed.prepared), signature: signed.rpcUserOperation.signature }, userOpHash: signed.userOpHash, authorization: signed.eip7702Auth, outerGas: 1200000n };
  const prepared = await adapter.prepare(bundle);
  expect(prepared.rawTransaction.startsWith('0x04')).toBe(true);
  const tx = parseTransaction(prepared.rawTransaction);
  expect(tx.chainId).toBe(421614); expect(tx.to?.toLowerCase()).toBe(signed.prepared.config.entryPoint);
  expect(tx.authorizationList?.[0].address.toLowerCase()).toBe(signed.prepared.config.delegate);
  expect(decodeFunctionData({ abi: entryPoint09Abi, data: tx.data! }).functionName).toBe('handleOps');
  expect(wire).toEqual(['eth_getTransactionCount']);
  outerNonce = '0x20000000000000';
  await expect(adapter.prepare(bundle)).rejects.toThrow('NONCE_NOT_SAFELY_SERIALIZABLE');
});
it('simulates exact handleOps at RPC with explicit pending delegation state', async () => {
  const signed = await signedFixture(); const requests: any[] = [];
  const account = privateKeyToAccount(`0x${'00'.repeat(31)}02`);
  const adapter = createViemAdapter({ rpcUrl: 'https://rpc.invalid', entryPoint: signed.prepared.config.entryPoint, delegate: signed.prepared.config.delegate, account,
    fetchImpl: async (_url, init) => { const body = JSON.parse(init!.body as string); requests.push(body); return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x' })); } });
  await adapter.simulate({ sender: signed.prepared.account, op: { ...packUserOperation(signed.prepared), signature: signed.rpcUserOperation.signature }, userOpHash: signed.userOpHash, authorization: signed.eip7702Auth, outerGas: 1200000n });
  expect(requests.length).toBe(1);
  expect(requests[0].method).toBe('eth_call');
  expect(requests[0].params[0].from).toBe(account.address);
  expect(requests[0].params[2][signed.prepared.account].code).toBe(`0xef0100${signed.prepared.config.delegate.slice(2)}`);
  expect(JSON.stringify(requests)).not.toContain('privateKey');
});
it('reads exact chain identity code nonce and time from the configured RPC', async () => {
  const account = privateKeyToAccount(`0x${'00'.repeat(31)}02`);
  const adapter = createViemAdapter({ rpcUrl: 'https://rpc.invalid', entryPoint: account.address, delegate: account.address, account,
    fetchImpl: async (_url, init) => { const body = JSON.parse(init!.body as string); const result = body.method === 'eth_chainId' ? '0x66eee' : body.method === 'eth_getCode' ? '0x6000' : body.method === 'eth_getTransactionCount' ? '0x20000000000003' : { timestamp: '0x3e9' }; return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result })); } });
  expect(await adapter.chainId()).toBe(421614); expect(await adapter.code(account.address)).toBe('0x6000');
  expect(await adapter.eoaNonce(account.address)).toBe(9007199254740995n); expect(await adapter.timestamp()).toBe(1001n);
});
it('broadcasts exact raw bytes and recovers already-known transactions by the same hash', async () => {
  const account = privateKeyToAccount(`0x${'00'.repeat(31)}02`); const hash = keccak256('0x01'); const requests: any[] = [];
  const adapter = createViemAdapter({ rpcUrl: 'https://rpc.invalid', entryPoint: account.address, delegate: account.address, account,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init!.body as string); requests.push(body);
      if (body.method === 'eth_sendRawTransaction') return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32000, message: 'already known' } }));
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: body.method === 'eth_getTransactionByHash' ? { hash } : { transactionHash: hash, status: '0x1', logs: [] } }));
    } });
  expect(await adapter.broadcast('0x01')).toBe(hash);
  expect(requests[0].params).toEqual(['0x01']);
  expect((await adapter.receipt(hash)).transactionHash).toBe(hash);
});
it('reserves distinct outer nonces even when the RPC pending value lags', async () => {
  const signed = await signedFixture(); const account = privateKeyToAccount(`0x${'00'.repeat(31)}02`);
  const adapter = createViemAdapter({ rpcUrl:'https://rpc.invalid',entryPoint:signed.prepared.config.entryPoint,delegate:signed.prepared.config.delegate,account,
    fetchImpl:async(_url,init)=>{const body=JSON.parse(init!.body as string);return new Response(JSON.stringify({jsonrpc:'2.0',id:body.id,result:'0x0'}));} });
  const bundle: Bundle = { sender:signed.prepared.account,op:{...packUserOperation(signed.prepared),signature:signed.rpcUserOperation.signature},userOpHash:signed.userOpHash,authorization:signed.eip7702Auth,outerGas:1200000n };
  expect(parseTransaction((await adapter.prepare(bundle)).rawTransaction).nonce).toBe(0);
  expect(parseTransaction((await adapter.prepare(bundle)).rawTransaction).nonce).toBe(1);
});

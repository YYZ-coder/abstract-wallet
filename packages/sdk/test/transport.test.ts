import { expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { createLocalSignerAdapter, createWalletClientTransport, prepareOperation, sendOperation, signOperation, interpretOperationReceipt } from '../src/index.js';
import type { FetchLike } from '../src/types.js';
import { config, EP, input } from './fixtures.js';
import { A, D } from './fixtures.js';
import { encodeAbiParameters, parseAbiParameters } from 'viem';

it('submits the exact signed intent through a same-chain bundler', async () => {
  const account = privateKeyToAccount(`0x${'00'.repeat(31)}01`);
  const signed = await signOperation(prepareOperation({ ...input, account: account.address }), createLocalSignerAdapter(account));
  const requests: { url: string; body: any }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const body = JSON.parse(init!.body as string); requests.push({ url: String(url), body });
    const result = body.method === 'eth_chainId' ? '0x66eee' : body.method === 'eth_supportedEntryPoints' ? [EP] : signed.userOpHash;
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
  };
  const result = await sendOperation(createWalletClientTransport(config, fetchImpl), signed);
  expect(result.admission).toBe('accepted');
  const sent = requests.find(r => r.body.method === 'eth_sendUserOperation')!;
  expect(sent.url).toBe('https://bundler.invalid');
  expect(sent.body.params).toEqual([signed.rpcUserOperation, EP]);
  expect(sent.body.params[0]).not.toHaveProperty('eip7702Auth');
});

it('separates rejection from uncertainty and retries the identical signed operation', async () => {
  const account = privateKeyToAccount(`0x${'00'.repeat(31)}01`);
  const cfg = { ...config, bundlerUrls: ['https://one.invalid', 'https://two.invalid'] };
  const signed = await signOperation(prepareOperation({ ...input, config: cfg, account: account.address }), createLocalSignerAdapter(account));
  const sent: unknown[] = []; let mode = 'reject';
  const fetchImpl: FetchLike = async (_url, init) => {
    const body = JSON.parse(init!.body as string);
    if (body.method === 'eth_sendUserOperation') {
      sent.push(body.params);
      if (mode === 'timeout') throw new Error('network timeout');
      if (mode === 'reject') return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32507, message: 'AA24 signature error' } }));
    }
    const result = body.method === 'eth_chainId' ? '0x66eee' : body.method === 'eth_supportedEntryPoints' ? [EP] : signed.userOpHash;
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
  };
  const transport = createWalletClientTransport(cfg, fetchImpl);
  await expect(sendOperation(transport, signed)).resolves.toMatchObject({ admission: 'rejected', userOpHash: signed.userOpHash });
  mode = 'timeout';
  await expect(sendOperation(transport, signed)).resolves.toMatchObject({ admission: 'unknown', userOpHash: signed.userOpHash });
  mode = 'accept';
  expect((await sendOperation(transport, signed, 1)).admission).toBe('accepted');
  expect(sent[1]).toEqual(sent[2]);
});

it('reads independent chain delegation and protocol nonce state', async () => {
  let chain = '0x66eee';
  const fetchImpl: FetchLike = async (_url, init) => {
    const { id, method, params } = JSON.parse(init!.body as string);
    const result = method === 'eth_chainId' ? chain : method === 'eth_getCode' ? params[0] === A ? `0xef0100${D.slice(2)}` : '0x6000' : method === 'eth_getTransactionCount' ? '0x5' : method === 'eth_getBalance' ? '0x19' : encodeAbiParameters(parseAbiParameters('uint256'), [7n]);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }));
  };
  const transport = createWalletClientTransport(config, fetchImpl);
  const state = await transport.readAccountState(A);
  expect(state.delegation.status).toBe('expected');
  expect(state.delegation.actualDelegate?.toLowerCase()).toBe(D);
  expect(state.eoaNonce).toBe(5n); expect(state.entryPointNonce).toBe(7n); expect(state.balance).toBe(25n);
  chain = '0x1';
  await expect(transport.readAccountState(A)).rejects.toThrow('CHAIN_MISMATCH');
});

it('estimates final operation gas with a canonical simulation signature', async () => {
  const sent: any[] = [];
  const fetchImpl: FetchLike = async (_url, init) => {
    const { id, method, params } = JSON.parse(init!.body as string); sent.push({ method, params });
    const result = method === 'eth_chainId' ? '0x66eee' : method === 'eth_gasPrice' ? '0x64' : { callGasLimit: '0x13880', verificationGasLimit: '0x186a0', preVerificationGas: '0xc350' };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }));
  };
  const transport = createWalletClientTransport(config, fetchImpl);
  const gas = await transport.estimateGas(prepareOperation(input).rpcUserOperation);
  expect(gas).toMatchObject({ callGasLimit: 80000n, verificationGasLimit: 100000n, preVerificationGas: 50000n });
  expect(await transport.gasPrice()).toBe(100n);
  const estimate = sent.find(r => r.method === 'eth_estimateUserOperationGas');
  expect(estimate.params[0].factory).toBe('0x7702');
  expect(estimate.params[0].signature.length).toBe(578);
  expect(estimate.params[1]).toBe(EP);
});

it('keeps UserOperation execution separate from outer success and confirmation', async () => {
  const failed = { success: false, receipt: { status: '0x1', blockNumber: '0x5', blockHash: `0x${'ab'.repeat(32)}` } };
  expect(interpretOperationReceipt(failed)).toMatchObject({ execution: 'reverted', confirmation: 'pending' });
  expect(interpretOperationReceipt(null)).toMatchObject({ execution: 'unknown', confirmation: 'unknown' });
  expect(interpretOperationReceipt({ ...failed, success: true }, { canonical: false, confirmations: 99 })).toMatchObject({ execution: 'unknown', confirmation: 'reorged' });
  const fetchImpl: FetchLike = async (_url, init) => { const { id, method } = JSON.parse(init!.body as string); return new Response(JSON.stringify({ jsonrpc: '2.0', id, result: method === 'eth_chainId' ? '0x66eee' : failed })); };
  expect(await createWalletClientTransport(config, fetchImpl).getReceipt(`0x${'ab'.repeat(32)}`)).toEqual(failed);
});

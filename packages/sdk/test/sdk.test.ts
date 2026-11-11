import { describe, expect, it } from 'vitest';
import { parseInteger, parseAmount } from '../src/index.js';
import { encodeCalls, decodeCalls, prepareOperation, encodeOperationSignature, createLocalSignerAdapter, signOperation, prepareCancellation } from '../src/index.js';
import { privateKeyToAccount } from 'viem/accounts';
import { recoverTypedDataAddress } from 'viem';
import { recoverAuthorizationAddress } from 'viem/utils';
import { getAuthorizationNonce, prepareDelegationChange, signDelegationChange } from '../src/index.js';
import { normalizePreVerificationGas } from '../src/index.js';
import { getUserOperationHash } from 'viem/account-abstraction';
import { decodeFunctionData, parseAbi, hashTypedData, decodeAbiParameters, parseAbiParameters } from 'viem';
import { A, D, EP, input } from './fixtures.js';

describe('public SDK', () => {
  it('validates canonical unsigned integers', () => {
    expect(parseInteger('0')).toBe(0n);
    expect(parseInteger('25')).toBe(25n);
    for (const value of ['', '-1', '01', '1.0', '1e3', ' 1', '1 ']) {
      expect(() => parseInteger(value)).toThrow();
    }
    expect(() => parseInteger('256', 255n)).toThrow();
  });
  it('converts exact token amounts without rounding', () => {
    expect(parseAmount('10.25', 6)).toBe(10_250_000n);
    expect(parseAmount('0.000001', 6)).toBe(1n);
    for (const amount of ['0.0000001', '1e2', '-1', '01.5']) expect(() => parseAmount(amount, 6)).toThrow();
    expect(() => parseAmount('1', -1)).toThrow();
  });
  it('encodes bounded atomic calls using the public ABI', () => {
    const calls = [{ target: D, value: 25n, data: '0x1234' as const }];
    const data = encodeCalls(calls);
    expect(data.length).toBeGreaterThan(10);
    const decoded = decodeFunctionData({ abi: parseAbi(['function executeBatch((address target,uint256 value,bytes data)[] calls) payable returns (bytes[])']), data });
    expect(decoded.functionName).toBe('executeBatch');
    expect(decoded.args?.[0]).toEqual(calls);
    expect(decodeCalls(data)).toEqual(calls);
    expect(() => encodeCalls([])).toThrow();
    expect(() => encodeCalls(Array(17).fill(calls[0]))).toThrow();
    expect(() => encodeCalls([{ target: A, value: 0n, data: `0x${'ff'.repeat(32769)}` }])).toThrow();
    expect(() => encodeCalls([{ target: '0x123' as never, value: 0n, data: '0x' }])).toThrow();
  });
  it('prepares delegate-bound v09 operations matching an independent reference', () => {
    const prepared = prepareOperation(input);
    const expected = getUserOperationHash({ chainId: 421614, entryPointAddress: EP, entryPointVersion: '0.9', userOperation: {
      sender: A, nonce: 7n, factory: '0x7702', factoryData: '0x',
      authorization: { address: D, chainId: 421614, nonce: 0, r: `0x${'00'.repeat(32)}`, s: `0x${'00'.repeat(32)}`, yParity: 0 },
      callData: encodeCalls([{ target: D, value: 25n, data: '0x1234' }]),
      verificationGasLimit: 100000n, callGasLimit: 80000n, preVerificationGas: 50000n, maxPriorityFeePerGas: 1n, maxFeePerGas: 100n, signature: '0x'
    } });
    expect(prepared.userOpHash).toBe(expected);
    expect(prepared.rpcUserOperation.nonce).toBe('0x7');
    expect(prepared.rpcUserOperation.factory).toBe('0x7702');
    expect(prepareOperation({ ...input, config: { ...input.config, chainId: 8453 } }).userOpHash).not.toBe(expected);
    expect(() => prepareOperation({ ...input, window: { validAfter: 1100n, validUntil: 1100n } })).toThrow();
    expect(() => prepareOperation({ ...input, gas: { ...input.gas, callGasLimit: 1n << 120n } })).toThrow();
  });
  it('binds the account window and encodes a canonical root operation envelope', () => {
    const p = prepareOperation(input);
    const expected = hashTypedData({ domain: { name: 'AbstractWallet', version: '1', chainId: 421614, verifyingContract: A }, primaryType: 'WalletOperation', types: { WalletOperation: [{ name: 'userOpHash', type: 'bytes32' }, { name: 'validAfter', type: 'uint48' }, { name: 'validUntil', type: 'uint48' }] }, message: { userOpHash: '0x7197e040ad6ce5402082fbcaf4d9604b23f58a9ed3c7255617a2b2e96a67b59a', validAfter: 1000, validUntil: 1100 } });
    expect(p.operationDigest).toBe(expected);
    const sig = `0x${'00'.repeat(31)}01${'00'.repeat(31)}011b` as const;
    const encoded = encodeOperationSignature(sig, input.window);
    expect((encoded.length - 2) / 2).toBe(288);
    expect(decodeAbiParameters(parseAbiParameters('uint8,uint8,uint48,uint48,bytes'), encoded)).toEqual([1, 1, 1000, 1100, sig]);
    expect(() => encodeOperationSignature(`${sig.slice(0, -2)}00` as `0x${string}`, input.window)).toThrow();
    expect(() => encodeOperationSignature(`0x${'01'.repeat(32)}${'ff'.repeat(32)}1b`, input.window)).toThrow();
  });
  it('signs authorization and the final operation with the actual root', async () => {
    const account = privateKeyToAccount(`0x${'00'.repeat(31)}01`);
    const p = prepareOperation({ ...input, account: account.address, authorizationNonce: 5n });
    const signer = createLocalSignerAdapter(account);
    const signed = await signOperation(p, signer);
    expect(signed.rpcUserOperation.signature).toBeDefined();
    expect(signed.rpcUserOperation.signature).toMatch(/^0x[0-9a-f]{576}$/);
    const [, , , , raw] = decodeAbiParameters(parseAbiParameters('uint8,uint8,uint48,uint48,bytes'), signed.rpcUserOperation.signature!);
    expect(await recoverTypedDataAddress({ domain: { name: 'AbstractWallet', version: '1', chainId: 421614, verifyingContract: account.address }, primaryType: 'WalletOperation', types: { WalletOperation: [{ name: 'userOpHash', type: 'bytes32' }, { name: 'validAfter', type: 'uint48' }, { name: 'validUntil', type: 'uint48' }] }, message: { userOpHash: p.userOpHash, validAfter: 1000, validUntil: 1100 }, signature: raw })).toBe(account.address);
    const auth = signed.eip7702Auth!;
    expect(auth.nonce).toBe('0x5');
    expect(await recoverAuthorizationAddress({ authorization: { chainId: 421614, address: D, nonce: 5, r: auth.r, s: auth.s, yParity: Number(BigInt(auth.yParity)) } })).toBe(account.address);
    await expect(signOperation(p, { ...signer, capabilities: { ...signer.capabilities, authorization: false } })).rejects.toThrow('UNSUPPORTED_SIGNER');
    const changed = structuredClone(p); changed.calls[0].value = 26n;
    await expect(signOperation(changed, signer)).rejects.toThrow('STALE_PREPARATION');
  });
  it('constructs a fresh cancellation with the complete original nonce and no business effect', () => {
    const original = prepareOperation({ ...input, nonce: (3n << 64n) + 7n });
    const cancelled = prepareCancellation(original, { gas: { ...input.gas, maxFeePerGas: 200n }, window: { validAfter: 1001n, validUntil: 1200n } });
    expect(decodeCalls(cancelled.rpcUserOperation.callData)).toEqual([{ target: A, value: 0n, data: '0x' }]);
    expect(cancelled.nonce).toBe(55340232221128654855n);
    expect(cancelled.config.chainId).toBe(421614); expect(cancelled.config.entryPoint).toBe(EP);
    expect(cancelled.rpcUserOperation.maxFeePerGas).toBe('0xc8');
    expect(cancelled.rpcUserOperation).not.toHaveProperty('signature');
    expect(cancelled.rpcUserOperation).not.toHaveProperty('paymaster');
    expect(original.calls[0].value).toBe(25n);
  });
  it('prepares independent native revocation with exact EOA nonce rules', async () => {
    expect(getAuthorizationNonce(5n, A, D)).toBe(5n);
    expect(getAuthorizationNonce(5n, A, A)).toBe(6n);
    expect(getAuthorizationNonce(9007199254740995n, A, D)).toBe(9007199254740995n);
    expect(() => getAuthorizationNonce(18446744073709551614n, A, A)).toThrow();
    const account = privateKeyToAccount(`0x${'00'.repeat(31)}01`);
    const prepared = prepareDelegationChange({ config: input.config, account: account.address, target: '0x0000000000000000000000000000000000000000', eoaNonce: 5n, outerSender: D });
    expect(prepared).not.toHaveProperty('rpcUserOperation');
    const auth = await signDelegationChange(prepared, createLocalSignerAdapter(account));
    expect(auth.address).toBe('0x0000000000000000000000000000000000000000'); expect(auth.nonce).toBe('0x5');
    expect(() => prepareDelegationChange({ ...prepared, target: EP })).toThrow();
  });
  it('counts authorization gas exactly once using an explicit fee convention', () => {
    expect(normalizePreVerificationGas({ gas: 50000n, includesAuthorizationCost: false }, 1)).toBe(75000n);
    expect(normalizePreVerificationGas({ gas: 75000n, includesAuthorizationCost: true }, 1)).toBe(75000n);
    expect(normalizePreVerificationGas({ gas: 50000n, includesAuthorizationCost: false }, 0)).toBe(50000n);
    expect(() => normalizePreVerificationGas({ gas: 50000n } as never, 1)).toThrow();
  });
});

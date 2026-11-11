import { expect, it } from 'vitest';
import { concat, decodeAbiParameters, hashTypedData, keccak256, parseAbiParameters, toHex, encodeAbiParameters } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { encodePaymasterData, permitDigest, prepareOperation, attachSponsorship } from '../src/index.js';
import type { PermitFields } from '../src/types.js';
import { A, D, EP, PM, input } from './fixtures.js';

export const fields: PermitFields = { chainId: 421614, paymaster: PM, expectedDelegate: D, sender: A, entryPoint: EP, nonce: 7n,
  initCodeHash: keccak256('0x7702000000000000000000000000000000000000'), callDataHash: keccak256('0x1234'),
  accountGasLimits: concat([toHex(100000n, { size: 16 }), toHex(80000n, { size: 16 })]), preVerificationGas: 50000n,
  gasFees: concat([toHex(1n, { size: 16 }), toHex(100n, { size: 16 })]), paymasterVerificationGasLimit: 60000n, paymasterPostOpGasLimit: 0n,
  validAfter: 1000n, validUntil: 1100n, maxCost: 29000000n, reservationId: `0x${'ab'.repeat(32)}` };
const pairs = [ ['version','uint8'], ['expectedDelegate','address'], ['sender','address'], ['entryPoint','address'], ['nonce','uint256'], ['initCodeHash','bytes32'], ['callDataHash','bytes32'], ['accountGasLimits','bytes32'], ['preVerificationGas','uint256'], ['gasFees','bytes32'], ['paymasterVerificationGasLimit','uint128'], ['paymasterPostOpGasLimit','uint128'], ['validAfter','uint48'], ['validUntil','uint48'], ['maxCost','uint256'], ['reservationId','bytes32'] ] as const;
const type = pairs.map(([name,type]) => ({ name, type }));
it('hashes and serializes the exact non-circular sponsorship permit', () => {
  const { chainId, paymaster, ...message } = fields;
  const expected = hashTypedData({ domain: { name: 'AbstractWalletPaymaster', version: '1', chainId: 421614, verifyingContract: PM }, primaryType: 'Permit', types: { Permit: type }, message: { version: 1, ...message } });
  expect(permitDigest(fields)).toBe(expected);
  const sig = `0x${'00'.repeat(31)}01${'00'.repeat(31)}011b` as const;
  const data = encodePaymasterData(fields, sig);
  expect((data.length - 2) / 2).toBe(352);
  expect(decodeAbiParameters(parseAbiParameters('uint8,address,uint48,uint48,uint256,bytes32,bytes'), data)).toEqual([1,D,1000,1100,29000000n,fields.reservationId,sig]);
  const sponsored = prepareOperation({ ...input, paymaster: { address: PM, verificationGasLimit: 60000n, postOpGasLimit: 0n, data } });
  expect(sponsored.userOpHash).not.toBe(prepareOperation(input).userOpHash);
  expect(() => encodePaymasterData({ ...fields, reservationId: `0x${'00'.repeat(32)}` }, sig)).toThrow();
});

it('attaches only an issued exact permit from the trusted sponsorship signer', async () => {
  const prepared = prepareOperation(input);
  const signer = privateKeyToAccount(`0x${'00'.repeat(31)}01`);
  const message = { version: 1, ...fields, callDataHash: keccak256(prepared.rpcUserOperation.callData) };
  const typedData = { domain: { name: 'AbstractWalletPaymaster', version: '1', chainId: 421614, verifyingContract: PM }, types: { Permit: type }, primaryType: 'Permit' as const, message };
  const sponsorSignature = await signer.signTypedData(typedData);
  const data = encodeAbiParameters(parseAbiParameters('uint8,address,uint48,uint48,uint256,bytes32,bytes'), [1,D,1000,1100,29000000n,fields.reservationId,sponsorSignature]);
  const permit = { permitVersion: '1' as const, chainId: '421614', entryPoint: EP, sender: A, expectedDelegate: D, nonce: '7', accountWindow: { validAfter: '1000', validUntil: '1100' }, maxCost: '29000000', chainReservationId: fields.reservationId, paymaster: PM, paymasterVerificationGasLimit: '60000', paymasterPostOpGasLimit: '0', paymasterData: data, permitDigest: hashTypedData(typedData), sponsorSignature };
  const result = await attachSponsorship(prepared, { state: 'issued', permit }, signer.address);
  expect(result?.rpcUserOperation.paymasterData).toBe(data);
  expect(result?.userOpHash).not.toBe(prepared.userOpHash);
  await expect(attachSponsorship(prepared, { state: 'pending', permit: null }, signer.address)).rejects.toThrow('SPONSORSHIP_PENDING');
  await expect(attachSponsorship(prepared, { state: 'issued', permit: { ...permit, accountWindow: { validAfter: '1000', validUntil: '1101' } } }, signer.address)).rejects.toThrow();
  await expect(attachSponsorship(prepared, { state: 'issued', permit }, A)).rejects.toThrow('INVALID_SPONSOR_SIGNATURE');
});

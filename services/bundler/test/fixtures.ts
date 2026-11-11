import { privateKeyToAccount } from 'viem/accounts';
import { createLocalSignerAdapter, prepareOperation, signOperation } from '../../../packages/sdk/src/index.js';
const EP = '0x3333333333333333333333333333333333333333';
const D = '0x2222222222222222222222222222222222222222';
const B = '0x5555555555555555555555555555555555555555';
export async function signedFixture() {
  const account = privateKeyToAccount(`0x${'00'.repeat(31)}01`);
  return signOperation(prepareOperation({ config: { chainId: 421614, rpcUrl: 'https://rpc.invalid', bundlerUrls: [], entryPoint: EP, delegate: D }, account: account.address, calls: [{ target: B, value: 1n, data: '0x' }], nonce: 0n, authorizationNonce: 0n, gas: { verificationGasLimit: 600000n, callGasLimit: 300000n, preVerificationGas: 100000n, maxPriorityFeePerGas: 1n, maxFeePerGas: 100n }, window: { validAfter: 1000n, validUntil: 1100n } }), createLocalSignerAdapter(account));
}

import type { Address, ChainConfig, PrepareInput } from '../src/types.js';
export const A = '0x1111111111111111111111111111111111111111' as Address;
export const D = '0x2222222222222222222222222222222222222222' as Address;
export const EP = '0x3333333333333333333333333333333333333333' as Address;
export const PM = '0x4444444444444444444444444444444444444444' as Address;
export const config: ChainConfig = { chainId: 421614, rpcUrl: 'https://rpc.invalid', bundlerUrls: ['https://bundler.invalid'], entryPoint: EP, delegate: D, paymaster: PM };
export const input: PrepareInput = { config, account: A, calls: [{ target: D, value: 25n, data: '0x1234' }], nonce: 7n, gas: { verificationGasLimit: 100000n, callGasLimit: 80000n, preVerificationGas: 50000n, maxPriorityFeePerGas: 1n, maxFeePerGas: 100n }, window: { validAfter: 1000n, validUntil: 1100n } };

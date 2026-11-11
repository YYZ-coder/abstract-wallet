import { encodeFunctionData, keccak256, toHex, type Address, type Hex, type LocalAccount } from 'viem';
import { entryPoint09Abi } from 'viem/account-abstraction';
import type { ChainAdapter } from './bundler.js';
export type RuntimeOptions = { rpcUrl: string; entryPoint: Address; delegate: Address; account: LocalAccount; fetchImpl?: typeof fetch };
export function createViemAdapter(options: RuntimeOptions): ChainAdapter {
  let id = 0; let nextOuterNonce = 0n;
  const rpc = async (method: string, params: unknown[] = []): Promise<any> => {
    const requestId = ++id;
    const response = await (options.fetchImpl ?? fetch)(options.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }), signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`UPSTREAM_HTTP_${response.status}`);
    const result = await response.json();
    if (result.id !== requestId || result.error) throw new Error(result.error?.message ?? 'INVALID_RPC_RESPONSE');
    return result.result;
  };
  const data = (bundle: Parameters<ChainAdapter['prepare']>[0]) => encodeFunctionData({ abi: entryPoint09Abi, functionName: 'handleOps', args: [[bundle.op as any], options.account.address] });
  const prepare: ChainAdapter['prepare'] = async bundle => {
    const pendingNonce = BigInt(await rpc('eth_getTransactionCount', [options.account.address, 'pending']));
    const nonce = pendingNonce > nextOuterNonce ? pendingNonce : nextOuterNonce;
    if (nonce > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('NONCE_NOT_SAFELY_SERIALIZABLE');
    const auth = bundle.authorization;
    if (auth && BigInt(auth.nonce) > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('NONCE_NOT_SAFELY_SERIALIZABLE');
    const fees = BigInt(bundle.op.gasFees);
    const transaction: any = { chainId: 421614, type: auth ? 'eip7702' : 'eip1559', to: options.entryPoint, data: data(bundle), nonce: Number(nonce), gas: bundle.outerGas, maxPriorityFeePerGas: fees >> 128n, maxFeePerGas: fees & ((1n << 128n) - 1n), value: 0n, ...(auth ? { authorizationList: [{ chainId: 421614, address: auth.address, nonce: Number(BigInt(auth.nonce)), yParity: Number(BigInt(auth.yParity)), r: auth.r, s: auth.s }] } : {}) };
    const rawTransaction = await options.account.signTransaction(transaction);
    nextOuterNonce = nonce + 1n;
    return { rawTransaction, transactionHash: keccak256(rawTransaction) };
  };
  const simulate: ChainAdapter['simulate'] = async bundle => {
    const fees = BigInt(bundle.op.gasFees);
    const call = { from: options.account.address, to: options.entryPoint, data: data(bundle), gas: toHex(bundle.outerGas), maxPriorityFeePerGas: toHex(fees >> 128n), maxFeePerGas: toHex(fees & ((1n << 128n) - 1n)) };
    await rpc('eth_call', [call, 'latest', ...(bundle.authorization ? [{ [bundle.sender]: { code: `0xef0100${options.delegate.slice(2)}` } }] : [])]);
  };
  const broadcast: ChainAdapter['broadcast'] = async rawTransaction => {
    try { return await rpc('eth_sendRawTransaction', [rawTransaction]); }
    catch (error) {
      const hash = keccak256(rawTransaction);
      try { const known = await rpc('eth_getTransactionByHash', [hash]); if (known?.hash?.toLowerCase() === hash.toLowerCase()) return hash; } catch { /* Preserve ambiguous broadcast outcome. */ }
      throw error;
    }
  };
  return {
    chainId: async () => { const value = BigInt(await rpc('eth_chainId')); if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('INVALID_CHAIN_ID'); return Number(value); },
    code: address => rpc('eth_getCode', [address, 'latest']),
    eoaNonce: async address => BigInt(await rpc('eth_getTransactionCount', [address, 'pending'])),
    timestamp: async () => BigInt((await rpc('eth_getBlockByNumber', ['latest', false])).timestamp),
    simulate, prepare, broadcast, receipt: hash => rpc('eth_getTransactionReceipt', [hash])
  };
}

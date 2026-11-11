import { concat, decodeAbiParameters, decodeEventLog, keccak256, parseAbiParameters, recoverAddress, toHex, type Address, type Hex } from 'viem';
import { entryPoint09Abi } from 'viem/account-abstraction';
import { authorizationDigest, decodeCalls, encodeCalls, encodeOperationSignature, packUserOperation, prepareOperation, validateAddress, validateHex, validateSignature } from '../../../packages/sdk/src/index.js';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
export type ChainAdapter = {
  chainId(): Promise<number>;
  code(address: Address): Promise<Hex>;
  eoaNonce(address: Address): Promise<bigint>;
  timestamp(): Promise<bigint>;
  simulate(bundle: Bundle): Promise<void>;
  prepare(bundle: Bundle): Promise<{ rawTransaction: Hex; transactionHash: Hex }>;
  broadcast(rawTransaction: Hex): Promise<Hex>;
  receipt(hash: Hex): Promise<any>;
};
export type Bundle = { sender: Address; op: Record<string, any>; userOpHash: Hex; authorization?: Record<string, any>; outerGas: bigint };
export type Options = { chainId: number; entryPoint: Address; delegate: Address; paymaster?: Address; beneficiary: Address; adapter: ChainAdapter; statePath?: string; maxOuterGas?: bigint; maxFeePerGas?: bigint; expectedCodeHashes?: { entryPoint: Hex; delegate: Hex; paymaster?: Hex } };
export class BundlerFault extends Error { constructor(public code: number, message: string) { super(message); } }
function quantity(value: unknown, name: string, max = (1n << 120n) - 1n): bigint {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value) || BigInt(value) > max) throw new BundlerFault(-32602, `INVALID_QUANTITY_${name}`);
  return BigInt(value);
}
export function createBundler(options: Options) {
  if (options.chainId !== 421614) throw new Error('TESTNET_ONLY');
  for (const address of [options.entryPoint, options.delegate, options.beneficiary, ...(options.paymaster ? [options.paymaster] : [])]) validateAddress(address);
  type Record = { userOpHash: Hex; sender: Address; nonce: Hex; rawTransaction: Hex; transactionHash: Hex; state: 'prepared' | 'accepted' | 'unknown' };
  const identity = { chainId: 421614, entryPoint: options.entryPoint.toLowerCase(), delegate: options.delegate.toLowerCase(), paymaster: options.paymaster?.toLowerCase() ?? null };
  const records = new Map<Hex, Record>(); let tail = Promise.resolve(); let persistenceFailed = false;
  if (options.statePath && existsSync(options.statePath)) {
    const persisted = JSON.parse(readFileSync(options.statePath, 'utf8'));
    if (JSON.stringify(persisted.identity) !== JSON.stringify(identity)) throw new Error('STATE_CONTEXT_MISMATCH');
    for (const record of persisted.records) records.set(record.userOpHash, record);
  }
  function save() {
    if (!options.statePath) return;
    try {
      mkdirSync(dirname(options.statePath), { recursive: true, mode: 0o700 });
      const temporary = `${options.statePath}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify({ identity, records: [...records.values()] }), { mode: 0o600, flush: true });
      renameSync(temporary, options.statePath);
    } catch { persistenceFailed = true; throw new BundlerFault(-32000, 'PERSISTENCE_UNAVAILABLE_RESTART_REQUIRED'); }
  }
  async function context() {
    if (await options.adapter.chainId() !== 421614) throw new BundlerFault(-32000, 'CHAIN_MISMATCH');
    for (const key of ['entryPoint', 'delegate', 'paymaster'] as const) {
      const address = options[key]; if (!address) continue;
      const code = await options.adapter.code(address);
      if (code === '0x' || (options.expectedCodeHashes?.[key] && keccak256(code) !== options.expectedCodeHashes[key])) throw new BundlerFault(-32000, 'DEPLOYMENT_MISMATCH');
    }
  }
  function operationInput(params: any[]) {
    const [op, ep] = params;
    if (params.length !== 2 || !op || typeof op !== 'object' || ep?.toLowerCase() !== options.entryPoint.toLowerCase()) throw new BundlerFault(-32602, 'INVALID_ENTRYPOINT_OR_OPERATION');
    validateAddress(op.sender); quantity(op.nonce, 'nonce', (1n << 256n) - 1n); validateHex(op.callData);
    if (op.factory !== '0x7702' || op.factoryData !== '0x' || encodeCalls(decodeCalls(op.callData)).toLowerCase() !== op.callData.toLowerCase()) throw new BundlerFault(-32602, 'INVALID_MARKER_OR_CALLS');
    if (op.paymaster && op.paymaster.toLowerCase() !== options.paymaster?.toLowerCase()) throw new BundlerFault(-32602, 'UNSUPPORTED_PAYMASTER');
    return op;
  }
  async function verifiedBundle(op: any): Promise<Bundle> {
    let window: { validAfter: bigint; validUntil: bigint }, rootSignature: Hex;
    try {
      const [version, kind, after, until, signature] = decodeAbiParameters(parseAbiParameters('uint8,uint8,uint48,uint48,bytes'), op.signature);
      window = { validAfter: BigInt(after), validUntil: BigInt(until) }; rootSignature = signature;
      if (version !== 1 || kind !== 1 || encodeOperationSignature(signature, window).toLowerCase() !== op.signature.toLowerCase()) throw new Error('INVALID_ENVELOPE');
    } catch { throw new BundlerFault(-32507, 'INVALID_ACCOUNT_SIGNATURE'); }
    const gas = { verificationGasLimit: quantity(op.verificationGasLimit, 'verificationGasLimit'), callGasLimit: quantity(op.callGasLimit, 'callGasLimit'), preVerificationGas: quantity(op.preVerificationGas, 'preVerificationGas'), maxPriorityFeePerGas: quantity(op.maxPriorityFeePerGas, 'maxPriorityFeePerGas'), maxFeePerGas: quantity(op.maxFeePerGas, 'maxFeePerGas') };
    if (gas.maxFeePerGas > (options.maxFeePerGas ?? 20000000000n) || gas.maxPriorityFeePerGas > gas.maxFeePerGas) throw new BundlerFault(-32602, 'FEE_CAP_EXCEEDED');
    const pm = op.paymaster ? { address: op.paymaster, verificationGasLimit: quantity(op.paymasterVerificationGasLimit, 'paymasterVerificationGasLimit'), postOpGasLimit: quantity(op.paymasterPostOpGasLimit, 'paymasterPostOpGasLimit'), data: op.paymasterData } : undefined;
    if (pm && (typeof pm.data !== 'string' || pm.data.length !== 706)) throw new BundlerFault(-32602, 'MALFORMED_PAYMASTER_DATA');
    const prepared = prepareOperation({ config: { chainId: 421614, rpcUrl: '', bundlerUrls: [], entryPoint: options.entryPoint, delegate: options.delegate, paymaster: options.paymaster }, account: op.sender, calls: decodeCalls(op.callData), nonce: quantity(op.nonce, 'nonce', (1n << 256n) - 1n), gas, window, paymaster: pm });
    if ((await recoverAddress({ hash: prepared.operationDigest, signature: rootSignature })).toLowerCase() !== op.sender.toLowerCase()) throw new BundlerFault(-32507, 'INVALID_ACCOUNT_SIGNATURE');
    const known = records.has(prepared.userOpHash);
    const now = await options.adapter.timestamp();
    if (!known && (now <= window.validAfter || now > window.validUntil)) throw new BundlerFault(-32503, 'OPERATION_OUT_OF_TIME_RANGE');
    const auth = op.eip7702Auth;
    if (op.sender.toLowerCase() === options.beneficiary.toLowerCase()) throw new BundlerFault(-32602, 'AUTHORITY_CANNOT_BE_BUNDLER');
    if (auth) {
      if (quantity(auth.chainId, 'authorization.chainId', (1n << 256n) - 1n) !== 421614n || auth.address?.toLowerCase() !== options.delegate.toLowerCase()) throw new BundlerFault(-32602, 'INVALID_AUTHORIZATION_CONTEXT');
      const nonce = quantity(auth.nonce, 'authorization.nonce', (1n << 64n) - 2n), parity = quantity(auth.yParity, 'authorization.yParity', 1n);
      if (![auth.r, auth.s].every(value => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value))) throw new BundlerFault(-32602, 'INVALID_AUTHORIZATION_SIGNATURE');
      const signature = concat([auth.r as Hex, auth.s as Hex, toHex(parity + 27n, { size: 1 })]);
      try {
        validateSignature(signature);
        if ((await recoverAddress({ hash: authorizationDigest(421614, options.delegate, nonce), signature })).toLowerCase() !== op.sender.toLowerCase()) throw new Error('WRONG_AUTHORITY');
      } catch { throw new BundlerFault(-32507, 'INVALID_AUTHORIZATION_SIGNATURE'); }
      if (!known && await options.adapter.eoaNonce(op.sender) !== nonce) throw new BundlerFault(-32602, 'AUTHORIZATION_NONCE_CHANGED');
    } else if (!known && (await options.adapter.code(op.sender)).toLowerCase() !== `0xef0100${options.delegate.slice(2).toLowerCase()}`) throw new BundlerFault(-32602, 'DELEGATION_MISMATCH');
    const outerGas = gas.verificationGasLimit + gas.callGasLimit + gas.preVerificationGas + (pm?.verificationGasLimit ?? 0n) + (pm?.postOpGasLimit ?? 0n) + 200000n;
    if (outerGas > (options.maxOuterGas ?? 5000000n)) throw new BundlerFault(-32602, 'GAS_CAP_EXCEEDED');
    return { sender: op.sender, op: { ...packUserOperation(prepared), signature: op.signature }, userOpHash: prepared.userOpHash, ...(auth ? { authorization: auth } : {}), outerGas };
  }
  return { handle: async (request: any): Promise<any> => {
    try {
      if (!request || request.jsonrpc !== '2.0' || !Array.isArray(request.params) || !['string','number'].includes(typeof request.id)) throw new BundlerFault(-32600, 'INVALID_REQUEST');
      await context();
      if (request.method === 'eth_supportedEntryPoints') return { jsonrpc: '2.0', id: request.id, result: [options.entryPoint] };
      if (request.method === 'eth_estimateUserOperationGas') {
        const op = operationInput(request.params);
        const auth = op.eip7702Auth;
        if (auth && (quantity(auth.chainId, 'authorization.chainId', (1n << 256n) - 1n) !== 421614n || auth.address?.toLowerCase() !== options.delegate.toLowerCase())) throw new BundlerFault(-32602, 'INVALID_AUTHORIZATION_CONTEXT');
        const callGasLimit = op.callGasLimit ? quantity(op.callGasLimit, 'callGasLimit') : 300000n;
        const verificationGasLimit = op.verificationGasLimit ? quantity(op.verificationGasLimit, 'verificationGasLimit') : 600000n;
        const estimated = 50000n + BigInt((op.callData.length - 2) / 2 + 288 + 1024 + (op.paymaster ? 404 : 0)) * 16n + (auth ? 25000n : 0n);
        const preVerificationGas = estimated > 100000n ? estimated : 100000n;
        return { jsonrpc: '2.0', id: request.id, result: { callGasLimit: toHex(callGasLimit > 300000n ? callGasLimit : 300000n), verificationGasLimit: toHex(verificationGasLimit > 600000n ? verificationGasLimit : 600000n), preVerificationGas: toHex(preVerificationGas), ...(op.paymaster ? { paymasterVerificationGasLimit: toHex(200000n), paymasterPostOpGasLimit: '0x0' } : {}), estimationSource: 'configured-conservative-upper-bound' } };
      }
      if (request.method === 'eth_sendUserOperation') {
        const op = operationInput(request.params);
        const work = tail.then(async () => {
          if (persistenceFailed) throw new BundlerFault(-32000, 'PERSISTENCE_UNAVAILABLE_RESTART_REQUIRED');
          const bundle = await verifiedBundle(op);
          let record = records.get(bundle.userOpHash);
          if (record?.state === 'accepted') return bundle.userOpHash;
          if (!record) {
            try { await options.adapter.simulate(bundle); } catch { throw new BundlerFault(-32500, 'SIMULATION_FAILED'); }
            const signed = await options.adapter.prepare(bundle);
            record = { userOpHash: bundle.userOpHash, sender: bundle.sender, nonce: op.nonce, ...signed, state: 'prepared' };
            records.set(bundle.userOpHash, record); save();
          }
          try {
            const hash = await options.adapter.broadcast(record.rawTransaction);
            if (hash !== record.transactionHash) throw new Error('HASH_MISMATCH');
            record.state = 'accepted'; save(); return bundle.userOpHash;
          } catch {
            record.state = 'unknown'; save(); throw new BundlerFault(-32000, 'BROADCAST_RESULT_UNKNOWN');
          }
        });
        tail = work.then(() => undefined, () => undefined);
        return { jsonrpc: '2.0', id: request.id, result: await work };
      }
      if (request.method === 'eth_getUserOperationReceipt') {
        const [hash] = request.params;
        if (request.params.length !== 1 || typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new BundlerFault(-32602, 'INVALID_USER_OPERATION_HASH');
        const record = records.get(hash as Hex);
        let result: any = null;
        if (record) {
          const receipt = await options.adapter.receipt(record.transactionHash);
          if (receipt) for (const log of receipt.logs ?? []) {
            if (log.address.toLowerCase() !== options.entryPoint.toLowerCase()) continue;
            try {
              const event = decodeEventLog({ abi: entryPoint09Abi, data: log.data, topics: log.topics });
              if (event.eventName !== 'UserOperationEvent') continue;
              const args = event.args;
              if (args.userOpHash.toLowerCase() !== hash.toLowerCase() || args.sender.toLowerCase() !== record.sender.toLowerCase() || args.nonce !== BigInt(record.nonce)) continue;
              result = { userOpHash: hash, entryPoint: options.entryPoint, sender: args.sender, nonce: toHex(args.nonce), paymaster: args.paymaster, actualGasCost: toHex(args.actualGasCost), actualGasUsed: toHex(args.actualGasUsed), success: args.success, logs: receipt.logs, receipt };
            } catch { /* Unrelated EntryPoint events are not UserOperation evidence. */ }
          }
        }
        return { jsonrpc: '2.0', id: request.id, result };
      }
      throw new BundlerFault(-32601, 'METHOD_NOT_FOUND');
    } catch (error) {
      return { jsonrpc: '2.0', id: request?.id ?? null, error: { code: error instanceof BundlerFault ? error.code : -32000, message: error instanceof Error ? error.message.slice(0, 200) : 'UPSTREAM_UNAVAILABLE' } };
    }
  } };
}

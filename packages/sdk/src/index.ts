export * from './types.js';
import type { Call, Hex, PrepareInput, PreparedOperation, SignerAdapter, SignedOperation, ChainConfig, FetchLike, PermitFields, GasFields, TimeWindow, PaymasterFields, SponsorshipPermit } from './types.js';
import type { LocalAccount } from 'viem';
import { concat, decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeFunctionData, hashTypedData, isAddress, keccak256, parseAbi, parseAbiParameters, recoverAddress, toHex, toRlp } from 'viem';
export const UINT256_MAX = (1n << 256n) - 1n;
export function parseInteger(input: string, max = UINT256_MAX): bigint {
  if (typeof input !== 'string' || !/^(0|[1-9][0-9]*)$/.test(input)) throw new Error('INVALID_INTEGER');
  const value = BigInt(input);
  if (value > max) throw new Error('INTEGER_OVERFLOW');
  return value;
}
export const CALL_ABI = parseAbi(['function executeBatch((address target,uint256 value,bytes data)[] calls) payable returns (bytes[])']);
export function validateAddress(address: string): asserts address is `0x${string}` {
  if (!isAddress(address, { strict: true })) throw new Error('INVALID_ADDRESS');
}
export function validateHex(data: string): asserts data is Hex {
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(data)) throw new Error('INVALID_HEX');
}
export function encodeCalls(calls: Call[]): Hex {
  if (calls.length < 1 || calls.length > 16) throw new Error('INVALID_BATCH_SIZE');
  let bytes = 0;
  for (const call of calls) {
    validateAddress(call.target); validateHex(call.data); parseInteger(String(call.value));
    bytes += (call.data.length - 2) / 2;
  }
  if (bytes > 32768) throw new Error('CALL_DATA_TOO_LARGE');
  return encodeFunctionData({ abi: CALL_ABI, functionName: 'executeBatch', args: [calls] });
}
export function decodeCalls(data: Hex): Call[] {
  const decoded = decodeFunctionData({ abi: CALL_ABI, data });
  return [...decoded.args[0]];
}
export function prepareOperation(input: PrepareInput): PreparedOperation {
  const copy = structuredClone(input);
  for (const address of [copy.account, copy.config.entryPoint, copy.config.delegate]) validateAddress(address);
  if (!Number.isSafeInteger(copy.config.chainId) || copy.config.chainId < 1) throw new Error('UNSUPPORTED_CHAIN');
  parseInteger(String(copy.nonce)); validateWindow(copy.window);
  for (const value of Object.values(copy.gas)) parseInteger(String(value), (1n << 120n) - 1n);
  if (copy.gas.maxPriorityFeePerGas > copy.gas.maxFeePerGas) throw new Error('INVALID_GAS_PRICE');
  const callData = encodeCalls(copy.calls);
  const p = copy.paymaster;
  if (p) {
    validateAddress(p.address); validateHex(p.data);
    parseInteger(String(p.verificationGasLimit), (1n << 120n) - 1n);
    parseInteger(String(p.postOpGasLimit), (1n << 120n) - 1n);
  }
  const rpcUserOperation = {
    sender: copy.account, nonce: toHex(copy.nonce), factory: '0x7702' as const, factoryData: '0x' as const, callData,
    ...Object.fromEntries(Object.entries(copy.gas).map(([key, value]) => [key, toHex(value)])),
    ...(p ? { paymaster: p.address, paymasterVerificationGasLimit: toHex(p.verificationGasLimit), paymasterPostOpGasLimit: toHex(p.postOpGasLimit), paymasterData: p.data } : {})
  } as PreparedOperation['rpcUserOperation'];
  const packed = packUserOperation({ ...copy, rpcUserOperation } as PreparedOperation);
  const userOpHash = hashTypedData({
    domain: { name: 'ERC4337', version: '1', chainId: copy.config.chainId, verifyingContract: copy.config.entryPoint },
    primaryType: 'PackedUserOperation', types: { PackedUserOperation: [
      { name: 'sender', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'initCode', type: 'bytes' },
      { name: 'callData', type: 'bytes' }, { name: 'accountGasLimits', type: 'bytes32' }, { name: 'preVerificationGas', type: 'uint256' },
      { name: 'gasFees', type: 'bytes32' }, { name: 'paymasterAndData', type: 'bytes' }
    ] }, message: { ...packed, initCode: copy.config.delegate }
  });
  const prepared = { ...copy, rpcUserOperation, userOpHash, operationDigest: '0x' as Hex };
  prepared.operationDigest = hashTypedData(operationTypedData(prepared));
  return prepared;
}
export function validateWindow(window: { validAfter: bigint; validUntil: bigint }): void {
  if (window.validAfter < 0n || window.validAfter >= window.validUntil || window.validUntil >= (1n << 47n)) throw new Error('INVALID_TIME_WINDOW');
}
export const INIT_CODE_MARKER = '0x7702000000000000000000000000000000000000' as const;
export function packUserOperation(prepared: PreparedOperation) {
  const { gas, paymaster: p } = prepared;
  return {
    sender: prepared.account, nonce: prepared.nonce, initCode: INIT_CODE_MARKER,
    callData: prepared.rpcUserOperation.callData,
    accountGasLimits: concat([toHex(gas.verificationGasLimit, { size: 16 }), toHex(gas.callGasLimit, { size: 16 })]),
    preVerificationGas: gas.preVerificationGas,
    gasFees: concat([toHex(gas.maxPriorityFeePerGas, { size: 16 }), toHex(gas.maxFeePerGas, { size: 16 })]),
    paymasterAndData: p ? concat([p.address, toHex(p.verificationGasLimit, { size: 16 }), toHex(p.postOpGasLimit, { size: 16 }), p.data]) : '0x' as Hex,
  };
}
export function operationTypedData(prepared: PreparedOperation) {
  return {
    domain: { name: 'AbstractWallet', version: '1', chainId: prepared.config.chainId, verifyingContract: prepared.account },
    primaryType: 'WalletOperation' as const,
    types: { WalletOperation: [{ name: 'userOpHash', type: 'bytes32' }, { name: 'validAfter', type: 'uint48' }, { name: 'validUntil', type: 'uint48' }] },
    message: { userOpHash: prepared.userOpHash, validAfter: Number(prepared.window.validAfter), validUntil: Number(prepared.window.validUntil) }
  } as const;
}
export function validateSignature(signature: Hex): void {
  validateHex(signature);
  if (signature.length !== 132) throw new Error('INVALID_SIGNATURE_LENGTH');
  const r = BigInt(`0x${signature.slice(2, 66)}`), s = BigInt(`0x${signature.slice(66, 130)}`), v = signature.slice(130);
  if (r < 1n || r >= 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n || s < 1n || s > 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n || !['1b', '1c'].includes(v.toLowerCase())) throw new Error('INVALID_SIGNATURE');
}
export function encodeOperationSignature(signature: Hex, window: { validAfter: bigint; validUntil: bigint }): Hex {
  validateSignature(signature); validateWindow(window);
  return encodeAbiParameters(parseAbiParameters('uint8,uint8,uint48,uint48,bytes'), [1, 1, Number(window.validAfter), Number(window.validUntil), signature]);
}
export function authorizationDigest(chainId: number, address: `0x${string}`, nonce: bigint): Hex {
  if (!Number.isSafeInteger(chainId) || chainId < 1) throw new Error('INVALID_AUTHORIZATION_CHAIN');
  validateAddress(address); parseInteger(String(nonce), (1n << 64n) - 2n);
  return keccak256(concat(['0x05', toRlp([toHex(chainId), address, nonce === 0n ? '0x' : toHex(nonce)])]));
}
export function createLocalSignerAdapter(account: LocalAccount): SignerAdapter {
  return {
    address: account.address, capabilities: { typedData: true, authorization: !!account.sign, personalSign: true },
    signTypedData: account.signTypedData,
    signAuthorization: account.sign ? async ({ chainId, contractAddress, nonce }) => {
      const signature = await account.sign!({ hash: authorizationDigest(chainId, contractAddress, nonce) });
      validateSignature(signature);
      return { chainId: toHex(chainId), address: contractAddress, nonce: toHex(nonce), yParity: toHex(BigInt(`0x${signature.slice(130)}`) - 27n), r: `0x${signature.slice(2, 66)}`, s: `0x${signature.slice(66, 130)}` };
    } : undefined
  };
}
export async function signOperation(prepared: PreparedOperation, signer: SignerAdapter): Promise<SignedOperation> {
  const rebuilt = prepareOperation(prepared);
  if (rebuilt.userOpHash !== prepared.userOpHash || rebuilt.operationDigest !== prepared.operationDigest || JSON.stringify(rebuilt.rpcUserOperation) !== JSON.stringify(prepared.rpcUserOperation)) throw new Error('STALE_PREPARATION');
  if (signer.address.toLowerCase() !== prepared.account.toLowerCase()) throw new Error('SIGNER_MISMATCH');
  if (!signer.capabilities.typedData || (prepared.authorizationNonce !== undefined && (!signer.capabilities.authorization || !signer.signAuthorization))) throw new Error('UNSUPPORTED_SIGNER');
  const eip7702Auth = prepared.authorizationNonce === undefined ? undefined : await signer.signAuthorization!({ chainId: prepared.config.chainId, contractAddress: prepared.config.delegate, nonce: prepared.authorizationNonce });
  if (eip7702Auth) {
    if (BigInt(eip7702Auth.chainId) !== BigInt(prepared.config.chainId) || BigInt(eip7702Auth.nonce) !== prepared.authorizationNonce || eip7702Auth.address.toLowerCase() !== prepared.config.delegate.toLowerCase()) throw new Error('INVALID_AUTHORIZATION');
    const raw = concat([eip7702Auth.r, eip7702Auth.s, toHex(Number(BigInt(eip7702Auth.yParity)) + 27, { size: 1 })]);
    validateSignature(raw);
    const authority = await recoverAddress({ hash: authorizationDigest(prepared.config.chainId, eip7702Auth.address, BigInt(eip7702Auth.nonce)), signature: raw });
    if (authority.toLowerCase() !== prepared.account.toLowerCase()) throw new Error('INVALID_AUTHORIZATION');
  }
  const raw = await signer.signTypedData(operationTypedData(prepared));
  validateSignature(raw);
  if ((await recoverAddress({ hash: prepared.operationDigest, signature: raw })).toLowerCase() !== prepared.account.toLowerCase()) throw new Error('INVALID_SIGNATURE');
  return { prepared, rpcUserOperation: { ...prepared.rpcUserOperation, signature: encodeOperationSignature(raw, prepared.window) }, ...(eip7702Auth ? { eip7702Auth } : {}), userOpHash: prepared.userOpHash };
}
export class RpcError extends Error {
  constructor(public code: number | string, message: string, public data?: unknown) { super(message); }
}
export function createWalletClientTransport(config: ChainConfig, fetchImpl: FetchLike = fetch) {
  const context = structuredClone(config); let id = 0;
  async function request(url: string, method: string, params: unknown[] = []): Promise<any> {
    const requestId = ++id;
    const response = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) });
    if (!response.ok) throw new Error(`UPSTREAM_HTTP_${response.status}`);
    const body = await response.json();
    if (!body || body.jsonrpc !== '2.0' || body.id !== requestId) throw new Error('INVALID_RPC_RESPONSE');
    if (body.error) throw new RpcError(body.error.code, body.error.message, body.error.data);
    if (!Object.hasOwn(body, 'result')) throw new Error('INVALID_RPC_RESPONSE');
    return body.result;
  }
  const rpc = (method: string, params: unknown[] = []) => request(context.rpcUrl, method, params);
  const bundler = (method: string, params: unknown[] = [], index = 0) => {
    if (!context.bundlerUrls[index]) throw new Error('UNSUPPORTED_BUNDLER');
    return request(context.bundlerUrls[index], method, params);
  };
  async function assertChain() {
    if (BigInt(await rpc('eth_chainId')) !== BigInt(context.chainId)) throw new Error('CHAIN_MISMATCH');
  }
  async function submit(signed: SignedOperation, index = 0): Promise<{ admission: 'accepted' | 'unknown' | 'rejected'; userOpHash: Hex; error?: unknown }> {
    const p = signed.prepared;
    if (p.config.chainId !== context.chainId || p.config.entryPoint.toLowerCase() !== context.entryPoint.toLowerCase() || p.config.delegate.toLowerCase() !== context.delegate.toLowerCase()) throw new Error('CHAIN_MISMATCH');
    const rebuilt = prepareOperation(p);
    const { signature, ...unsigned } = signed.rpcUserOperation;
    if (JSON.stringify(unsigned) !== JSON.stringify(rebuilt.rpcUserOperation) || signed.userOpHash !== rebuilt.userOpHash || !signature) throw new Error('STALE_PREPARATION');
    await assertChain();
    const entries: string[] = await bundler('eth_supportedEntryPoints', [], index);
    if (!entries.some(ep => ep.toLowerCase() === context.entryPoint.toLowerCase())) throw new Error('UNSUPPORTED_ENTRYPOINT');
    const operation = { ...signed.rpcUserOperation, ...(signed.eip7702Auth ? { eip7702Auth: signed.eip7702Auth } : {}) };
    try {
      const result = await bundler('eth_sendUserOperation', [operation, context.entryPoint], index);
      if (result !== signed.userOpHash) throw new Error('HASH_MISMATCH');
      return { admission: 'accepted', userOpHash: signed.userOpHash };
    } catch (error) {
      return { admission: error instanceof RpcError ? 'rejected' : 'unknown', userOpHash: signed.userOpHash, error };
    }
  }
  const readAccountState = async (account: `0x${string}`) => {
    validateAddress(account); await assertChain();
    const [code, delegateCode, entryPointCode, eoaNonce, balance, nonceData] = await Promise.all([
      rpc('eth_getCode', [account, 'latest']), rpc('eth_getCode', [context.delegate, 'latest']), rpc('eth_getCode', [context.entryPoint, 'latest']),
      rpc('eth_getTransactionCount', [account, 'pending']), rpc('eth_getBalance', [account, 'latest']),
      rpc('eth_call', [{ to: context.entryPoint, data: encodeFunctionData({ abi: parseAbi(['function getNonce(address sender,uint192 key) view returns(uint256)']), functionName: 'getNonce', args: [account, 0n] }) }, 'latest'])
    ]);
    if (delegateCode === '0x' || entryPointCode === '0x') throw new Error('DEPLOYMENT_MISMATCH');
    return { delegation: classifyDelegation(code, context.delegate), eoaNonce: BigInt(eoaNonce), entryPointNonce: decodeAbiParameters(parseAbiParameters('uint256'), nonceData)[0], balance: BigInt(balance), code: code as Hex };
  };
  const estimateGas = async (op: PreparedOperation['rpcUserOperation'], auth?: SignedOperation['eip7702Auth']) => {
    await assertChain();
    const result = await bundler('eth_estimateUserOperationGas', [{ ...op, signature: op.signature ?? SIMULATION_SIGNATURE, ...(auth ? { eip7702Auth: auth } : {}) }, context.entryPoint]);
    const limit = (name: string) => {
      if (typeof result?.[name] !== 'string' || !/^0x[0-9a-fA-F]+$/.test(result[name])) throw new Error('INVALID_GAS_ESTIMATE');
      return parseInteger(BigInt(result[name]).toString(), (1n << 120n) - 1n);
    };
    return { verificationGasLimit: limit('verificationGasLimit'), callGasLimit: limit('callGasLimit'), preVerificationGas: limit('preVerificationGas'), ...(result.paymasterVerificationGasLimit === undefined ? {} : { paymasterVerificationGasLimit: limit('paymasterVerificationGasLimit') }) };
  };
  const gasPrice = async () => { await assertChain(); return parseInteger(BigInt(await rpc('eth_gasPrice')).toString(), (1n << 120n) - 1n); };
  const getReceipt = async (hash: Hex, index = 0): Promise<any> => {
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error('INVALID_HASH');
    await assertChain(); return bundler('eth_getUserOperationReceipt', [hash], index);
  };
  return { config: context, rpc, bundler, assertChain, submit, readAccountState, estimateGas, gasPrice, getReceipt };
}
export const SIMULATION_SIGNATURE = encodeOperationSignature(`0x${'00'.repeat(31)}01${'00'.repeat(31)}011b`, { validAfter: 0n, validUntil: (1n << 47n) - 1n });
export function classifyDelegation(code: Hex | null, expectedDelegate: `0x${string}`) {
  if (code === null) return { status: 'unknown' as const, actualDelegate: null };
  validateHex(code);
  if (code === '0x') return { status: 'none' as const, actualDelegate: null };
  if (!/^0xef0100[0-9a-fA-F]{40}$/.test(code)) return { status: 'unsupported' as const, actualDelegate: null };
  const actualDelegate = `0x${code.slice(8)}` as `0x${string}`;
  return { status: actualDelegate.toLowerCase() === expectedDelegate.toLowerCase() ? 'expected' as const : 'other' as const, actualDelegate };
}
export function sendOperation(transport: ReturnType<typeof createWalletClientTransport>, signed: SignedOperation, index = 0) { return transport.submit(signed, index); }
export const PERMIT_TYPES = { Permit: [
  { name: 'version', type: 'uint8' }, { name: 'expectedDelegate', type: 'address' }, { name: 'sender', type: 'address' },
  { name: 'entryPoint', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'initCodeHash', type: 'bytes32' },
  { name: 'callDataHash', type: 'bytes32' }, { name: 'accountGasLimits', type: 'bytes32' }, { name: 'preVerificationGas', type: 'uint256' },
  { name: 'gasFees', type: 'bytes32' }, { name: 'paymasterVerificationGasLimit', type: 'uint128' }, { name: 'paymasterPostOpGasLimit', type: 'uint128' },
  { name: 'validAfter', type: 'uint48' }, { name: 'validUntil', type: 'uint48' }, { name: 'maxCost', type: 'uint256' }, { name: 'reservationId', type: 'bytes32' }
] } as const;
export function permitTypedData(fields: PermitFields) {
  validateWindow(fields);
  for (const address of [fields.paymaster, fields.expectedDelegate, fields.sender, fields.entryPoint]) validateAddress(address);
  if (!/^0x[0-9a-fA-F]{64}$/.test(fields.reservationId) || BigInt(fields.reservationId) === 0n) throw new Error('INVALID_RESERVATION_ID');
  const { chainId, paymaster, ...message } = fields;
  return { domain: { name: 'AbstractWalletPaymaster', version: '1', chainId, verifyingContract: paymaster }, primaryType: 'Permit' as const, types: PERMIT_TYPES, message: { version: 1, ...message, validAfter: Number(fields.validAfter), validUntil: Number(fields.validUntil) } } as const;
}
export function permitDigest(fields: PermitFields): Hex { return hashTypedData(permitTypedData(fields)); }
export function encodePaymasterData(fields: PermitFields, signature: Hex): Hex {
  permitTypedData(fields); validateSignature(signature); parseInteger(String(fields.maxCost));
  return encodeAbiParameters(parseAbiParameters('uint8,address,uint48,uint48,uint256,bytes32,bytes'), [1, fields.expectedDelegate, Number(fields.validAfter), Number(fields.validUntil), fields.maxCost, fields.reservationId, signature]);
}
export function interpretOperationReceipt(receipt: any, options: { canonical?: boolean; confirmations?: number; requiredConfirmations?: number } = {}) {
  if (options.canonical === false) return { execution: 'unknown' as const, confirmation: 'reorged' as const };
  if (!receipt || typeof receipt.success !== 'boolean' || !receipt.receipt?.blockHash) return { execution: 'unknown' as const, confirmation: 'unknown' as const };
  return {
    execution: receipt.success ? 'succeeded' as const : 'reverted' as const,
    confirmation: (options.confirmations ?? 0) >= (options.requiredConfirmations ?? 1) ? 'confirmed' as const : 'pending' as const
  };
}
export function prepareCancellation(original: PreparedOperation, options: { gas: GasFields; window: TimeWindow; paymaster?: PaymasterFields; authorizationNonce?: bigint }): PreparedOperation {
  return prepareOperation({ config: original.config, account: original.account, nonce: original.nonce, calls: [{ target: original.account, value: 0n, data: '0x' }], ...options });
}
export function getAuthorizationNonce(eoaNonce: bigint, account: `0x${string}`, outerSender: `0x${string}`): bigint {
  validateAddress(account); validateAddress(outerSender);
  return parseInteger(String(eoaNonce + (account.toLowerCase() === outerSender.toLowerCase() ? 1n : 0n)), (1n << 64n) - 2n);
}
export function prepareDelegationChange(input: { config: ChainConfig; account: `0x${string}`; target: `0x${string}`; eoaNonce: bigint; outerSender: `0x${string}` }) {
  if (input.target.toLowerCase() !== input.config.delegate.toLowerCase() && input.target !== '0x0000000000000000000000000000000000000000') throw new Error('UNSUPPORTED_DELEGATE');
  const authorizationNonce = getAuthorizationNonce(input.eoaNonce, input.account, input.outerSender);
  return { ...structuredClone(input), authorizationNonce, digest: authorizationDigest(input.config.chainId, input.target, authorizationNonce) };
}
export async function signDelegationChange(prepared: ReturnType<typeof prepareDelegationChange>, signer: SignerAdapter) {
  if (!signer.capabilities.authorization || !signer.signAuthorization) throw new Error('UNSUPPORTED_SIGNER');
  if (signer.address.toLowerCase() !== prepared.account.toLowerCase()) throw new Error('SIGNER_MISMATCH');
  if (prepareDelegationChange(prepared).digest !== prepared.digest) throw new Error('STALE_PREPARATION');
  const auth = await signer.signAuthorization({ chainId: prepared.config.chainId, contractAddress: prepared.target, nonce: prepared.authorizationNonce });
  if (auth.address.toLowerCase() !== prepared.target.toLowerCase() || BigInt(auth.chainId) !== BigInt(prepared.config.chainId) || BigInt(auth.nonce) !== prepared.authorizationNonce) throw new Error('INVALID_AUTHORIZATION');
  const raw = concat([auth.r, auth.s, toHex(Number(BigInt(auth.yParity)) + 27, { size: 1 })]); validateSignature(raw);
  if ((await recoverAddress({ hash: prepared.digest, signature: raw })).toLowerCase() !== prepared.account.toLowerCase()) throw new Error('INVALID_AUTHORIZATION');
  return auth;
}
export function createUnsignedAuthorization(chainId: number, address: `0x${string}`, nonce: bigint) {
  authorizationDigest(chainId, address, nonce);
  return { chainId: toHex(chainId), address, nonce: toHex(nonce), yParity: '0x0' as Hex, r: `0x${'00'.repeat(32)}` as Hex, s: `0x${'00'.repeat(32)}` as Hex };
}
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message); }
}
export function createBackendClient(baseUrl: string, fetchImpl: FetchLike = fetch) {
  async function request(path: string, body?: unknown, token?: string): Promise<any> {
    const json = body === undefined ? undefined : JSON.stringify(body, (key, value) => {
      if (/^(privateKey|mnemonic|seed|secretKey)$/i.test(key)) throw new Error('FORBIDDEN_SECRET');
      if (typeof value === 'bigint') throw new Error('DTO_REQUIRES_DECIMAL_STRINGS');
      return value;
    });
    const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(json === undefined ? {} : { body: json }) });
    const result = await response.json();
    if (!response.ok) throw new ApiError(response.status, result.error?.code ?? 'HTTP_ERROR', result.error?.message ?? 'Backend request failed', result.error?.details);
    return result;
  }
  return { request, createSponsorship: (body: unknown, token: string) => request('/v1/sponsorships', body, token) };
}
export async function attachSponsorship(prepared: PreparedOperation, record: { state: string; permit: SponsorshipPermit | null }, trustedSponsorSigner: `0x${string}`): Promise<PreparedOperation> {
  const permit = record.permit;
  if (record.state !== 'issued' || !permit) throw new Error('SPONSORSHIP_PENDING');
  validateAddress(trustedSponsorSigner);
  if (permit.permitVersion !== '1' || parseInteger(permit.chainId) !== BigInt(prepared.config.chainId) || parseInteger(permit.nonce) !== prepared.nonce || permit.sender.toLowerCase() !== prepared.account.toLowerCase() || permit.entryPoint.toLowerCase() !== prepared.config.entryPoint.toLowerCase() || permit.expectedDelegate.toLowerCase() !== prepared.config.delegate.toLowerCase() || permit.paymaster.toLowerCase() !== prepared.config.paymaster?.toLowerCase()) throw new Error('SPONSORSHIP_MISMATCH');
  const window = { validAfter: parseInteger(permit.accountWindow.validAfter), validUntil: parseInteger(permit.accountWindow.validUntil) };
  if (window.validAfter !== prepared.window.validAfter || window.validUntil !== prepared.window.validUntil) throw new Error('VALIDITY_WINDOW_MISMATCH');
  if (permit.paymasterData.length !== 706) throw new Error('MALFORMED_PAYMASTER_DATA');
  const [version, delegate, after, until, maxCost, reservationId, signature] = decodeAbiParameters(parseAbiParameters('uint8,address,uint48,uint48,uint256,bytes32,bytes'), permit.paymasterData);
  if (version !== 1 || delegate.toLowerCase() !== permit.expectedDelegate.toLowerCase() || BigInt(after) !== window.validAfter || BigInt(until) !== window.validUntil || maxCost !== parseInteger(permit.maxCost) || reservationId.toLowerCase() !== permit.chainReservationId.toLowerCase() || signature.toLowerCase() !== permit.sponsorSignature.toLowerCase()) throw new Error('SPONSORSHIP_MISMATCH');
  const pmGas = parseInteger(permit.paymasterVerificationGasLimit, (1n << 120n) - 1n), postGas = parseInteger(permit.paymasterPostOpGasLimit, (1n << 120n) - 1n);
  const packed = packUserOperation(prepared);
  const fields: PermitFields = { chainId: prepared.config.chainId, paymaster: permit.paymaster, expectedDelegate: prepared.config.delegate, sender: prepared.account, entryPoint: prepared.config.entryPoint, nonce: prepared.nonce, initCodeHash: keccak256(INIT_CODE_MARKER), callDataHash: keccak256(prepared.rpcUserOperation.callData), accountGasLimits: packed.accountGasLimits, preVerificationGas: prepared.gas.preVerificationGas, gasFees: packed.gasFees, paymasterVerificationGasLimit: pmGas, paymasterPostOpGasLimit: postGas, ...window, maxCost, reservationId };
  if (encodePaymasterData(fields, signature).toLowerCase() !== permit.paymasterData.toLowerCase()) throw new Error('MALFORMED_PAYMASTER_DATA');
  const digest = permitDigest(fields);
  if (digest.toLowerCase() !== permit.permitDigest.toLowerCase() || (await recoverAddress({ hash: digest, signature })).toLowerCase() !== trustedSponsorSigner.toLowerCase()) throw new Error('INVALID_SPONSOR_SIGNATURE');
  const requiredCost = (prepared.gas.verificationGasLimit + prepared.gas.callGasLimit + prepared.gas.preVerificationGas + pmGas + postGas) * prepared.gas.maxFeePerGas;
  if (requiredCost > maxCost) throw new Error('COST_CAP_EXCEEDED');
  return prepareOperation({ ...prepared, paymaster: { address: permit.paymaster, verificationGasLimit: pmGas, postOpGasLimit: postGas, data: permit.paymasterData } });
}
export function normalizePreVerificationGas(quote: { gas: bigint; includesAuthorizationCost: boolean }, authorizationCount: number): bigint {
  if (typeof quote.includesAuthorizationCost !== 'boolean' || !Number.isSafeInteger(authorizationCount) || authorizationCount < 0) throw new Error('UNKNOWN_FEE_CONVENTION');
  parseInteger(String(quote.gas), (1n << 120n) - 1n);
  return parseInteger(String(quote.gas + (quote.includesAuthorizationCost ? 0n : BigInt(authorizationCount) * 25000n)), (1n << 120n) - 1n);
}
export function parseAmount(input: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new Error('INVALID_DECIMALS');
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/.exec(input);
  if (!match || (match[2]?.length ?? 0) > decimals) throw new Error('INVALID_AMOUNT');
  return parseInteger((match[1] + (match[2] ?? '').padEnd(decimals, '0')).replace(/^0+(?=\d)/, ''));
}

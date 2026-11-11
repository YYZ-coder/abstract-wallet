import { getAddress, getTypesForEIP712Domain, isAddress, recoverTypedDataAddress, recoverMessageAddress, serializeTypedData, stringToHex, validateTypedData, type Address, type Hex, type TypedDataDomain } from 'viem';
import { validateSignature, type SignerAdapter } from '@abstract-wallet/sdk';

export type WalletProvider = {
  request(args: { method: string; params?: readonly unknown[] | object }): Promise<unknown>;
  on?(event: string, listener: (...args: any[]) => void): void;
  removeListener?(event: string, listener: (...args: any[]) => void): void;
};
export type WalletHost = EventTarget & { ethereum?: WalletProvider };
export type ExternalWalletChoice = { id: string; name: string; provider: WalletProvider };
export type WalletInvalidation = 'accountsChanged' | 'chainChanged' | 'disconnect';
export type CapabilityStatus = 'unknown' | 'supported' | 'unsupported';
export type ExternalWalletConnection = {
  address: Address; chainId: 421614; walletId: string; walletName: string;
  signer: SignerAdapter;
  capabilityStatus: { typedData: CapabilityStatus; personalSign: CapabilityStatus; authorization: CapabilityStatus; nativeTransaction: CapabilityStatus };
  signMessage(message: string): Promise<Hex>;
  assertActive(): Promise<void>;
  subscribeInvalidation(listener: (reason: WalletInvalidation) => void): () => void;
  disconnect(): void;
};
export function discoverExternalWallets(host: WalletHost = window): { list(): ExternalWalletChoice[]; subscribe(listener: (wallets: ExternalWalletChoice[]) => void): () => void; dispose(): void } {
  const wallets = new Map<string, ExternalWalletChoice>();
  const listeners = new Set<(wallets: ExternalWalletChoice[]) => void>();
  const list = () => wallets.size ? [...wallets.values()].map(wallet => ({ ...wallet })) : typeof host.ethereum?.request === 'function' ? [{ id: 'legacy-injected', name: '浏览器钱包', provider: host.ethereum }] : [];
  const announced = (event: Event) => {
    const detail = (event as CustomEvent).detail;
    if (!detail?.info || typeof detail.info.uuid !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(detail.info.uuid) || typeof detail.info.name !== 'string' || detail.info.name.length > 128 || !detail.info.name.trim() || typeof detail.provider?.request !== 'function' || wallets.has(detail.info.uuid.toLowerCase())) return;
    const id = detail.info.uuid.toLowerCase();
    wallets.set(id, { id, name: detail.info.name.trim(), provider: detail.provider });
    for (const listener of listeners) listener(list());
  };
  host.addEventListener('eip6963:announceProvider', announced);
  host.dispatchEvent(new Event('eip6963:requestProvider'));
  return { list, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); }, dispose() { host.removeEventListener('eip6963:announceProvider', announced); listeners.clear(); } };
}
export async function connectExternalWallet(choice: ExternalWalletChoice, options: { chainId: 421614; onInvalidate?: (reason: WalletInvalidation) => void }): Promise<ExternalWalletConnection> {
  if (options.chainId !== 421614) throw new Error('WRONG_CHAIN：此版本只支持 Arbitrum Sepolia');
  const provider = choice.provider;
  const status: ExternalWalletConnection['capabilityStatus'] = { typedData: 'unknown', personalSign: 'unknown', authorization: 'unsupported', nativeTransaction: 'unknown' };
  async function request(args: Parameters<WalletProvider['request']>[0], capability?: 'typedData' | 'personalSign') {
    try { return await provider.request(args); }
    catch (cause) {
      const code = typeof cause === 'object' && cause !== null && 'code' in cause ? Number(cause.code) : undefined;
      let errorCode = 'WALLET_REQUEST_FAILED', message = '钱包请求失败，请检查钱包连接';
      if (code === 4001) { errorCode = 'USER_REJECTED'; message = '你已取消钱包请求'; }
      if (code === 4200 || code === -32601) { errorCode = 'UNSUPPORTED_SIGNER'; message = '钱包不支持此请求方式'; if (capability) status[capability] = 'unsupported'; }
      if (code === 4902) { errorCode = 'CHAIN_NOT_ADDED'; message = '请先在钱包中添加 Arbitrum Sepolia 测试网'; }
      if (code === 4900 || code === 4901) { errorCode = 'WALLET_DISCONNECTED'; message = '钱包网络连接已中断，请重新连接'; }
      if (code === 4100) { errorCode = 'UNAUTHORIZED'; message = '请先在钱包中授权当前账户'; }
      throw Object.assign(new Error(`${errorCode}：${message}`), { code: errorCode, rpcCode: code });
    }
  }
  const accounts = await request({ method: 'eth_requestAccounts' });
  if (!Array.isArray(accounts) || !isAddress(accounts[0])) throw new Error('NO_ACCOUNTS：钱包未授权可用账户');
  const address = getAddress(accounts[0]);
  let chain = await request({ method: 'eth_chainId' });
  if (typeof chain === 'string' && /^0x[0-9a-f]+$/i.test(chain) && BigInt(chain) !== 421614n) {
    await request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x66eee' }] });
    chain = await request({ method: 'eth_chainId' });
    const current = await request({ method: 'eth_accounts' });
    if (!Array.isArray(current) || typeof current[0] !== 'string' || current[0].toLowerCase() !== address.toLowerCase()) throw new Error('WALLET_CONTEXT_CHANGED：切换网络时账户已改变，请重新连接');
  }
  if (typeof chain !== 'string' || !/^0x[0-9a-f]+$/i.test(chain) || BigInt(chain) !== 421614n) throw new Error('WRONG_CHAIN：请在钱包中切换到 Arbitrum Sepolia');
  let active = true;
  const invalidationListeners = new Set<(reason: WalletInvalidation) => void>();
  const eventListeners = new Map<WalletInvalidation, () => void>();
  function invalidate(reason: WalletInvalidation) {
    if (!active) return;
    active = false;
    for (const [event, listener] of eventListeners) provider.removeListener?.(event, listener);
    options.onInvalidate?.(reason);
    for (const listener of invalidationListeners) listener(reason);
  }
  for (const event of ['accountsChanged', 'chainChanged', 'disconnect'] as const) {
    const listener = () => invalidate(event);
    eventListeners.set(event, listener); provider.on?.(event, listener);
  }
  async function assertActive() {
    if (!active) throw new Error('WALLET_CONTEXT_CHANGED：钱包连接已失效，请重新连接');
    const [chain, accounts] = await Promise.all([request({ method: 'eth_chainId' }), request({ method: 'eth_accounts' })]);
    const correctChain = typeof chain === 'string' && /^0x[0-9a-f]+$/i.test(chain) && BigInt(chain) === 421614n;
    const correctAccount = Array.isArray(accounts) && typeof accounts[0] === 'string' && accounts[0].toLowerCase() === address.toLowerCase();
    if (!correctChain) invalidate('chainChanged');
    else if (!correctAccount) invalidate('accountsChanged');
    if (!active) throw new Error('WALLET_CONTEXT_CHANGED：钱包账户或网络已改变，请重新连接');
  }
  const signTypedData: SignerAdapter['signTypedData'] = async args => {
    await assertActive();
    const domain = args.domain as TypedDataDomain | undefined;
    if (BigInt(domain?.chainId ?? 0) !== 421614n) throw new Error('WRONG_CHAIN：签名内容不属于 Arbitrum Sepolia');
    const data = { domain, types: { EIP712Domain: getTypesForEIP712Domain({ domain }), ...args.types }, primaryType: args.primaryType, message: args.message };
    validateTypedData(data as any);
    const signature = await request({ method: 'eth_signTypedData_v4', params: [address, serializeTypedData(data as any)] }, 'typedData');
    if (typeof signature !== 'string') throw new Error('INVALID_SIGNATURE：钱包没有返回有效根签名');
    validateSignature(signature as Hex);
    const recovered = await recoverTypedDataAddress({ ...data, signature } as any);
    if (recovered.toLowerCase() !== address.toLowerCase()) throw new Error('INVALID_SIGNATURE：签名不属于当前账户');
    await assertActive(); status.typedData = 'supported'; return signature as Hex;
  };
  async function signMessage(message: string): Promise<Hex> {
    await assertActive();
    const signature = await request({ method: 'personal_sign', params: [stringToHex(message), address] }, 'personalSign');
    if (typeof signature !== 'string') throw new Error('INVALID_SIGNATURE：钱包没有返回有效根签名');
    validateSignature(signature as Hex);
    if ((await recoverMessageAddress({ message, signature: signature as Hex })).toLowerCase() !== address.toLowerCase()) throw new Error('INVALID_SIGNATURE：签名不属于当前账户');
    await assertActive(); status.personalSign = 'supported'; return signature as Hex;
  }
  try { await assertActive(); }
  catch (error) { invalidate('disconnect'); throw error; }
  return {
    address, chainId: 421614, walletId: choice.id, walletName: choice.name,
    // These old SDK booleans mean a request may be attempted, not proven support.
    signer: { address, capabilities: { typedData: true, personalSign: true, authorization: false }, signTypedData },
    get capabilityStatus() { return { ...status }; }, signMessage, assertActive,
    subscribeInvalidation: listener => { invalidationListeners.add(listener); return () => invalidationListeners.delete(listener); }, disconnect() { invalidate('disconnect'); invalidationListeners.clear(); },
  };
}

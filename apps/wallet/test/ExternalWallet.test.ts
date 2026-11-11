import { expect, test } from 'vitest';
import { discoverExternalWallets, connectExternalWallet, type WalletProvider, type WalletHost } from '../src/external-wallet';
import signatures from './fixtures/external-signatures.json';

const A = '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf';
const id = '11111111-1111-4111-8111-111111111111';
const provider: WalletProvider = { request: async () => null };
function announce(host: WalletHost, uuid = id, p = provider, name = 'Fixture Wallet') {
  host.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info: { uuid, name, icon: 'data:image/svg+xml,<svg/>', rdns: 'com.fixture.wallet' }, provider: p } }));
}

test('discovers selected injected wallets through EIP6963 without exposing private keys', () => {
  const host = new EventTarget() as WalletHost;
  host.addEventListener('eip6963:requestProvider', () => announce(host));
  const discovery = discoverExternalWallets(host);
  expect(discovery.list()).toEqual([{ id, name: 'Fixture Wallet', provider }]);
  discovery.dispose();
});

test('offers a legacy injected provider only until named EIP6963 wallets announce', () => {
  const host = Object.assign(new EventTarget(), { ethereum: provider }) as WalletHost;
  const discovery = discoverExternalWallets(host);
  expect(discovery.list()).toEqual([{ id: 'legacy-injected', name: '浏览器钱包', provider }]);
  let visible: string[] = [];
  const unsubscribe = discovery.subscribe(wallets => { visible = wallets.map(wallet => wallet.name); });
  announce(host);
  expect(visible).toEqual(['Fixture Wallet']);
  expect(discovery.list()).toHaveLength(1);
  unsubscribe(); discovery.dispose();
});

test('preserves an announced provider identity and ignores malformed or duplicate metadata', () => {
  const host = new EventTarget() as WalletHost, discovery = discoverExternalWallets(host);
  announce(host);
  announce(host, id, { request: async () => ['attacker account'] }, 'Impersonated Wallet');
  announce(host, 'invalid-uuid');
  announce(host, '22222222-2222-4222-8222-222222222222', provider, ' '.repeat(200));
  expect(discovery.list()).toEqual([{ id, name: 'Fixture Wallet', provider }]);
  discovery.dispose();
});

function fixtureProvider(chainId = '0x66eee') {
  const requests: { method: string; params?: readonly unknown[] | object }[] = [];
  const events = new Map<string, Set<(...args: any[]) => void>>();
  const state = { chainId, accounts: [A] };
  const provider: WalletProvider = {
    request: async args => { requests.push(args); if (args.method === 'eth_requestAccounts' || args.method === 'eth_accounts') return [...state.accounts]; if (args.method === 'eth_chainId') return state.chainId; throw { code: 4200, message: 'not supported' }; },
    on: (event, listener) => { const list = events.get(event) ?? new Set(); list.add(listener); events.set(event, list); },
    removeListener: (event, listener) => { events.get(event)?.delete(listener); },
  };
  return { provider, state, requests, emit: (event: string, ...args: any[]) => { for (const listener of events.get(event) ?? []) listener(...args); } };
}
test('connects the exact approved root account and reports unproven signer capabilities honestly', async () => {
  const fixture = fixtureProvider();
  const connection = await connectExternalWallet({ id, name: 'Fixture Wallet', provider: fixture.provider }, { chainId: 421614 });
  expect(connection.address).toBe(A); expect(connection.chainId).toBe(421614);
  expect(connection.walletName).toBe('Fixture Wallet');
  expect(connection.capabilityStatus).toEqual({ typedData: 'unknown', personalSign: 'unknown', authorization: 'unsupported', nativeTransaction: 'unknown' });
  expect(connection.signer.capabilities.authorization).toBe(false);
  expect(connection.signer.signAuthorization).toBeUndefined();
  await expect(connection.assertActive()).resolves.toBeUndefined();
  expect(fixture.requests.every(request => ['eth_requestAccounts','eth_accounts','eth_chainId'].includes(request.method))).toBe(true);
  connection.disconnect();
});

test('requests the exact test chain and verifies the wallet actually switched', async () => {
  const fixture = fixtureProvider('0x1'), request = fixture.provider.request;
  fixture.provider.request = async args => {
    if (args.method === 'wallet_switchEthereumChain') { expect(args.params).toEqual([{ chainId: '0x66eee' }]); fixture.state.chainId = '0x66eee'; return null; }
    return request(args);
  };
  const connection = await connectExternalWallet({ id, name: 'Fixture Wallet', provider: fixture.provider }, { chainId: 421614 });
  expect(connection.chainId).toBe(421614); await expect(connection.assertActive()).resolves.toBeUndefined();
  connection.disconnect();
  fixture.state.chainId = '0x1';
  fixture.provider.request = async args => args.method === 'wallet_switchEthereumChain' ? null : request(args);
  await expect(connectExternalWallet({ id, name: 'Lying wallet', provider: fixture.provider }, { chainId: 421614 })).rejects.toThrow('WRONG_CHAIN');
});

test('refuses a connection when account selection changes during the initial handshake', async () => {
  const fixture = fixtureProvider(), request = fixture.provider.request;
  fixture.provider.request = async args => {
    if (args.method === 'eth_chainId') fixture.state.accounts = ['0x2222222222222222222222222222222222222222'];
    return request(args);
  };
  await expect(connectExternalWallet({ id, name: 'Fixture Wallet', provider: fixture.provider }, { chainId: 421614 })).rejects.toThrow('WALLET_CONTEXT_CHANGED');
});

test.each(['accountsChanged','chainChanged','disconnect'] as const)('invalidates the connection on provider %s even if stale RPC reads still show the old account', async reason => {
  const fixture = fixtureProvider(), observed: string[] = [];
  const connection = await connectExternalWallet({ id, name: 'Fixture Wallet', provider: fixture.provider }, { chainId: 421614, onInvalidate: event => observed.push(event) });
  const subscribed: string[] = []; connection.subscribeInvalidation(event => subscribed.push(event));
  fixture.emit(reason, reason === 'accountsChanged' ? [] : '0x1');
  await expect(connection.assertActive()).rejects.toThrow('WALLET_CONTEXT_CHANGED');
  expect(observed).toEqual([reason]); expect(subscribed).toEqual([reason]);
  connection.disconnect();
});

test('keeps a connection invalid once an RPC account change was observed even when a provider omits its event', async () => {
  const fixture = fixtureProvider(), observed: string[] = [];
  const connection = await connectExternalWallet({ id, name: 'Fixture Wallet', provider: fixture.provider }, { chainId: 421614, onInvalidate: reason => observed.push(reason) });
  fixture.state.accounts = ['0x2222222222222222222222222222222222222222'];
  await expect(connection.assertActive()).rejects.toThrow('WALLET_CONTEXT_CHANGED');
  fixture.state.accounts = [A];
  await expect(connection.assertActive()).rejects.toThrow('WALLET_CONTEXT_CHANGED');
  expect(observed).toEqual(['accountsChanged']);
  connection.disconnect();
});

test('requests EIP712 v4 from the connected account with exact large integers and verifies its signature', async () => {
  const fixture = fixtureProvider(), request = fixture.provider.request;
  let sent: any;
  fixture.provider.request = async args => {
    if (args.method === 'eth_signTypedData_v4') { sent = args.params; return signatures.typedSignature; }
    return request(args);
  };
  const connection = await connectExternalWallet({ id, name: 'Fixture Wallet', provider: fixture.provider }, { chainId: 421614 });
  const data = { ...signatures.typedData, primaryType: 'Example' as const, message: { amount: 9007199254740993n } };
  await expect(connection.signer.signTypedData(data as any)).resolves.toBe(signatures.typedSignature);
  expect(sent[0]).toBe(A);
  expect(JSON.parse(sent[1])).toMatchObject({ domain: { chainId: 421614, verifyingContract: '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf' }, message: { amount: '9007199254740993' }, primaryType: 'Example' });
  expect(connection.capabilityStatus.typedData).toBe('supported');
  connection.disconnect();
});

test('requests root EIP191 personal signing without exposing a private key and verifies the recovered account', async () => {
  const fixture = fixtureProvider(), request = fixture.provider.request;
  let sent: unknown;
  fixture.provider.request = async args => { if (args.method === 'personal_sign') { sent = args.params; return signatures.messageSignature; } return request(args); };
  const connection = await connectExternalWallet({ id, name: 'Fixture Wallet', provider: fixture.provider }, { chainId: 421614 });
  await expect(connection.signMessage(signatures.message)).resolves.toBe(signatures.messageSignature);
  expect(sent).toEqual(['0x41627374726163742057616c6c65742070726f76696465722066697874757265', A]);
  expect(connection.capabilityStatus.personalSign).toBe('supported');
  connection.disconnect();
});

test.each([
  [4200, 'UNSUPPORTED_SIGNER', 'unsupported'],
  [-32601, 'UNSUPPORTED_SIGNER', 'unsupported'],
  [4001, 'USER_REJECTED', 'unknown'],
] as const)('classifies provider signing error %s without silently trying another signature scheme', async (code, errorCode, capability) => {
  const fixture = fixtureProvider(), request = fixture.provider.request;
  fixture.provider.request = async args => { if (args.method === 'eth_signTypedData_v4') throw { code, message: 'fixture wallet response' }; return request(args); };
  const connection = await connectExternalWallet({ id, name: 'Fixture Wallet', provider: fixture.provider }, { chainId: 421614 });
  await expect(connection.signer.signTypedData(signatures.typedData as any)).rejects.toThrow(errorCode);
  expect(connection.capabilityStatus.typedData).toBe(capability);
  expect(fixture.requests.some(item => ['personal_sign','eth_sign','eth_signAuthorization'].includes(item.method))).toBe(false);
  connection.disconnect();
});

test.each(['typed','personal'] as const)('rejects a valid %s signature made for a different signing context', async kind => {
  const fixture = fixtureProvider(), request = fixture.provider.request;
  fixture.provider.request = async args => {
    if (args.method === 'eth_signTypedData_v4') return signatures.messageSignature;
    if (args.method === 'personal_sign') return signatures.typedSignature;
    return request(args);
  };
  const connection = await connectExternalWallet({ id, name: 'Fixture Wallet', provider: fixture.provider }, { chainId: 421614 });
  await expect(kind === 'typed' ? connection.signer.signTypedData(signatures.typedData as any) : connection.signMessage(signatures.message)).rejects.toThrow('INVALID_SIGNATURE');
  expect(connection.capabilityStatus.typedData).toBe('unknown'); expect(connection.capabilityStatus.personalSign).toBe('unknown');
  connection.disconnect();
});

test('rejects a valid signature if the account changes while its wallet prompt is open', async () => {
  const fixture = fixtureProvider(), request = fixture.provider.request;
  fixture.provider.request = async args => {
    if (args.method === 'eth_signTypedData_v4') { fixture.emit('accountsChanged', []); return signatures.typedSignature; }
    return request(args);
  };
  const connection = await connectExternalWallet({ id, name: 'Fixture Wallet', provider: fixture.provider }, { chainId: 421614 });
  await expect(connection.signer.signTypedData(signatures.typedData as any)).rejects.toThrow('WALLET_CONTEXT_CHANGED');
  expect(connection.capabilityStatus.typedData).toBe('unknown');
  connection.disconnect();
});

test('reports an unknown wallet chain explicitly without adding or selecting an unapproved network', async () => {
  const fixture = fixtureProvider('0x1'), request = fixture.provider.request;
  fixture.provider.request = async args => { if (args.method === 'wallet_switchEthereumChain') throw { code: 4902 }; return request(args); };
  await expect(connectExternalWallet({ id, name: 'Fixture Wallet', provider: fixture.provider }, { chainId: 421614 })).rejects.toThrow('CHAIN_NOT_ADDED');
});

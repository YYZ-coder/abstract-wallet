import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createPublicClient, createWalletClient, defineChain, http, keccak256, parseEther, type Hex, type Address } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';

// Fixed public testnet only. Keys are read locally and never printed or embedded in the frontend.
const rpcUrl = 'https://sepolia-rollup.arbitrum.io/rpc';
const entryPoint = '0x433709009B8330FDa32311DF1C2AFA402eD8D009' as Address;
const entryPointCodeHash = '0x66104e61203e3b9cf29303ececd9367b6329f6caa2bb063361ea75b7b92a7678';
const chain = defineChain({ id: 421614, name: 'Arbitrum Sepolia', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
const transport = http(rpcUrl, { fetchOptions: { headers: { 'User-Agent': 'Mozilla/5.0' } } });
const client = createPublicClient({ chain, transport });
function key(role: string) { const m = fs.readFileSync(`.secrets/${role}.env`, 'utf8').match(/^PRIVATE_KEY=(0x[0-9a-fA-F]{64})\s*$/m); assert.ok(m, `Missing protected ${role} key`); return m[1] as Hex; }
const deployer = privateKeyToAccount(key('deployer')), sponsor = privateKeyToAccount(key('sponsor')), relayer = privateKeyToAccount(key('relayer')), user = privateKeyToAccount(key('test-user'));
const wallet = createWalletClient({ chain, account: deployer, transport });
const reportPath = 'deployments/arbitrum-sepolia/deployment-status.json';
const status: Record<string, any> = fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, 'utf8')) : { transactions: [] };
Object.assign(status, { checkedAt: new Date().toISOString(), chainId: 421614, rpcUrl, deployer: deployer.address, status: 'checking' });
const save = () => fs.writeFileSync(reportPath, JSON.stringify(status, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2) + '\n');
try {
  assert.equal(await client.getChainId(), 421614);
  assert.equal(keccak256((await client.getCode({ address: entryPoint }))!), entryPointCodeHash, 'Official EntryPoint runtime mismatch');
  const balance = await client.getBalance({ address: deployer.address });
  status.balanceWei = balance.toString(); status.requiredFundingWei = parseEther('0.05').toString();
  if (balance < parseEther('0.05') && !status.delegate) {
    status.status = 'blocked-test-eth'; status.reason = 'Need free Arbitrum Sepolia test ETH for deployment, independent relay/bundler and Paymaster deposit.'; save();
    console.log(JSON.stringify({ status: status.status, address: deployer.address, balanceWei: balance.toString(), chainId: 421614 }));
    process.exitCode = 2;
  } else {
    status.indexerStartBlock ??= (await client.getBlockNumber()).toString();
    const gasPrice = await client.getGasPrice();
    assert.ok(gasPrice <= 10_000_000_000n, 'Test fee exceeds 10 gwei cap');
    const fees = { maxFeePerGas: gasPrice * 2n, maxPriorityFeePerGas: gasPrice };
    async function confirmed(hash: Hex, purpose: string) {
      status.transactions.push({ hash, purpose, state: 'broadcast' }); save();
      const receipt = await client.waitForTransactionReceipt({ hash }); assert.equal(receipt.status, 'success', purpose);
      Object.assign(status.transactions.at(-1), { state: 'confirmed', blockNumber: receipt.blockNumber, blockHash: receipt.blockHash }); save(); return receipt;
    }
    async function deploy(name: string, file: string, args: readonly unknown[]) {
      if (status[name]) { assert.notEqual(await client.getCode({ address: status[name] }), undefined); return status[name] as Address; }
      const a = JSON.parse(fs.readFileSync(file, 'utf8'));
      const receipt = await confirmed(await wallet.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args, ...fees }), `deploy-${name}`);
      assert.ok(receipt.contractAddress); status[name] = receipt.contractAddress; save(); return receipt.contractAddress;
    }
    const delegate = await deploy('delegate', 'contracts/out/WalletDelegate.sol/WalletDelegate.json', [entryPoint]);
    const paymaster = await deploy('paymaster', 'contracts/out/SignaturePaymaster.sol/SignaturePaymaster.json', [entryPoint, sponsor.address, deployer.address]);
    const bundlerKeyFile = '.secrets/bundler.env';
    if (!fs.existsSync(bundlerKeyFile)) fs.writeFileSync(bundlerKeyFile, `PRIVATE_KEY=${generatePrivateKey()}\n`, { mode: 0o600 });
    const bundlerKey = key('bundler'), bundler = privateKeyToAccount(bundlerKey);
    for (const [address, value, purpose] of [[bundler.address, parseEther('0.008'), 'fund-bundler'], [relayer.address, parseEther('0.003'), 'fund-relayer'], [user.address, parseEther('0.003'), 'fund-test-user']] as const) {
      if (await client.getBalance({ address }) < value) await confirmed(await wallet.sendTransaction({ to: address, value, ...fees }), purpose);
    }
    const pmArtifact = JSON.parse(fs.readFileSync('contracts/out/SignaturePaymaster.sol/SignaturePaymaster.json', 'utf8'));
    const epAbi = JSON.parse(fs.readFileSync('integration/out/EntryPoint.sol/EntryPoint.json', 'utf8')).abi;
    const deposit = await client.readContract({ address: entryPoint, abi: epAbi, functionName: 'balanceOf', args: [paymaster] }) as bigint;
    if (deposit < parseEther('0.01')) await confirmed(await wallet.writeContract({ address: paymaster, abi: pmArtifact.abi, functionName: 'deposit', value: parseEther('0.01') - deposit, ...fees }), 'paymaster-deposit');
    const delegateHash = keccak256((await client.getCode({ address: delegate }))!), pmHash = keccak256((await client.getCode({ address: paymaster }))!);
    const deployment = (version: string, address: string, hash: string) => ({ version, address: address.toLowerCase(), runtimeCodeHash: hash, verified: true });
    const manifest = { schemaVersion: '1', manifestVersion: 'arb-sepolia-mvp-v1', chainId: '421614', name: 'Arbitrum Sepolia', nativeCurrency: { symbol: 'ETH', decimals: '18' }, capabilityStatus: 'unverified', entryPoint: deployment('v0.9.0', entryPoint, entryPointCodeHash), delegate: deployment('v1', delegate, delegateHash), paymaster: deployment('v1', paymaster, pmHash), rpcEndpoints: [{ id: 'arbitrum-official', url: rpcUrl, verified: true }], bundlerEndpoints: [{ id: 'local-development-testnet', url: 'http://127.0.0.1:4337', verified: false, supportedEntryPointVersions: ['v0.9.0'] }], feeModel: { policyId: 'arb-development-upper-bound-v1', status: 'draft', nativeCostUnit: 'wei', components: [] }, confirmationPolicy: { policyId: null, status: 'draft', description: 'Track canonical L2 execution; parent-chain finality not yet accepted.', requiredConfirmations: null }, relay: { mode: 'backend_relayer', supported: false, verified: false, maxNativeCost: '1000000000000000' } };
    fs.writeFileSync('deployments/arbitrum-sepolia/manifest.json', JSON.stringify(manifest, null, 2) + '\n');
    const runtime = { authDomain: '127.0.0.1:5173', authUri: 'http://127.0.0.1:5173', mode: 'arbitrum-sepolia', chainId: 421614, rpcUrl: '/rpc', bundlerUrl: '/bundler', backendBaseUrl: '/api', entryPoint, delegate, paymaster, entryPointCodeHash, delegateCodeHash: delegateHash, paymasterCodeHash: pmHash, sponsorSigner: sponsor.address, manifestVersion: manifest.manifestVersion };
    fs.writeFileSync('apps/wallet/public/runtime-network.json', JSON.stringify(runtime, null, 2) + '\n');
    const writeEnv = (file: string, env: Record<string, string>) => fs.writeFileSync(file, Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
    writeEnv('.secrets/arb-bundler.env', { CHAIN_ID: '421614', RPC_URL: rpcUrl, ENTRY_POINT: entryPoint, DELEGATE: delegate, PAYMASTER: paymaster, ENTRY_POINT_CODE_HASH: entryPointCodeHash, DELEGATE_CODE_HASH: delegateHash, PAYMASTER_CODE_HASH: pmHash, BUNDLER_PRIVATE_KEY: bundlerKey, BUNDLER_STATE_PATH: path.resolve('.secrets/bundler-arb-state.json') });
    const stateKeyFile = '.secrets/arb-state-key'; if (!fs.existsSync(stateKeyFile)) fs.writeFileSync(stateKeyFile, randomBytes(32).toString('hex'), { mode: 0o600 });
    writeEnv('.secrets/arb-api.env', { WALLET_API_LISTEN: '127.0.0.1:8787', WALLET_DOMAIN: '127.0.0.1:5173', WALLET_URI: 'http://127.0.0.1:5173', WALLET_PROJECT_ID: 'abstract_wallet_mvp', WALLET_SCHEMA_PATH: path.resolve('protocol/openapi.v1.json'), WALLET_MANIFEST_PATH: path.resolve('deployments/arbitrum-sepolia/manifest.json'), WALLET_RPC_URL: rpcUrl, WALLET_ALLOWED_ORIGIN: 'http://127.0.0.1:5173', SPONSORSHIP_DATABASE_URL: process.env.SPONSORSHIP_DATABASE_URL ?? 'postgres://wallet_test:wallet_test_only@127.0.0.1:55432/wallet_mvp?sslmode=disable', SPONSORSHIP_STATE_KEY: fs.readFileSync(stateKeyFile, 'utf8'), SPONSORSHIP_NAMESPACE: `arb-sepolia-${delegate.toLowerCase()}`, SPONSOR_ACCOUNT_POLICY: 'authenticated', SPONSOR_PRIVATE_KEY: key('sponsor'), SPONSOR_ALLOWED_ACCOUNTS: user.address.toLowerCase(), PER_USER_BUDGET_WEI: parseEther('0.004').toString(), CHAIN_BUDGET_WEI: parseEther('0.008').toString(), MAX_SPONSOR_COST_WEI: parseEther('0.001').toString(), BUDGET_PERIOD: 'arb-sepolia-mvp', WALLET_INDEXER_START_BLOCK: status.indexerStartBlock, RELAY_PRIVATE_KEY: key('relayer'), RELAY_ALLOWED_ACCOUNTS: user.address.toLowerCase(), MAX_RELAY_COST_WEI: parseEther('0.001').toString(), RELAY_USER_BUDGET_WEI: parseEther('0.002').toString(), RELAY_CHAIN_BUDGET_WEI: parseEther('0.004').toString() });
    const accountsFile = 'deployments/arbitrum-sepolia/accounts.json';
    const accounts = JSON.parse(fs.readFileSync(accountsFile, 'utf8')); accounts.bundler = { address: bundler.address, role: 'bundler', network: 'arbitrum-sepolia', chainId: 421614 }; fs.writeFileSync(accountsFile, JSON.stringify(accounts, null, 2) + '\n');
    delete status.reason;
    status.status = 'deployed-awaiting-public-integration'; status.sponsor = sponsor.address; status.bundler = bundler.address; status.relayer = relayer.address; status.testUser = user.address; status.entryPoint = entryPoint; save();
    console.log(JSON.stringify({ status: status.status, delegate, paymaster, manifest: 'deployments/arbitrum-sepolia/manifest.json' }));
  }
} catch (error) { status.status = 'failed'; status.error = error instanceof Error ? error.message : String(error); save(); throw error; }

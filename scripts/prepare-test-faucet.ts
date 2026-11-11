import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
  createPublicClient, defineChain, http, keccak256, parseTransaction,
  recoverTransactionAddress, TransactionNotFoundError, TransactionReceiptNotFoundError,
  type Address, type Hex, type TransactionReceipt,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET_DIR = path.join(ROOT, '.secrets');
const KEY_FILE = path.join(SECRET_DIR, 'test-faucet.env');
const JOURNAL_FILE = path.join(SECRET_DIR, 'test-faucet-funding.json');
const LOCK_FILE = path.join(SECRET_DIR, 'test-faucet-prepare.lock');
const API_ENV_FILE = path.join(SECRET_DIR, 'arb-api.env');
const METADATA_FILE = path.join(ROOT, 'deployments/arbitrum-sepolia/test-faucet.json');
const RPC_URL = 'https://sepolia-rollup.arbitrum.io/rpc';
const CHAIN_ID = 421614;
const FUNDING_VALUE = 11_000_000_000_000_000n;
const CLAIM_VALUE = 1_000_000_000_000_000n;
const DAILY_BUDGET = 10_000_000_000_000_000n;
const MAX_GAS_PRICE = 10_000_000_000n;
const MAX_FEE_PER_GAS = MAX_GAS_PRICE * 2n;
const MAX_GAS = 1_000_000n;
const MAX_GAS_COST = 500_000_000_000_000n;
const chain = defineChain({ id: CHAIN_ID, name: 'Arbitrum Sepolia',
  nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC_URL] } } });
const client = createPublicClient({ chain, transport: http(RPC_URL, { timeout: 10_000, retryCount: 0,
  fetchOptions: { headers: { 'User-Agent': 'Mozilla/5.0' } } }) });

class OperationsError extends Error { constructor(readonly code: string) { super(code); } }
function requireThat(condition: unknown, code: string): asserts condition { if (!condition) throw new OperationsError(code); }
function regularFile(file: string, privateFile = false) {
  const stat = fs.lstatSync(file);
  requireThat(stat.isFile() && !stat.isSymbolicLink(), 'UNSAFE_FILE_PATH');
  if (privateFile) requireThat((stat.mode & 0o077) === 0, 'PRIVATE_FILE_PERMISSIONS_REQUIRED');
}
function readKey(file: string): Hex {
  regularFile(file, true);
  const matches = [...fs.readFileSync(file, 'utf8').matchAll(/^PRIVATE_KEY=(0x[0-9a-fA-F]{64})\s*$/gm)];
  requireThat(matches.length === 1, 'INVALID_PROTECTED_KEY_FILE');
  return matches[0][1] as Hex;
}
// Both file contents and directory entries are synced before the caller may broadcast.
function durableWrite(file: string, value: string, mode: number) {
  if (fs.existsSync(file)) regularFile(file);
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, 'wx', mode);
    fs.writeFileSync(descriptor, value, 'utf8'); fs.fsyncSync(descriptor);
    fs.closeSync(descriptor); descriptor = undefined;
    fs.renameSync(temporary, file); fs.chmodSync(file, mode);
    const directory = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
const json = (value: unknown) => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item, 2) + '\n';
type ReceiptRecord = { transactionHash: Hex; blockNumber: string; blockHash: Hex; status: 'success' | 'reverted';
  to: Address | null; gasUsed: string; effectiveGasPrice: string };
type FundingJournal = {
  schemaVersion: '1'; chainId: 421614; rpcUrl: typeof RPC_URL; from: Address; to: Address;
  valueWei: string; nonce: string; rawTransaction: Hex; transactionHash: Hex;
  state: 'signed' | 'broadcast-unknown' | 'broadcast-accepted' | 'confirmed' | 'reverted';
  createdAt: string; checkedAt: string; broadcastAttempts: number; receipt?: ReceiptRecord;
  lastBroadcastAt?: string; verification?: 'canonical' | 'unavailable';
};
function saveJournal(journal: FundingJournal) { durableWrite(JOURNAL_FILE, json(journal), 0o600); }
function receiptRecord(receipt: TransactionReceipt): ReceiptRecord {
  return { transactionHash: receipt.transactionHash, blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash,
    status: receipt.status, to: receipt.to, gasUsed: receipt.gasUsed.toString(), effectiveGasPrice: receipt.effectiveGasPrice.toString() };
}
async function validateJournal(journal: FundingJournal, from: Address, to: Address) {
  requireThat(journal.schemaVersion === '1' && journal.chainId === CHAIN_ID && journal.rpcUrl === RPC_URL, 'JOURNAL_NETWORK_MISMATCH');
  requireThat(journal.from?.toLowerCase() === from.toLowerCase() && journal.to?.toLowerCase() === to.toLowerCase(), 'JOURNAL_ACCOUNT_MISMATCH');
  requireThat(journal.valueWei === FUNDING_VALUE.toString() && /^\d+$/.test(journal.nonce), 'JOURNAL_AMOUNT_OR_NONCE_MISMATCH');
  requireThat(/^0x02[0-9a-fA-F]+$/.test(journal.rawTransaction) && keccak256(journal.rawTransaction) === journal.transactionHash, 'JOURNAL_RAW_HASH_MISMATCH');
  const transaction = parseTransaction(journal.rawTransaction);
  requireThat(transaction.type === 'eip1559' && transaction.chainId === CHAIN_ID && transaction.to?.toLowerCase() === to.toLowerCase()
    && transaction.value === FUNDING_VALUE && BigInt(transaction.nonce ?? -1) === BigInt(journal.nonce)
    && (transaction.data === undefined || transaction.data === '0x'), 'JOURNAL_TRANSACTION_MISMATCH');
  requireThat((transaction.gas ?? 0n) > 0n && transaction.gas! <= MAX_GAS && transaction.maxFeePerGas! > 0n
    && transaction.maxFeePerGas! <= MAX_FEE_PER_GAS && transaction.gas! * transaction.maxFeePerGas! <= MAX_GAS_COST
    && transaction.maxPriorityFeePerGas! >= 0n && transaction.maxPriorityFeePerGas! <= transaction.maxFeePerGas!, 'JOURNAL_FEE_LIMIT_EXCEEDED');
  requireThat((await recoverTransactionAddress({ serializedTransaction: journal.rawTransaction as `0x02${string}` })).toLowerCase() === from.toLowerCase(), 'JOURNAL_SIGNER_MISMATCH');
  requireThat(['signed', 'broadcast-unknown', 'broadcast-accepted', 'confirmed', 'reverted'].includes(journal.state), 'JOURNAL_STATE_INVALID');
}
async function currentReceipt(journal: FundingJournal): Promise<TransactionReceipt | undefined> {
  try { return await client.getTransactionReceipt({ hash: journal.transactionHash }); }
  catch (error) { if (error instanceof TransactionReceiptNotFoundError) return undefined; throw error; }
}
async function verifyReceipt(journal: FundingJournal, receipt: TransactionReceipt) {
  const [block, transaction] = await Promise.all([
    client.getBlock({ blockNumber: receipt.blockNumber }), client.getTransaction({ hash: journal.transactionHash }),
  ]);
  requireThat(receipt.transactionHash.toLowerCase() === journal.transactionHash.toLowerCase() && block.hash === receipt.blockHash,
    'FUNDING_RECEIPT_NOT_CANONICAL');
  requireThat(transaction.hash.toLowerCase() === journal.transactionHash.toLowerCase()
    && transaction.from.toLowerCase() === journal.from.toLowerCase() && transaction.to?.toLowerCase() === journal.to.toLowerCase()
    && transaction.value === FUNDING_VALUE && BigInt(transaction.nonce) === BigInt(journal.nonce), 'FUNDING_RECEIPT_INTENT_MISMATCH');
  journal.receipt = receiptRecord(receipt); journal.checkedAt = new Date().toISOString(); journal.verification = 'canonical';
  journal.state = receipt.status === 'success' ? 'confirmed' : 'reverted'; saveJournal(journal);
}
function writeApiEnvironment(privateKey: Hex) {
  regularFile(API_ENV_FILE, true);
  const keys = ['TEST_FAUCET_PRIVATE_KEY', 'TEST_FAUCET_AMOUNT_WEI', 'TEST_FAUCET_DAILY_BUDGET_WEI'];
  const existing = fs.readFileSync(API_ENV_FILE, 'utf8');
  const lines = existing.split(/\r?\n/).filter(line => !keys.some(key => new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`).test(line)));
  while (lines.at(-1) === '') lines.pop();
  const next = lines.join('\n') + `\nTEST_FAUCET_PRIVATE_KEY=${privateKey}\nTEST_FAUCET_AMOUNT_WEI=${CLAIM_VALUE}\nTEST_FAUCET_DAILY_BUDGET_WEI=${DAILY_BUDGET}\n`;
  if (next !== existing) durableWrite(API_ENV_FILE, next, 0o600);
}

async function main() {
  const args = process.argv.slice(2);
  requireThat(args.every(arg => ['--help', '--fund', '--prepare-only'].includes(arg)), 'UNKNOWN_ARGUMENT');
  if (args.includes('--help')) { console.log('Usage: npx tsx scripts/prepare-test-faucet.ts [--prepare-only | --fund]\nDefault: prepare-only; no transaction is signed or broadcast. --fund funds the pool once with 0.011 Arbitrum Sepolia test ETH.'); return; }
  requireThat(!(args.includes('--fund') && args.includes('--prepare-only')), 'CONFLICTING_ARGUMENTS');
  const fund = args.includes('--fund');
  if (!fs.existsSync(SECRET_DIR)) fs.mkdirSync(SECRET_DIR, { mode: 0o700 });
  requireThat(fs.lstatSync(SECRET_DIR).isDirectory() && !fs.lstatSync(SECRET_DIR).isSymbolicLink(), 'UNSAFE_SECRET_DIRECTORY');
  fs.chmodSync(SECRET_DIR, 0o700);
  let lock: number;
  try { lock = fs.openSync(LOCK_FILE, 'wx', 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new OperationsError('SCRIPT_ALREADY_RUNNING_OR_STALE_LOCK'); throw error; }
  fs.writeFileSync(lock, json({ pid: process.pid, startedAt: new Date().toISOString() })); fs.fsyncSync(lock);
  let locked = true;
  const unlock = () => { if (locked) { locked = false; fs.closeSync(lock); fs.unlinkSync(LOCK_FILE); } };
  const interrupt = () => { unlock(); process.exit(130); };
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  try {
    const existingMetadata = fs.existsSync(METADATA_FILE) ? JSON.parse(fs.readFileSync(METADATA_FILE, 'utf8')) : undefined;
    if (!fs.existsSync(KEY_FILE)) {
      requireThat(!existingMetadata && !fs.existsSync(JOURNAL_FILE), 'FAUCET_KEY_MISSING_WITH_EXISTING_STATE');
      durableWrite(KEY_FILE, `PRIVATE_KEY=${generatePrivateKey()}\n`, 0o600);
    }
    const privateKey = readKey(KEY_FILE), faucet = privateKeyToAccount(privateKey);
    const deployer = privateKeyToAccount(readKey(path.join(SECRET_DIR, 'deployer.env')));
    const accounts = JSON.parse(fs.readFileSync(path.join(ROOT, 'deployments/arbitrum-sepolia/accounts.json'), 'utf8'));
    requireThat(accounts.deployer?.address?.toLowerCase() === deployer.address.toLowerCase(), 'DEPLOYER_ROSTER_MISMATCH');
    requireThat(!Object.values(accounts).some(role => (role as { address?: string }).address?.toLowerCase() === faucet.address.toLowerCase()), 'FAUCET_ROLE_MUST_BE_INDEPENDENT');
    if (existingMetadata) requireThat(existingMetadata.chainId === CHAIN_ID && existingMetadata.address?.toLowerCase() === faucet.address.toLowerCase(), 'FAUCET_METADATA_MISMATCH');
    requireThat(await client.getChainId() === CHAIN_ID, 'TESTNET_CHAIN_MISMATCH');
    const [initialFaucetBalance, deployerBalance] = await Promise.all([
      client.getBalance({ address: faucet.address }), client.getBalance({ address: deployer.address }),
    ]);
    let faucetBalance = initialFaucetBalance;
    let balanceObservedAt = new Date().toISOString();
    const refreshFaucetBalance = async () => { faucetBalance = await client.getBalance({ address: faucet.address }); balanceObservedAt = new Date().toISOString(); };
    writeApiEnvironment(privateKey);
    let journal: FundingJournal | undefined;
    if (fs.existsSync(JOURNAL_FILE)) { regularFile(JOURNAL_FILE, true); journal = JSON.parse(fs.readFileSync(JOURNAL_FILE, 'utf8')); await validateJournal(journal!, deployer.address, faucet.address); }
    else requireThat(!existingMetadata?.funding?.transactionHash, 'FUNDING_JOURNAL_MISSING_DO_NOT_SIGN_AGAIN');
    const writeMetadata = () => {
      const metadata = { schemaVersion: '1', network: 'arbitrum-sepolia', chainId: CHAIN_ID, rpcUrl: RPC_URL,
        address: faucet.address, fundingFrom: deployer.address, fundingTargetWei: FUNDING_VALUE.toString(),
        claimAmountWei: CLAIM_VALUE.toString(), dailyBudgetWei: DAILY_BUDGET.toString(),
        checkedAt: new Date().toISOString(), balanceObservedAt, observedBalanceWei: faucetBalance.toString(),
        status: journal?.state === 'confirmed' ? 'funded' : journal?.state === 'reverted' ? 'funding-reverted' : journal ? 'funding-pending-or-unknown' : 'prepared',
        funding: journal ? { transactionHash: journal.transactionHash, from: journal.from, to: journal.to, valueWei: journal.valueWei,
          nonce: journal.nonce, state: journal.state, verification: journal.verification ?? 'unavailable', receipt: journal.receipt ?? null } : null };
      durableWrite(METADATA_FILE, json(metadata), 0o644);
    };
    const print = (status: string) => console.log(JSON.stringify({ status, mode: fund ? 'fund' : 'prepare-only', chainId: CHAIN_ID,
      address: faucet.address, observedBalanceWei: faucetBalance.toString(), deployer: deployer.address,
      deployerBalanceWei: deployerBalance.toString(), transactionHash: journal?.transactionHash,
      metadata: 'deployments/arbitrum-sepolia/test-faucet.json' }));
    if (journal) {
      const receipt = await currentReceipt(journal);
      if (receipt) await verifyReceipt(journal, receipt);
      if (journal.state === 'confirmed' || journal.state === 'reverted') {
        if (!receipt) { journal.verification = 'unavailable'; journal.checkedAt = new Date().toISOString(); saveJournal(journal); }
        await refreshFaucetBalance();
        writeMetadata(); print(receipt ? journal.state === 'confirmed' ? 'funded-verified-no-transfer' : 'funding-reverted-no-transfer' : 'historical-receipt-unavailable-no-transfer');
        process.exitCode = receipt && journal.state === 'confirmed' ? 0 : receipt ? 1 : 2; return;
      }
    }
    writeMetadata();
    if (!fund) { print(journal ? 'prepared-existing-transaction-not-broadcast' : 'prepared-no-transaction'); return; }
    if (!journal) {
      const gasPrice = await client.getGasPrice(); requireThat(gasPrice > 0n && gasPrice <= MAX_GAS_PRICE, 'FUNDING_GAS_PRICE_EXCEEDS_CAP');
      const maxFeePerGas = gasPrice * 2n, maxPriorityFeePerGas = gasPrice;
      const nonce = BigInt(await client.request({ method: 'eth_getTransactionCount', params: [deployer.address, 'pending'] }));
      requireThat(nonce <= BigInt(Number.MAX_SAFE_INTEGER), 'FUNDING_NONCE_NOT_SAFELY_SERIALIZABLE');
      const estimated = await client.estimateGas({ account: deployer.address, to: faucet.address, value: FUNDING_VALUE,
        data: '0x', nonce: Number(nonce), maxFeePerGas, maxPriorityFeePerGas });
      const gas = estimated + estimated / 5n + 10_000n;
      requireThat(gas <= MAX_GAS && gas * maxFeePerGas <= MAX_GAS_COST, 'FUNDING_MAXIMUM_FEE_EXCEEDS_CAP');
      requireThat(deployerBalance >= FUNDING_VALUE + gas * maxFeePerGas, 'DEPLOYER_TEST_ETH_INSUFFICIENT');
      const rawTransaction = await deployer.signTransaction({ type: 'eip1559', chainId: CHAIN_ID, to: faucet.address,
        value: FUNDING_VALUE, data: '0x', nonce: Number(nonce), gas, maxFeePerGas, maxPriorityFeePerGas });
      const now = new Date().toISOString();
      journal = { schemaVersion: '1', chainId: CHAIN_ID, rpcUrl: RPC_URL, from: deployer.address, to: faucet.address,
        valueWei: FUNDING_VALUE.toString(), nonce: nonce.toString(), rawTransaction, transactionHash: keccak256(rawTransaction),
        state: 'signed', createdAt: now, checkedAt: now, broadcastAttempts: 0 };
      await validateJournal(journal, deployer.address, faucet.address);
      saveJournal(journal); writeMetadata();
    }
    // Every run with an existing journal uses its exact signed bytes; no replacement nonce or refilling loop.
    let known = false;
    try { known = (await client.getTransaction({ hash: journal.transactionHash })).hash === journal.transactionHash; }
    catch (error) { if (!(error instanceof TransactionNotFoundError)) throw error; }
    if (!known) {
      const latestNonce = BigInt(await client.request({ method: 'eth_getTransactionCount', params: [deployer.address, 'latest'] }));
      if (latestNonce > BigInt(journal.nonce)) { writeMetadata(); print('nonce-consumed-transaction-unknown-no-new-signature'); process.exitCode = 2; return; }
      journal.state = 'broadcast-unknown'; journal.broadcastAttempts++; journal.lastBroadcastAt = new Date().toISOString();
      saveJournal(journal); writeMetadata();
      try {
        const returned = await client.sendRawTransaction({ serializedTransaction: journal.rawTransaction });
        if (returned === journal.transactionHash) { journal.state = 'broadcast-accepted'; saveJournal(journal); }
      } catch { /* Unknown submission is resolved only by the already-persisted hash. */ }
    }
    try {
      const receipt = await client.waitForTransactionReceipt({ hash: journal.transactionHash, confirmations: 1, timeout: 40_000, pollingInterval: 1_500 });
      await verifyReceipt(journal, receipt);
    } catch {
      // Preserve raw/hash and any historic receipt. A later --fund only queries/rebroadcasts this same transaction.
      journal.checkedAt = new Date().toISOString(); saveJournal(journal); writeMetadata();
      print('funding-pending-or-unknown-same-hash-retained'); process.exitCode = 2; return;
    }
    await refreshFaucetBalance();
    writeMetadata(); print(journal.state === 'confirmed' ? 'funded-verified' : 'funding-reverted');
    process.exitCode = journal.state === 'confirmed' ? 0 : 1;
  } finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); unlock(); }
}

main().catch(error => {
  // Never print upstream exception payloads: they can contain request bodies or local configuration.
  console.error(JSON.stringify({ status: 'failed', code: error instanceof OperationsError ? error.code : 'RPC_OR_FILESYSTEM_UNAVAILABLE',
    message: 'Preparation stopped. Existing signed journal, if any, is retained; do not delete it or sign another funding nonce.' }));
  process.exitCode = 1;
});

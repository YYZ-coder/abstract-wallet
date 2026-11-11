export type WalletSnapshot = {
  address: string;
  balance: string;
  delegation: 'undelegated' | 'enabled' | 'unknown';
  connection?: { walletId: string; walletName: string };
  availability?: { canSubmit: boolean; canRevoke: boolean; reason?: string };
};
export type WalletChoice = { id: string; name: string };
export type TransferDraft = { recipient: string; amount: string; sponsored: boolean };
export type Preview = { recipient: string; amount: string; maxCost: string; payment: 'self' | 'sponsored'; id: string };
export type OperationStatus = {
  hash: string;
  submission: 'accepted' | 'unknown' | 'rejected';
  execution: 'unknown' | 'succeeded' | 'reverted';
  confirmation: 'pending' | 'confirmed' | 'reorged';
};
export type TestFundsClaim = {
  claimId: string;
  chainId: '421614';
  address: string;
  amountWei: string;
  status: 'pending' | 'submitted' | 'confirmed' | 'failed' | 'unknown';
  transactionHash?: string;
  failureCode?: string;
};
export type OperationReference = { chainId: '421614'; address: string; hash: string };
export type ObservedOperation = {
  reference: OperationReference;
  wallet: Pick<WalletSnapshot, 'address' | 'balance' | 'delegation'>;
  operation: OperationStatus;
  transactionHash?: string;
};
export interface WalletServices {
  recentOperation?(): OperationReference | undefined;
  inspectOperation?(reference: OperationReference): Promise<ObservedOperation>;
  requestTestFunds?(): Promise<TestFundsClaim>;
  testFundsStatus?(claimId: string): Promise<TestFundsClaim>;
  listWallets?(): Promise<WalletChoice[]>;
  connectWallet?(id: string): Promise<WalletSnapshot>;
  disconnectWallet?(): Promise<void>;
  onWalletChange?(listener: () => void): () => void;
  createAccount(): Promise<WalletSnapshot>;
  importAccount?(privateKey: string): Promise<WalletSnapshot>;
  refresh(): Promise<WalletSnapshot>;
  preview(draft: TransferDraft): Promise<Preview>;
  submit(preview: Preview): Promise<OperationStatus>;
  status(hash: string): Promise<OperationStatus>;
  cancel(hash: string): Promise<OperationStatus>;
  revoke(): Promise<{ transactionHash: string; confirmed: boolean }>;
}

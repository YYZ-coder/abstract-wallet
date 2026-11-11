import type { Address, Hex, LocalAccount } from 'viem';
export type { Address, Hex } from 'viem';
export type Call = { target: Address; value: bigint; data: Hex };
export type TimeWindow = { validAfter: bigint; validUntil: bigint };
export type GasFields = {
  verificationGasLimit: bigint; callGasLimit: bigint; preVerificationGas: bigint;
  maxPriorityFeePerGas: bigint; maxFeePerGas: bigint;
};
export type PaymasterFields = { address: Address; verificationGasLimit: bigint; postOpGasLimit: bigint; data: Hex };
export type ChainConfig = {
  chainId: number; rpcUrl: string; bundlerUrls: string[];
  entryPoint: Address; delegate: Address; paymaster?: Address;
};
export type RpcUserOperation = {
  sender: Address; nonce: Hex; factory: '0x7702'; factoryData: '0x'; callData: Hex;
  verificationGasLimit: Hex; callGasLimit: Hex; preVerificationGas: Hex;
  maxPriorityFeePerGas: Hex; maxFeePerGas: Hex;
  paymaster?: Address; paymasterVerificationGasLimit?: Hex; paymasterPostOpGasLimit?: Hex;
  paymasterData?: Hex; signature?: Hex;
};
export type Authorization = { chainId: Hex; address: Address; nonce: Hex; yParity: Hex; r: Hex; s: Hex };
export type PrepareInput = {
  config: ChainConfig; account: Address; calls: Call[]; nonce: bigint;
  gas: GasFields; window: TimeWindow; paymaster?: PaymasterFields; authorizationNonce?: bigint;
};
export type PreparedOperation = PrepareInput & { rpcUserOperation: RpcUserOperation; userOpHash: Hex; operationDigest: Hex };
export type SignedOperation = { prepared: PreparedOperation; rpcUserOperation: RpcUserOperation; eip7702Auth?: Authorization; userOpHash: Hex };
export type SignerAdapter = {
  address: Address;
  capabilities: { typedData: boolean; authorization: boolean; personalSign: boolean };
  signTypedData: LocalAccount['signTypedData'];
  signAuthorization?: (args: { chainId: number; contractAddress: Address; nonce: bigint }) => Promise<Authorization>;
};
export type PermitFields = TimeWindow & {
  chainId: number; paymaster: Address; expectedDelegate: Address; sender: Address; entryPoint: Address;
  nonce: bigint; initCodeHash: Hex; callDataHash: Hex; accountGasLimits: Hex;
  preVerificationGas: bigint; gasFees: Hex; paymasterVerificationGasLimit: bigint;
  paymasterPostOpGasLimit: bigint; maxCost: bigint; reservationId: Hex;
};
export type FetchLike = typeof globalThis.fetch;
export type SponsorshipPermit = {
  permitVersion: '1'; chainId: string; entryPoint: Address; sender: Address; expectedDelegate: Address; nonce: string;
  accountWindow: { validAfter: string; validUntil: string }; maxCost: string; chainReservationId: Hex;
  paymaster: Address; paymasterVerificationGasLimit: string; paymasterPostOpGasLimit: string;
  paymasterData: Hex; permitDigest: Hex; sponsorSignature: Hex;
};

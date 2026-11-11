// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// Tuple order matches eth-infinitism/account-abstraction v0.9.0.
struct PackedUserOperation {
    address sender;
    uint256 nonce;
    bytes initCode;
    bytes callData;
    bytes32 accountGasLimits;
    uint256 preVerificationGas;
    bytes32 gasFees;
    bytes paymasterAndData;
    bytes signature;
}

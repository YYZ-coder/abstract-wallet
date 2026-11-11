// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PackedUserOperation} from "./interfaces/PackedUserOperation.sol";
import {IPaymaster} from "./interfaces/IPaymaster.sol";
import {IEntryPointFunds} from "./interfaces/IEntryPointFunds.sol";
import {SignatureProfile} from "./libraries/SignatureProfile.sol";

contract SignaturePaymaster is IPaymaster {
    struct Permit {
        uint8 version;
        address expectedDelegate;
        uint48 validAfter;
        uint48 validUntil;
        uint256 maxCost;
        bytes32 reservationId;
        bytes signature;
    }

    bytes32 private constant PERMIT_TYPEHASH = keccak256(
        "Permit(uint8 version,address expectedDelegate,address sender,address entryPoint,uint256 nonce,bytes32 initCodeHash,bytes32 callDataHash,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,uint128 paymasterVerificationGasLimit,uint128 paymasterPostOpGasLimit,uint48 validAfter,uint48 validUntil,uint256 maxCost,bytes32 reservationId)"
    );

    error InvalidEntryPoint(address entryPoint);
    error UntrustedEntryPoint(address caller);
    error UnsupportedSelector(bytes4 selector);
    error InvalidSponsorSigner(address sponsorSigner);
    error InvalidOwner(address owner);
    error UntrustedOwner(address caller);
    error UntrustedPendingOwner(address caller);
    error InvalidWithdrawAddress(address withdrawAddress);
    error MalformedPaymasterData();
    error ValidityWindowMismatch();
    error InvalidReservationId();
    error InvalidDelegation(address account);
    error DelegateMismatch(address expected, address actual);
    error CostLimitExceeded(uint256 required, uint256 maximum);

    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    address public immutable entryPoint;
    address public immutable sponsorSigner;
    address public owner;
    address public pendingOwner;

    fallback() external payable {
        revert UnsupportedSelector(msg.sig);
    }

    constructor(address entryPoint_, address sponsorSigner_, address initialOwner_) {
        if (entryPoint_ == address(0) || entryPoint_.code.length == 0) revert InvalidEntryPoint(entryPoint_);
        if (sponsorSigner_ == address(0)) revert InvalidSponsorSigner(sponsorSigner_);
        if (initialOwner_ == address(0)) revert InvalidOwner(initialOwner_);
        entryPoint = entryPoint_;
        sponsorSigner = sponsorSigner_;
        owner = initialOwner_;
        emit OwnershipTransferred(address(0), initialOwner_);
    }

    function validatePaymasterUserOp(PackedUserOperation calldata userOp, bytes32, uint256 maxCost)
        external
        override
        returns (bytes memory, uint256)
    {
        if (msg.sender != entryPoint) revert UntrustedEntryPoint(msg.sender);
        Permit memory permit = _decodePermit(userOp.paymasterAndData);
        (uint48 accountAfter, uint48 accountUntil,) = SignatureProfile._parseOperation(userOp.signature);
        SignatureProfile._checkWindow(accountAfter, accountUntil);
        SignatureProfile._checkWindow(permit.validAfter, permit.validUntil);
        if (accountAfter != permit.validAfter || accountUntil != permit.validUntil) revert ValidityWindowMismatch();
        if (permit.reservationId == bytes32(0)) revert InvalidReservationId();
        bytes memory code = userOp.sender.code;
        if (code.length != 23 || bytes3(code) != hex"ef0100") revert InvalidDelegation(userOp.sender);
        address actualDelegate;
        assembly ("memory-safe") {
            actualDelegate := shr(96, mload(add(code, 35)))
        }
        if (actualDelegate != permit.expectedDelegate) revert DelegateMismatch(permit.expectedDelegate, actualDelegate);
        if (maxCost > permit.maxCost) revert CostLimitExceeded(maxCost, permit.maxCost);
        bytes32 structHash = keccak256(
            abi.encode(
                PERMIT_TYPEHASH,
                permit.version,
                permit.expectedDelegate,
                userOp.sender,
                entryPoint,
                userOp.nonce,
                keccak256(userOp.initCode),
                keccak256(userOp.callData),
                userOp.accountGasLimits,
                userOp.preVerificationGas,
                userOp.gasFees,
                uint128(bytes16(userOp.paymasterAndData[20:36])),
                uint128(bytes16(userOp.paymasterAndData[36:52])),
                permit.validAfter,
                permit.validUntil,
                permit.maxCost,
                permit.reservationId
            )
        );
        if (
            SignatureProfile._recover(
                SignatureProfile._typedDigest(keccak256("AbstractWalletPaymaster"), structHash), permit.signature
            ) != sponsorSigner
        ) return ("", 1);
        return ("", (uint256(permit.validUntil) << 160) | (uint256(permit.validAfter) << 208));
    }

    function _decodePermit(bytes calldata data) internal view returns (Permit memory permit) {
        if (data.length != 404 || address(bytes20(data[:20])) != address(this)) revert MalformedPaymasterData();
        uint256 version;
        uint256 expected;
        uint256 afterWord;
        uint256 untilWord;
        uint256 maximum;
        bytes32 reservation;
        uint256 offset;
        uint256 length;
        uint256 tail;
        assembly ("memory-safe") {
            version := calldataload(add(data.offset, 52))
            expected := calldataload(add(data.offset, 84))
            afterWord := calldataload(add(data.offset, 116))
            untilWord := calldataload(add(data.offset, 148))
            maximum := calldataload(add(data.offset, 180))
            reservation := calldataload(add(data.offset, 212))
            offset := calldataload(add(data.offset, 244))
            length := calldataload(add(data.offset, 276))
            tail := calldataload(add(data.offset, 372))
        }
        if (
            version != 1 || expected > type(uint160).max || afterWord > type(uint48).max || untilWord > type(uint48).max
                || offset != 224 || length != 65 || uint248(tail) != 0
        ) revert MalformedPaymasterData();
        return Permit(
            1, address(uint160(expected)), uint48(afterWord), uint48(untilWord), maximum, reservation, data[308:373]
        );
    }

    function postOp(PostOpMode, bytes calldata, uint256, uint256) external override {
        if (msg.sender != entryPoint) revert UntrustedEntryPoint(msg.sender);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert UntrustedOwner(msg.sender);
        _;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidOwner(newOwner);
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner || pendingOwner == address(0)) revert UntrustedPendingOwner(msg.sender);
        address previousOwner = owner;
        owner = msg.sender;
        pendingOwner = address(0);
        emit OwnershipTransferred(previousOwner, msg.sender);
    }

    function deposit() external payable {
        IEntryPointFunds(entryPoint).depositTo{value: msg.value}(address(this));
    }

    function getDeposit() external view returns (uint256) {
        return IEntryPointFunds(entryPoint).balanceOf(address(this));
    }

    function withdrawTo(address payable withdrawAddress, uint256 amount) external onlyOwner {
        if (withdrawAddress == address(0)) revert InvalidWithdrawAddress(withdrawAddress);
        IEntryPointFunds(entryPoint).withdrawTo(withdrawAddress, amount);
    }

    function addStake(uint32 unstakeDelaySec) external payable onlyOwner {
        IEntryPointFunds(entryPoint).addStake{value: msg.value}(unstakeDelaySec);
    }

    function unlockStake() external onlyOwner {
        IEntryPointFunds(entryPoint).unlockStake();
    }

    function withdrawStake(address payable withdrawAddress) external onlyOwner {
        if (withdrawAddress == address(0)) revert InvalidWithdrawAddress(withdrawAddress);
        IEntryPointFunds(entryPoint).withdrawStake(withdrawAddress);
    }
}

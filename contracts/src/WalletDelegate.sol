// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PackedUserOperation} from "./interfaces/PackedUserOperation.sol";
import {SignatureProfile} from "./libraries/SignatureProfile.sol";

contract WalletDelegate {
    struct Call {
        address target;
        uint256 value;
        bytes data;
    }

    error InvalidEntryPoint(address entryPoint);
    error UntrustedEntryPoint(address caller);
    error UntrustedExecutor(address caller);
    error SenderMismatch(address suppliedSender, address account);
    error EmptyBatch();
    error TooManyCalls(uint256 actual, uint256 maximum);
    error CallDataTooLarge(uint256 actual, uint256 maximum);
    error BatchCallFailed(uint256 index, bytes revertData);
    error UnsupportedSelector(bytes4 selector);

    event BatchExecuted(address indexed executor, uint256 callCount);

    address private immutable _entryPoint;

    constructor(address entryPoint_) {
        if (entryPoint_ == address(0) || entryPoint_.code.length == 0) revert InvalidEntryPoint(entryPoint_);
        _entryPoint = entryPoint_;
    }

    function entryPoint() external view returns (address) {
        return _entryPoint;
    }

    function isValidSignature(bytes32 messageHash, bytes calldata envelope) external view returns (bytes4) {
        if (envelope.length != 224) return 0xffffffff;
        uint256 version;
        uint256 kind;
        uint256 offset;
        uint256 length;
        uint256 tail;
        assembly ("memory-safe") {
            version := calldataload(envelope.offset)
            kind := calldataload(add(envelope.offset, 32))
            offset := calldataload(add(envelope.offset, 64))
            length := calldataload(add(envelope.offset, 96))
            tail := calldataload(add(envelope.offset, 192))
        }
        if (version != 1 || kind != 2 || offset != 96 || length != 65 || uint248(tail) != 0) return 0xffffffff;
        bytes32 structHash = keccak256(abi.encode(keccak256("WalletMessage(bytes32 messageHash)"), messageHash));
        return SignatureProfile._recover(
            SignatureProfile._typedDigest(keccak256("AbstractWallet"), structHash), envelope[128:193]
        ) == address(this) ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }

    receive() external payable {}

    fallback() external payable {
        revert UnsupportedSelector(msg.sig);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return 0x150b7a02;
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return 0xf23a6e61;
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return 0xbc197c81;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7 || interfaceId == 0x150b7a02 || interfaceId == 0x4e2312e0
            || interfaceId == 0x1626ba7e;
    }

    function validateUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash, uint256 missingAccountFunds)
        external
        returns (uint256)
    {
        if (msg.sender != _entryPoint) revert UntrustedEntryPoint(msg.sender);
        if (userOp.sender != address(this)) revert SenderMismatch(userOp.sender, address(this));
        (uint48 validAfter, uint48 validUntil, bytes memory signature) =
            SignatureProfile._parseOperation(userOp.signature);
        SignatureProfile._checkWindow(validAfter, validUntil);
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("WalletOperation(bytes32 userOpHash,uint48 validAfter,uint48 validUntil)"),
                userOpHash,
                validAfter,
                validUntil
            )
        );
        if (
            SignatureProfile._recover(SignatureProfile._typedDigest(keccak256("AbstractWallet"), structHash), signature)
                != address(this)
        ) return 1;
        if (missingAccountFunds != 0) {
            // EntryPoint independently rejects unpaid prefund; never send a partial amount.
            (bool paid,) = _entryPoint.call{value: missingAccountFunds}("");
            (paid);
        }
        return (uint256(validUntil) << 160) | (uint256(validAfter) << 208);
    }

    function executeBatch(Call[] calldata calls) external payable returns (bytes[] memory results) {
        if (msg.sender != _entryPoint && msg.sender != address(this)) revert UntrustedExecutor(msg.sender);
        if (calls.length == 0) revert EmptyBatch();
        if (calls.length > 16) revert TooManyCalls(calls.length, 16);
        uint256 dataSize;
        for (uint256 i; i < calls.length; ++i) {
            dataSize += calls[i].data.length;
        }
        if (dataSize > 32768) revert CallDataTooLarge(dataSize, 32768);
        results = new bytes[](calls.length);
        for (uint256 i; i < calls.length; ++i) {
            (bool success, bytes memory result) = calls[i].target.call{value: calls[i].value}(calls[i].data);
            if (!success) revert BatchCallFailed(i, result);
            results[i] = result;
        }
        emit BatchExecuted(msg.sender, calls.length);
    }
}

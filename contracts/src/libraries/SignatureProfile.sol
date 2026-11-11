// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

library SignatureProfile {
    error InvalidSignatureEnvelope();
    error InvalidValidityWindow();

    function _checkWindow(uint48 validAfter, uint48 validUntil) internal pure {
        if (validAfter >= validUntil || validUntil >= (1 << 47)) revert InvalidValidityWindow();
    }

    function _parseOperation(bytes calldata envelope)
        internal
        pure
        returns (uint48 validAfter, uint48 validUntil, bytes memory signature)
    {
        if (envelope.length != 288) revert InvalidSignatureEnvelope();
        uint256 version;
        uint256 kind;
        uint256 afterWord;
        uint256 untilWord;
        uint256 offset;
        uint256 length;
        uint256 tail;
        assembly ("memory-safe") {
            version := calldataload(envelope.offset)
            kind := calldataload(add(envelope.offset, 32))
            afterWord := calldataload(add(envelope.offset, 64))
            untilWord := calldataload(add(envelope.offset, 96))
            offset := calldataload(add(envelope.offset, 128))
            length := calldataload(add(envelope.offset, 160))
            tail := calldataload(add(envelope.offset, 256))
        }
        if (
            version != 1 || kind != 1 || afterWord > type(uint48).max || untilWord > type(uint48).max || offset != 160
                || length != 65 || uint248(tail) != 0
        ) revert InvalidSignatureEnvelope();
        return (uint48(afterWord), uint48(untilWord), envelope[192:257]);
    }

    function _typedDigest(bytes32 nameHash, bytes32 structHash) internal view returns (bytes32) {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                nameHash,
                keccak256("1"),
                block.chainid,
                address(this)
            )
        );
        return keccak256(abi.encodePacked(hex"1901", domain, structHash));
    }

    function _recover(bytes32 digest, bytes memory signature) internal pure returns (address) {
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly ("memory-safe") {
            r := mload(add(signature, 32))
            s := mload(add(signature, 64))
            v := byte(0, mload(add(signature, 96)))
        }
        if (uint256(s) > 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0) return address(0);
        return ecrecover(digest, v, r, s);
    }
}

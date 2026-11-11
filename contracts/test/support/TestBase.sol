// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface Vm {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }

    function prank(address) external;
    function deal(address, uint256) external;
    function etch(address, bytes calldata) external;
    function chainId(uint256) external;
    function warp(uint256) external;
    function expectRevert(bytes calldata) external;
    function expectRevert(bytes4) external;
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
    function addr(uint256) external returns (address);
}

abstract contract TestBase {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function assertEq(uint256 a, uint256 b, string memory reason) internal pure {
        require(a == b, reason);
    }

    function assertEq(address a, address b, string memory reason) internal pure {
        require(a == b, reason);
    }

    function assertEq(bytes memory a, bytes memory b, string memory reason) internal pure {
        require(keccak256(a) == keccak256(b), reason);
    }

    function assertTrue(bool value, string memory reason) internal pure {
        require(value, reason);
    }
}

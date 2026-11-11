// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {EntryPoint} from "@account-abstraction/core/EntryPoint.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// Test asset used only by local and Arbitrum Sepolia verification.
contract TestToken is ERC20 {
    constructor(address holder) ERC20("Abstract Test Token", "AWT") {
        _mint(holder, 1_000_000_000);
    }
    function decimals() public pure override returns (uint8) { return 6; }
}

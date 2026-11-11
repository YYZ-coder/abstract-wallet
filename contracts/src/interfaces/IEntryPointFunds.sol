// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IEntryPointFunds {
    function balanceOf(address account) external view returns (uint256);
    function depositTo(address account) external payable;
    function withdrawTo(address payable recipient, uint256 amount) external;
    function addStake(uint32 unstakeDelaySec) external payable;
    function unlockStake() external;
    function withdrawStake(address payable recipient) external;
}

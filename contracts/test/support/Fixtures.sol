// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

contract EntryPointFixture {
    mapping(address => uint256) public balanceOf;
    mapping(address => uint256) public stakeOf;
    mapping(address => uint256) public unlockTime;
    mapping(address => uint32) public unstakeDelay;
    bool public rejectPrefund;

    function setRejectPrefund(bool value) external {
        rejectPrefund = value;
    }

    receive() external payable {
        require(!rejectPrefund, "reject prefund");
        balanceOf[msg.sender] += msg.value;
    }

    function depositTo(address account) external payable {
        balanceOf[account] += msg.value;
    }

    function withdrawTo(address payable to, uint256 amount) external {
        require(balanceOf[msg.sender] >= amount, "insufficient deposit");
        balanceOf[msg.sender] -= amount;
        (bool ok,) = to.call{value: amount}("");
        require(ok, "withdraw failed");
    }

    function addStake(uint32 delay) external payable {
        require(delay >= unstakeDelay[msg.sender] && delay > 0, "delay");
        stakeOf[msg.sender] += msg.value;
        unstakeDelay[msg.sender] = delay;
        unlockTime[msg.sender] = 0;
    }

    function unlockStake() external {
        require(stakeOf[msg.sender] > 0, "stake");
        unlockTime[msg.sender] = block.timestamp + unstakeDelay[msg.sender];
    }

    function withdrawStake(address payable to) external {
        require(unlockTime[msg.sender] != 0 && block.timestamp >= unlockTime[msg.sender], "locked");
        uint256 amount = stakeOf[msg.sender];
        stakeOf[msg.sender] = 0;
        unlockTime[msg.sender] = 0;
        (bool ok,) = to.call{value: amount}("");
        require(ok, "withdraw failed");
    }
}

contract TokenFixture {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "insufficient");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract RevertingTarget {
    error Nope(uint256 value);

    function fail() external pure {
        revert Nope(7);
    }

    function returnsFalse() external pure returns (bool) {
        return false;
    }
}

interface IERC721ReceiverFixture {
    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4);
}

contract ERC721Fixture {
    mapping(uint256 => address) public ownerOf;

    constructor() {
        ownerOf[7] = msg.sender;
    }

    function safeTransferFrom(address from, address to, uint256 id) external {
        require(msg.sender == from && ownerOf[id] == from, "not owner");
        ownerOf[id] = to;
        if (to.code.length != 0) {
            require(IERC721ReceiverFixture(to).onERC721Received(msg.sender, from, id, "") == 0x150b7a02, "receiver");
        }
    }
}

interface IERC1155ReceiverFixture {
    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external returns (bytes4);
    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external
        returns (bytes4);
}

contract ERC1155Fixture {
    mapping(address => mapping(uint256 => uint256)) public balanceOf;

    constructor() {
        balanceOf[msg.sender][9] = 3;
    }

    function safeTransferFrom(address from, address to, uint256 id, uint256 value, bytes calldata data) external {
        require(msg.sender == from && balanceOf[from][id] >= value, "not owned");
        balanceOf[from][id] -= value;
        balanceOf[to][id] += value;
        require(
            IERC1155ReceiverFixture(to).onERC1155Received(msg.sender, from, id, value, data) == 0xf23a6e61, "receiver"
        );
    }

    function safeBatchTransferFrom(
        address from,
        address to,
        uint256[] calldata ids,
        uint256[] calldata values,
        bytes calldata data
    ) external {
        require(msg.sender == from && ids.length == values.length, "invalid");
        for (uint256 i; i < ids.length; ++i) {
            require(balanceOf[from][ids[i]] >= values[i], "not owned");
            balanceOf[from][ids[i]] -= values[i];
            balanceOf[to][ids[i]] += values[i];
        }
        require(
            IERC1155ReceiverFixture(to).onERC1155BatchReceived(msg.sender, from, ids, values, data) == 0xbc197c81,
            "receiver"
        );
    }
}

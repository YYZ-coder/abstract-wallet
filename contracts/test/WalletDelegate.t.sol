// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {WalletDelegate} from "../src/WalletDelegate.sol";
import {PackedUserOperation} from "../src/interfaces/PackedUserOperation.sol";
import {TestBase, Vm} from "./support/TestBase.sol";
import {EntryPointFixture, TokenFixture, RevertingTarget, ERC721Fixture, ERC1155Fixture} from "./support/Fixtures.sol";

contract WalletDelegateTest is TestBase {
    WalletDelegate internal wallet;
    EntryPointFixture internal ep;
    address internal constant A = 0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf;
    address internal constant B = address(0xB0B);
    address internal constant C = address(0xCA11);

    function setUp() public {
        vm.chainId(421614);
        ep = new EntryPointFixture();
        WalletDelegate implementation = new WalletDelegate(address(ep));
        // Unit-only context: this is code injection, not real 7702 authorization.
        vm.etch(A, address(implementation).code);
        wallet = WalletDelegate(payable(A));
        vm.deal(A, 2 ether);
    }

    function testRejectsUntrustedExecutor() public {
        WalletDelegate.Call[] memory calls = new WalletDelegate.Call[](1);
        calls[0] = WalletDelegate.Call(B, 0.1 ether, "");
        vm.prank(C);
        vm.expectRevert(abi.encodeWithSelector(WalletDelegate.UntrustedExecutor.selector, C));
        wallet.executeBatch(calls);
        assertEq(A.balance, 2 ether, "unauthorized account funds changed");
        assertEq(B.balance, 0, "unauthorized recipient funded");
    }

    function testEntryPointExecutesNativeTransfer() public {
        WalletDelegate.Call[] memory calls = new WalletDelegate.Call[](1);
        calls[0] = WalletDelegate.Call(B, 0.1 ether, "");
        vm.prank(address(ep));
        bytes[] memory results = wallet.executeBatch(calls);
        assertEq(B.balance, 0.1 ether, "recipient must receive exactly 0.1 ETH");
        assertEq(A.balance, 1.9 ether, "account must retain exactly 1.9 ETH");
        assertEq(results.length, 1, "one result required");
        assertEq(results[0], "", "EOA CALL returns empty bytes");
    }

    function testSelfExecutesNativeTransfer() public {
        WalletDelegate.Call[] memory calls = new WalletDelegate.Call[](1);
        calls[0] = WalletDelegate.Call(B, 0.1 ether, "");
        vm.prank(A);
        wallet.executeBatch(calls);
        assertEq(B.balance, 0.1 ether, "self path must be usable");
    }

    function testAtomicFailureExposesIndexAndRevertData() public {
        TokenFixture token = new TokenFixture();
        token.mint(A, 1_000_000_000);
        RevertingTarget target = new RevertingTarget();
        WalletDelegate.Call[] memory calls = new WalletDelegate.Call[](2);
        calls[0] = WalletDelegate.Call(address(token), 0, abi.encodeCall(token.transfer, (B, 25_000_000)));
        calls[1] = WalletDelegate.Call(address(target), 0, abi.encodeCall(target.fail, ()));
        vm.prank(address(ep));
        vm.expectRevert(
            abi.encodeWithSelector(
                WalletDelegate.BatchCallFailed.selector, 1, abi.encodeWithSelector(RevertingTarget.Nope.selector, 7)
            )
        );
        wallet.executeBatch(calls);
        assertEq(token.balanceOf(A), 1_000_000_000, "first CALL must roll back");
        assertEq(token.balanceOf(B), 0, "recipient must retain zero");
    }

    function testRejectsInvalidEntryPointDeployment() public {
        vm.expectRevert(abi.encodeWithSelector(WalletDelegate.InvalidEntryPoint.selector, address(0)));
        new WalletDelegate(address(0));
        vm.expectRevert(abi.encodeWithSelector(WalletDelegate.InvalidEntryPoint.selector, C));
        new WalletDelegate(C);
        assertEq(wallet.entryPoint(), address(ep), "immutable EP must survive code injection at A");
    }

    function testRejectsEmptyBatch() public {
        vm.prank(address(ep));
        vm.expectRevert(WalletDelegate.EmptyBatch.selector);
        wallet.executeBatch(new WalletDelegate.Call[](0));
    }

    function testCallCountBoundIsInclusive16() public {
        WalletDelegate.Call[] memory allowed = new WalletDelegate.Call[](16);
        for (uint256 i; i < 16; ++i) {
            allowed[i] = WalletDelegate.Call(B, 0, "");
        }
        vm.prank(address(ep));
        assertEq(wallet.executeBatch(allowed).length, 16, "16 direct calls must be allowed");
        vm.prank(address(ep));
        vm.expectRevert(abi.encodeWithSelector(WalletDelegate.TooManyCalls.selector, 17, 16));
        wallet.executeBatch(new WalletDelegate.Call[](17));
    }

    function testDataBoundUsesSumNotPerCall() public {
        WalletDelegate.Call[] memory calls = new WalletDelegate.Call[](2);
        calls[0] = WalletDelegate.Call(B, 0, new bytes(16384));
        calls[1] = WalletDelegate.Call(B, 0, new bytes(16384));
        vm.prank(address(ep));
        assertEq(wallet.executeBatch(calls).length, 2, "sum 32768 allowed excluding ABI overhead");
        calls[1].data = new bytes(16385);
        vm.prank(address(ep));
        vm.expectRevert(abi.encodeWithSelector(WalletDelegate.CallDataTooLarge.selector, 32769, 32768));
        wallet.executeBatch(calls);
    }

    function testReceivesNativeWithEmptyCalldata() public {
        vm.deal(address(this), 1 ether);
        (bool success,) = A.call{value: 0.1 ether}("");
        assertTrue(success, "empty calldata native transfer must succeed");
        assertEq(A.balance, 2.1 ether, "account must receive exact native value");
    }

    function testUnknownSelectorReturnsCustomErrorAndRetainsNoValue() public {
        vm.deal(address(this), 1 ether);
        (bool success, bytes memory reason) = A.call{value: 0.1 ether}(hex"deadbeef");
        assertTrue(!success, "unknown selector must revert");
        assertEq(
            reason,
            abi.encodeWithSelector(WalletDelegate.UnsupportedSelector.selector, bytes4(0xdeadbeef)),
            "custom selector error required"
        );
        assertEq(A.balance, 2 ether, "rejected value must not remain in account");
    }

    function testOnlyEntryPointCanRequestValidation() public {
        PackedUserOperation memory op;
        op.sender = A;
        vm.prank(C);
        vm.expectRevert(abi.encodeWithSelector(WalletDelegate.UntrustedEntryPoint.selector, C));
        wallet.validateUserOp(op, bytes32(uint256(1)), 1 ether);
        assertEq(A.balance, 2 ether, "untrusted validation cannot fund caller");
        assertEq(C.balance, 0, "caller cannot receive prefund");
    }

    function testValidationRejectsDifferentSender() public {
        PackedUserOperation memory op;
        op.sender = C;
        vm.prank(address(ep));
        vm.expectRevert(abi.encodeWithSelector(WalletDelegate.SenderMismatch.selector, C, A));
        wallet.validateUserOp(op, bytes32(uint256(1)), 0);
    }

    function _rootOp() internal pure returns (PackedUserOperation memory op) {
        op.sender = A;
        op.signature = abi.encode(
            uint8(1),
            uint8(1),
            uint48(1000),
            uint48(1100),
            hex"ab71b2cac569e13528fb8a3b25139be26bc9adba6979543acba300915b49493553b0a3cabcc715ea2872d00b6aa0178ee997996628d2b02a7d5fcdecf3c7fffd1c"
        );
    }

    function testAcceptsIndependentRootOperationVector() public {
        PackedUserOperation memory op = _rootOp();
        vm.prank(address(ep));
        uint256 actual =
            wallet.validateUserOp(op, 0x1111111111111111111111111111111111111111111111111111111111111111, 0);
        assertEq(
            actual,
            411376139330303118190543359632547650298999954319716587362949529600,
            "fixed independent validationData required"
        );
    }

    function testRootSignatureBindsHashChainAndAccount() public {
        PackedUserOperation memory op = _rootOp();
        vm.prank(address(ep));
        assertEq(
            wallet.validateUserOp(op, bytes32(uint256(12)), 0),
            1,
            "old root signature must reject changed independent hash"
        );
        vm.chainId(1);
        vm.prank(address(ep));
        assertEq(
            wallet.validateUserOp(op, 0x1111111111111111111111111111111111111111111111111111111111111111, 0),
            1,
            "root signature must reject changed chain"
        );
        vm.chainId(421614);
        vm.etch(B, A.code);
        op.sender = B;
        vm.prank(address(ep));
        assertEq(
            WalletDelegate(payable(B)).validateUserOp(
                op, 0x1111111111111111111111111111111111111111111111111111111111111111, 0
            ),
            1,
            "root signature cannot authorize another account"
        );
    }

    function testMalformedOperationEnvelopeUsesCustomError() public {
        PackedUserOperation memory op = _rootOp();
        op.signature[31] = bytes1(uint8(2));
        vm.prank(address(ep));
        vm.expectRevert(bytes4(keccak256("InvalidSignatureEnvelope()")));
        wallet.validateUserOp(op, 0x1111111111111111111111111111111111111111111111111111111111111111, 0);
    }

    function testOperationEnvelopeRejectsNoncanonicalLayouts() public {
        for (uint256 i; i < 7; ++i) {
            PackedUserOperation memory op = _rootOp();
            if (i == 0) op.signature[63] = bytes1(uint8(2));
            if (i == 1) op.signature = "";
            if (i == 2) op.signature = bytes.concat(op.signature, hex"00");
            if (i == 3) op.signature[159] = bytes1(uint8(192));
            if (i == 4) op.signature[191] = bytes1(uint8(64));
            if (i == 5) op.signature[287] = bytes1(uint8(1));
            if (i == 6) op.signature[64] = bytes1(uint8(1));
            vm.prank(address(ep));
            vm.expectRevert(bytes4(keccak256("InvalidSignatureEnvelope()")));
            wallet.validateUserOp(op, 0x1111111111111111111111111111111111111111111111111111111111111111, 0);
        }
    }

    function testHighSSignatureReturnsFailureInsteadOfAcceptingMalleability() public {
        PackedUserOperation memory op = _rootOp();
        op.signature = abi.encode(
            uint8(1),
            uint8(1),
            uint48(1000),
            uint48(1100),
            hex"ab71b2cac569e13528fb8a3b25139be26bc9adba6979543acba300915b494935ac4f5c354338ea15d78d2ff4955fe86fd11743808675f0114272909fdc6e41441b"
        );
        vm.prank(address(ep));
        assertEq(
            wallet.validateUserOp(op, 0x1111111111111111111111111111111111111111111111111111111111111111, 0),
            1,
            "high-s must return SIG_VALIDATION_FAILED=1"
        );
    }

    function testRejectsInvalidTimestampWindows() public {
        uint48[5] memory starts = [uint48(1000), 1101, 0, 1000, uint48(1 << 47)];
        uint48[5] memory ends = [uint48(1000), 1100, 0, uint48(1 << 47), uint48((1 << 47) + 1)];
        for (uint256 i; i < starts.length; ++i) {
            PackedUserOperation memory op = _rootOp();
            (,,,, bytes memory signature) = abi.decode(op.signature, (uint8, uint8, uint48, uint48, bytes));
            op.signature = abi.encode(uint8(1), uint8(1), starts[i], ends[i], signature);
            vm.prank(address(ep));
            vm.expectRevert(bytes4(keccak256("InvalidValidityWindow()")));
            wallet.validateUserOp(op, 0x1111111111111111111111111111111111111111111111111111111111111111, 0);
        }
    }

    function testFundsOnlyRequestedPrefund() public {
        PackedUserOperation memory op = _rootOp();
        vm.prank(address(ep));
        wallet.validateUserOp(op, 0x1111111111111111111111111111111111111111111111111111111111111111, 0.1 ether);
        assertEq(address(ep).balance, 0.1 ether, "EntryPoint must receive exact prefund q");
        assertEq(A.balance, 1.9 ether, "account must not send its full balance");
    }

    function _messageSignature() internal pure returns (bytes memory) {
        return abi.encode(
            uint8(1),
            uint8(2),
            hex"82f9c7c71a01939e06bbe44da4e2b2b4640c737fadbd7f3ca217781309495f445ddbcf308d5ad91df2373031f15a0f0d0a45a74ece0c8e59bc4b88fd3e6f15a91b"
        );
    }

    function testAcceptsIndependent1271MessageVector() public view {
        assertEq(
            uint32(
                wallet.isValidSignature(
                    0x2222222222222222222222222222222222222222222222222222222222222222, _messageSignature()
                )
            ),
            uint32(0x1626ba7e),
            "valid root message needs exact magic value"
        );
    }

    function testReceivesSafeERC721Transfer() public {
        ERC721Fixture nft = new ERC721Fixture();
        nft.safeTransferFrom(address(this), A, 7);
        assertEq(nft.ownerOf(7), A, "NFT ownership must actually move to A");
    }

    function testReceivesERC1155SingleAndBatchAssets() public {
        ERC1155Fixture nft = new ERC1155Fixture();
        nft.safeTransferFrom(address(this), A, 9, 2, "");
        assertEq(nft.balanceOf(A, 9), 2, "single transfer asset balance");
        uint256[] memory ids = new uint256[](1);
        ids[0] = 9;
        uint256[] memory values = new uint256[](1);
        values[0] = 1;
        nft.safeBatchTransferFrom(address(this), A, ids, values, "");
        assertEq(nft.balanceOf(A, 9), 3, "batch transfer final asset balance");
    }

    function testSupportsOnlyPromisedReceiverInterfacesWithin30kGas() public view {
        bytes4[4] memory supported = [bytes4(0x01ffc9a7), 0x150b7a02, 0x4e2312e0, 0x1626ba7e];
        for (uint256 i; i < supported.length; ++i) {
            (bool ok, bytes memory result) =
                A.staticcall{gas: 30000}(abi.encodeCall(wallet.supportsInterface, (supported[i])));
            assertTrue(ok && abi.decode(result, (bool)), "promised interface must fit 30k gas");
        }
        assertTrue(!wallet.supportsInterface(0xffffffff), "ERC165 invalid interface must be false");
        assertTrue(!wallet.supportsInterface(0x80ac58cd), "wallet is not ERC721 token contract");
        assertTrue(!wallet.supportsInterface(0xd9b67a26), "wallet is not ERC1155 token contract");
    }

    function testSuccessfulBatchEmitsAtAccountWithExecutor() public {
        WalletDelegate.Call[] memory calls = new WalletDelegate.Call[](1);
        calls[0] = WalletDelegate.Call(B, 0, "");
        vm.recordLogs();
        vm.prank(address(ep));
        wallet.executeBatch(calls);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1, "successful batch emits one own event");
        assertEq(logs[0].emitter, A, "event must come from account context");
        assertEq(uint256(logs[0].topics[0]), uint256(keccak256("BatchExecuted(address,uint256)")), "event signature");
        assertEq(address(uint160(uint256(logs[0].topics[1]))), address(ep), "event executor");
        assertEq(abi.decode(logs[0].data, (uint256)), 1, "event call count");
    }

    function testAuthorizedTokenBatchMatchesFixedBalancesAndResults() public {
        TokenFixture token = new TokenFixture();
        token.mint(A, 1_000_000_000);
        WalletDelegate.Call[] memory calls = new WalletDelegate.Call[](2);
        calls[0] = WalletDelegate.Call(address(token), 0, abi.encodeCall(token.transfer, (B, 25_000_000)));
        calls[1] = WalletDelegate.Call(address(token), 0, abi.encodeCall(token.transfer, (B, 10_000_000)));
        vm.prank(address(ep));
        bytes[] memory result = wallet.executeBatch(calls);
        assertEq(token.balanceOf(A), 965_000_000, "fixed account token balance");
        assertEq(token.balanceOf(B), 35_000_000, "fixed recipient token balance");
        assertEq(result[0], abi.encode(true), "first original return bytes");
        assertEq(result[1], abi.encode(true), "second original return bytes");
    }

    function test1271InvalidInputsReturnExactFailureWithoutReverting() public {
        bytes memory envelope = _messageSignature();
        assertEq(
            uint32(wallet.isValidSignature(bytes32(uint256(7)), envelope)), uint32(0xffffffff), "message hash binding"
        );
        assertEq(uint32(wallet.isValidSignature(bytes32(0), "")), uint32(0xffffffff), "empty message signature");
        for (uint256 i; i < 6; ++i) {
            bytes memory invalid = _messageSignature();
            if (i == 0) invalid[31] = bytes1(uint8(2));
            if (i == 1) invalid[63] = bytes1(uint8(1));
            if (i == 2) invalid[95] = bytes1(uint8(128));
            if (i == 3) invalid[127] = bytes1(uint8(64));
            if (i == 4) invalid[223] = bytes1(uint8(1));
            if (i == 5) invalid = bytes.concat(invalid, hex"00");
            assertEq(
                uint32(
                    wallet.isValidSignature(0x2222222222222222222222222222222222222222222222222222222222222222, invalid)
                ),
                uint32(0xffffffff),
                "noncanonical message signature"
            );
        }
        assertEq(
            uint32(wallet.isValidSignature(bytes32(0), _rootOp().signature)),
            uint32(0xffffffff),
            "operation/message purpose isolation"
        );
        vm.chainId(1);
        assertEq(
            uint32(
                wallet.isValidSignature(0x2222222222222222222222222222222222222222222222222222222222222222, envelope)
            ),
            uint32(0xffffffff),
            "message chain isolation"
        );
    }

    function testPrefundZeroExactInsufficientAndInvalidRoot() public {
        uint256[3] memory requested = [uint256(0), 2 ether, 2 ether + 1];
        uint256[3] memory paid = [uint256(0), 2 ether, 0];
        uint256[3] memory retained = [uint256(2 ether), 0, 2 ether];
        for (uint256 i; i < 3; ++i) {
            vm.deal(A, 2 ether);
            vm.deal(address(ep), 0);
            vm.prank(address(ep));
            assertEq(
                wallet.validateUserOp(
                    _rootOp(), 0x1111111111111111111111111111111111111111111111111111111111111111, requested[i]
                ),
                411376139330303118190543359632547650298999954319716587362949529600,
                "prefund outcome does not change signature result"
            );
            assertEq(address(ep).balance, paid[i], "exact independent paid amount");
            assertEq(A.balance, retained[i], "no partial payment");
        }
        vm.prank(address(ep));
        assertEq(wallet.validateUserOp(_rootOp(), bytes32(uint256(12)), 1 ether), 1, "invalid signature result");
        assertEq(A.balance, 2 ether, "invalid root cannot trigger prefund");
    }

    function testDepositWithdrawalRequiresRootExecutionAndExactRecipient() public {
        vm.deal(address(this), 1 ether);
        ep.depositTo{value: 1 ether}(A);
        WalletDelegate.Call[] memory calls = new WalletDelegate.Call[](1);
        calls[0] = WalletDelegate.Call(address(ep), 0, abi.encodeCall(ep.withdrawTo, (payable(B), 0.3 ether)));
        vm.prank(C);
        vm.expectRevert(abi.encodeWithSelector(WalletDelegate.UntrustedExecutor.selector, C));
        wallet.executeBatch(calls);
        assertEq(ep.balanceOf(A), 1 ether, "untrusted withdrawal changes no deposit");
        vm.prank(A);
        wallet.executeBatch(calls);
        assertEq(B.balance, 0.3 ether, "exact root-selected recipient amount");
        assertEq(ep.balanceOf(A), 0.7 ether, "only requested deposit removed");
        calls[0].data = abi.encodeCall(ep.withdrawTo, (payable(B), 0.8 ether));
        vm.prank(A);
        vm.expectRevert(
            abi.encodeWithSelector(
                WalletDelegate.BatchCallFailed.selector,
                0,
                abi.encodeWithSignature("Error(string)", "insufficient deposit")
            )
        );
        wallet.executeBatch(calls);
        assertEq(B.balance, 0.3 ether, "overdraw cannot retain partial withdrawal");
    }

    function testCancellationCallHasNoBusinessAssetEffect() public {
        WalletDelegate.Call[] memory calls = new WalletDelegate.Call[](1);
        calls[0] = WalletDelegate.Call(A, 0, "");
        vm.prank(address(ep));
        bytes[] memory result = wallet.executeBatch(calls);
        assertEq(A.balance, 2 ether, "no business asset moves during cancellation body");
        assertEq(result.length, 1, "one cancellation CALL result");
        assertEq(result[0], "", "receive returns empty");
        // This unit does not model EntryPoint nonce consumption or a cancellation race.
    }

    function testExecutorPreservesSuccessfulFalseReturnValue() public {
        RevertingTarget target = new RevertingTarget();
        WalletDelegate.Call[] memory calls = new WalletDelegate.Call[](1);
        calls[0] = WalletDelegate.Call(address(target), 0, abi.encodeCall(target.returnsFalse, ()));
        vm.prank(address(ep));
        bytes[] memory result = wallet.executeBatch(calls);
        assertEq(result[0], abi.encode(false), "EVM CALL success is distinct from returned business false");
    }

    function testRejectedPrefundTransferDoesNotBecomeSignatureFailure() public {
        ep.setRejectPrefund(true);
        vm.prank(address(ep));
        uint256 result = wallet.validateUserOp(
            _rootOp(), 0x1111111111111111111111111111111111111111111111111111111111111111, 0.1 ether
        );
        assertEq(
            result,
            411376139330303118190543359632547650298999954319716587362949529600,
            "EP independently checks unpaid prefund"
        );
        assertEq(A.balance, 2 ether, "failed transfer sends no partial funds");
        assertEq(address(ep).balance, 0, "rejecting EP fixture receives nothing");
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {SignaturePaymaster} from "../src/SignaturePaymaster.sol";
import {WalletDelegate} from "../src/WalletDelegate.sol";
import {PackedUserOperation} from "../src/interfaces/PackedUserOperation.sol";
import {IPaymaster} from "../src/interfaces/IPaymaster.sol";
import {TestBase, Vm} from "./support/TestBase.sol";
import {EntryPointFixture} from "./support/Fixtures.sol";
import {PermitVector} from "./fixtures/PermitVector.sol";

contract SignaturePaymasterTest is TestBase {
    address internal constant A = 0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf;
    address internal constant EP = address(0xE0E0);
    address internal constant PM = address(0x9000);
    address internal constant D = address(0xD00D);
    address internal constant C = address(0xCA11);
    address internal constant B = address(0xB0B);
    SignaturePaymaster internal pm;
    SignaturePaymaster internal managed;
    EntryPointFixture internal ep;

    function setUp() public {
        vm.chainId(421614);
        EntryPointFixture implementation = new EntryPointFixture();
        vm.etch(EP, address(implementation).code);
        ep = EntryPointFixture(payable(EP));
        managed = new SignaturePaymaster(EP, vm.addr(2), address(this));
        vm.etch(PM, address(managed).code);
        pm = SignaturePaymaster(payable(PM));
        // Unit-only designator state. No authorization tuple or type-4 transaction is executed.
        vm.etch(A, abi.encodePacked(hex"ef0100", D));
    }

    function testPaymasterValidationRequiresEntryPoint() public {
        PackedUserOperation memory op;
        vm.prank(C);
        vm.expectRevert(abi.encodeWithSelector(SignaturePaymaster.UntrustedEntryPoint.selector, C));
        pm.validatePaymasterUserOp(op, bytes32(0), 0);
    }

    function testAcceptsIndependentPermitVectorWithEmptyContext() public {
        vm.prank(EP);
        (bytes memory context, uint256 validation) =
            pm.validatePaymasterUserOp(PermitVector.operation(), bytes32(0), 100000);
        assertEq(context, "", "MVP context must be empty");
        assertEq(
            validation,
            411376139330303118190543359632547650298999954319716587362949529600,
            "independent permit validationData"
        );
    }

    function testPaymasterDataRejectsNoncanonicalLayouts() public {
        for (uint256 i; i < 9; ++i) {
            PackedUserOperation memory op = PermitVector.operation();
            if (i == 0) op.paymasterAndData[19] = bytes1(uint8(1));
            if (i == 1) op.paymasterAndData[83] = bytes1(uint8(2));
            if (i == 2) op.paymasterAndData[84] = bytes1(uint8(1));
            if (i == 3) op.paymasterAndData = "";
            if (i == 4) op.paymasterAndData = bytes.concat(op.paymasterAndData, hex"00");
            if (i == 5) op.paymasterAndData[275] = bytes1(uint8(0));
            if (i == 6) op.paymasterAndData[307] = bytes1(uint8(64));
            if (i == 7) op.paymasterAndData[403] = bytes1(uint8(1));
            if (i == 8) op.paymasterAndData[116] = bytes1(uint8(1));
            vm.prank(EP);
            vm.expectRevert(SignaturePaymaster.MalformedPaymasterData.selector);
            pm.validatePaymasterUserOp(op, bytes32(0), 100000);
        }
    }

    function testPaymasterRejectsMalformedAccountEnvelope() public {
        PackedUserOperation memory op = PermitVector.operation();
        op.signature = "";
        vm.prank(EP);
        vm.expectRevert(bytes4(keccak256("InvalidSignatureEnvelope()")));
        pm.validatePaymasterUserOp(op, bytes32(0), 100000);
    }

    function _setWord(bytes memory data, uint256 offset, uint256 value) internal pure {
        assembly ("memory-safe") {
            mstore(add(add(data, 32), offset), value)
        }
    }

    function testPaymasterRejectsInvalidWindowStructures() public {
        for (uint256 i; i < 4; ++i) {
            PackedUserOperation memory op = PermitVector.operation();
            if (i == 0) _setWord(op.paymasterAndData, 148, 0);
            if (i == 1) _setWord(op.paymasterAndData, 116, 1100);
            if (i == 2) _setWord(op.paymasterAndData, 148, 1 << 47);
            if (i == 3) _setWord(op.signature, 96, 0);
            vm.prank(EP);
            vm.expectRevert(bytes4(keccak256("InvalidValidityWindow()")));
            pm.validatePaymasterUserOp(op, bytes32(0), 100000);
        }
    }

    function testPermitAndAccountWindowsMustMatchExactly() public {
        PackedUserOperation memory op = PermitVector.operation();
        _setWord(op.signature, 64, 1001);
        vm.prank(EP);
        vm.expectRevert(SignaturePaymaster.ValidityWindowMismatch.selector);
        pm.validatePaymasterUserOp(op, bytes32(0), 100000);
    }

    function testPermitReservationIdCannotBeZero() public {
        PackedUserOperation memory op = PermitVector.operation();
        _setWord(op.paymasterAndData, 212, 0);
        vm.prank(EP);
        vm.expectRevert(SignaturePaymaster.InvalidReservationId.selector);
        pm.validatePaymasterUserOp(op, bytes32(0), 100000);
    }

    function testPermitRequiresExactActualDelegation() public {
        PackedUserOperation memory op = PermitVector.operation();
        vm.etch(A, abi.encodePacked(hex"ef0100", C));
        vm.prank(EP);
        vm.expectRevert(abi.encodeWithSelector(SignaturePaymaster.DelegateMismatch.selector, D, C));
        pm.validatePaymasterUserOp(op, bytes32(0), 100000);
        vm.etch(A, "");
        vm.prank(EP);
        vm.expectRevert(abi.encodeWithSelector(SignaturePaymaster.InvalidDelegation.selector, A));
        pm.validatePaymasterUserOp(op, bytes32(0), 100000);
        vm.etch(A, hex"6000");
        vm.prank(EP);
        vm.expectRevert(abi.encodeWithSelector(SignaturePaymaster.InvalidDelegation.selector, A));
        pm.validatePaymasterUserOp(op, bytes32(0), 100000);
    }

    function testPermitCostCapIsInclusive() public {
        PackedUserOperation memory op = PermitVector.operation();
        vm.prank(EP);
        (, uint256 below) = pm.validatePaymasterUserOp(op, bytes32(0), 99999);
        assertEq(below, 411376139330303118190543359632547650298999954319716587362949529600, "below cap allowed");
        vm.prank(EP);
        (, uint256 at) = pm.validatePaymasterUserOp(op, bytes32(0), 100000);
        assertEq(at, 411376139330303118190543359632547650298999954319716587362949529600, "at cap allowed");
        vm.prank(EP);
        vm.expectRevert(abi.encodeWithSelector(SignaturePaymaster.CostLimitExceeded.selector, 100001, 100000));
        pm.validatePaymasterUserOp(op, bytes32(0), 100001);
    }

    function testNoOpPostOpStillRequiresEntryPoint() public {
        vm.prank(C);
        vm.expectRevert(abi.encodeWithSelector(SignaturePaymaster.UntrustedEntryPoint.selector, C));
        pm.postOp(IPaymaster.PostOpMode.opSucceeded, "", 0, 0);
        for (uint8 mode; mode < 3; ++mode) {
            vm.prank(EP);
            pm.postOp(IPaymaster.PostOpMode(mode), hex"1122", 123, 456);
        }
    }

    function testPaymasterDeploymentRejectsInvalidRoles() public {
        vm.expectRevert(abi.encodeWithSelector(SignaturePaymaster.InvalidEntryPoint.selector, address(0)));
        new SignaturePaymaster(address(0), vm.addr(2), address(this));
        vm.expectRevert(abi.encodeWithSelector(SignaturePaymaster.InvalidEntryPoint.selector, C));
        new SignaturePaymaster(C, vm.addr(2), address(this));
        vm.expectRevert(abi.encodeWithSelector(SignaturePaymaster.InvalidSponsorSigner.selector, address(0)));
        new SignaturePaymaster(EP, address(0), address(this));
        vm.expectRevert(abi.encodeWithSelector(SignaturePaymaster.InvalidOwner.selector, address(0)));
        new SignaturePaymaster(EP, vm.addr(2), address(0));
        assertEq(managed.entryPoint(), EP, "immutable EP");
        assertEq(managed.sponsorSigner(), vm.addr(2), "immutable sponsor signer");
        assertEq(managed.owner(), address(this), "platform owner");
    }

    function testOwnershipTransferIsTwoStepAndCannotBeHijacked() public {
        managed.transferOwnership(B);
        assertEq(managed.owner(), address(this), "owner does not change before acceptance");
        assertEq(managed.pendingOwner(), B, "designated pending owner");
        vm.prank(C);
        vm.expectRevert(abi.encodeWithSelector(SignaturePaymaster.UntrustedPendingOwner.selector, C));
        managed.acceptOwnership();
        vm.prank(B);
        managed.acceptOwnership();
        assertEq(managed.owner(), B, "pending owner accepts");
        assertEq(managed.pendingOwner(), address(0), "pending cleared");
        vm.expectRevert(abi.encodeWithSelector(SignaturePaymaster.UntrustedOwner.selector, address(this)));
        managed.transferOwnership(C);
        vm.prank(B);
        vm.expectRevert(abi.encodeWithSelector(SignaturePaymaster.InvalidOwner.selector, address(0)));
        managed.transferOwnership(address(0));
        assertEq(managed.sponsorSigner(), vm.addr(2), "owner change cannot rotate sponsor signer");
    }

    function testAnyoneCanFundOnlyThePaymasterDeposit() public {
        vm.deal(address(this), 1 ether);
        vm.deal(C, 1 ether);
        vm.prank(C);
        managed.deposit{value: 0.4 ether}();
        assertEq(managed.getDeposit(), 0.4 ether, "public deposit query must reflect EP state");
        assertEq(ep.balanceOf(address(managed)), 0.4 ether, "deposit belongs to PM");
        assertEq(ep.balanceOf(A), 0, "PM funding does not change user deposit");
        assertEq(managed.owner(), address(this), "funding confers no ownership");
        assertEq(address(managed).balance, 0, "all supplied value forwarded to EP");
    }

    function testOnlyOwnerWithdrawsExactPlatformDeposit() public {
        vm.deal(address(this), 1 ether);
        managed.deposit{value: 1 ether}();
        managed.withdrawTo(payable(B), 0.3 ether);
        assertEq(B.balance, 0.3 ether, "owner-selected withdrawal amount");
        assertEq(managed.getDeposit(), 0.7 ether, "remaining PM deposit");
        vm.prank(C);
        vm.expectRevert(abi.encodeWithSelector(SignaturePaymaster.UntrustedOwner.selector, C));
        managed.withdrawTo(payable(C), 0.1 ether);
        vm.expectRevert(abi.encodeWithSelector(SignaturePaymaster.InvalidWithdrawAddress.selector, address(0)));
        managed.withdrawTo(payable(address(0)), 0);
        vm.expectRevert(abi.encodeWithSignature("Error(string)", "insufficient deposit"));
        managed.withdrawTo(payable(B), 0.8 ether);
        assertEq(managed.getDeposit(), 0.7 ether, "failed withdrawals preserve deposit");
        assertEq(C.balance, 0, "non-owner receives no PM funds");
    }

    function testOwnerManagesSeparateStakeLifecycle() public {
        vm.deal(address(this), 1 ether);
        managed.addStake{value: 0.2 ether}(100);
        assertEq(ep.stakeOf(address(managed)), 0.2 ether, "PM stake funded");
        assertEq(managed.getDeposit(), 0, "stake is not spending deposit");
        vm.prank(C);
        vm.expectRevert(abi.encodeWithSelector(SignaturePaymaster.UntrustedOwner.selector, C));
        managed.unlockStake();
        vm.expectRevert(abi.encodeWithSelector(SignaturePaymaster.InvalidWithdrawAddress.selector, address(0)));
        managed.withdrawStake(payable(address(0)));
        vm.expectRevert(abi.encodeWithSignature("Error(string)", "locked"));
        managed.withdrawStake(payable(B));
        managed.unlockStake();
        vm.warp(block.timestamp + 100);
        managed.withdrawStake(payable(B));
        assertEq(B.balance, 0.2 ether, "withdraw matured PM stake");
        assertEq(ep.stakeOf(address(managed)), 0, "no remaining fixture stake");
    }

    function testOwnershipEventsMatchDeploymentAndTwoStepTransfer() public {
        address signer = vm.addr(2);
        vm.recordLogs();
        SignaturePaymaster target = new SignaturePaymaster(EP, signer, address(this));
        target.transferOwnership(B);
        vm.prank(B);
        target.acceptOwnership();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 3, "initial and both transfer stages must emit");
        for (uint256 i; i < 3; ++i) {
            assertEq(logs[i].emitter, address(target), "owner event emitter");
        }
        assertEq(
            uint256(logs[0].topics[0]), uint256(keccak256("OwnershipTransferred(address,address)")), "initial event"
        );
        assertEq(uint256(logs[0].topics[1]), 0, "initial previous owner zero");
        assertEq(address(uint160(uint256(logs[0].topics[2]))), address(this), "initial owner event");
        assertEq(
            uint256(logs[1].topics[0]), uint256(keccak256("OwnershipTransferStarted(address,address)")), "pending event"
        );
        assertEq(
            uint256(logs[2].topics[0]), uint256(keccak256("OwnershipTransferred(address,address)")), "accepted event"
        );
        assertEq(address(uint160(uint256(logs[2].topics[2]))), B, "new owner event");
    }

    function testPaymasterUnknownCallsCannotTrapNativeValue() public {
        vm.deal(address(this), 1 ether);
        (bool ok, bytes memory reason) = address(managed).call{value: 0.1 ether}(hex"deadbeef");
        assertTrue(!ok, "unknown PM call must fail");
        assertEq(
            reason,
            abi.encodeWithSelector(SignaturePaymaster.UnsupportedSelector.selector, bytes4(0xdeadbeef)),
            "unknown PM selector error"
        );
        (ok, reason) = address(managed).call{value: 0.1 ether}("");
        assertTrue(!ok, "use explicit deposit, not direct receive");
        assertEq(
            reason,
            abi.encodeWithSelector(SignaturePaymaster.UnsupportedSelector.selector, bytes4(0)),
            "empty PM fallback error"
        );
        assertEq(address(managed).balance, 0, "rejected value cannot remain");
    }

    function testPermitRejectsEveryTamperedOperationCommitment() public {
        for (uint256 i; i < 14; ++i) {
            vm.etch(A, abi.encodePacked(hex"ef0100", D));
            PackedUserOperation memory op = PermitVector.operation();
            if (i == 0) {
                op.sender = B;
                vm.etch(B, abi.encodePacked(hex"ef0100", D));
            }
            if (i == 1) op.nonce = 8;
            if (i == 2) op.initCode = hex"770200000000000000000000000000000000000001";
            if (i == 3) op.callData = hex"22334455";
            if (i == 4) op.accountGasLimits = bytes32(uint256(op.accountGasLimits) ^ 1);
            if (i == 5) op.preVerificationGas = 50001;
            if (i == 6) op.gasFees = bytes32(uint256(op.gasFees) ^ 1);
            if (i == 7) op.paymasterAndData[35] ^= bytes1(uint8(1));
            if (i == 8) op.paymasterAndData[51] = bytes1(uint8(1));
            if (i == 9) _setWord(op.paymasterAndData, 180, 100001);
            if (i == 10) op.paymasterAndData[243] ^= bytes1(uint8(1));
            if (i == 11) op.paymasterAndData[308] ^= bytes1(uint8(1));
            if (i == 12) {
                _setWord(op.signature, 64, 1001);
                _setWord(op.paymasterAndData, 116, 1001);
            }
            if (i == 13) {
                _setWord(op.paymasterAndData, 84, uint160(C));
                vm.etch(A, abi.encodePacked(hex"ef0100", C));
            }
            vm.prank(EP);
            (bytes memory context, uint256 validation) = pm.validatePaymasterUserOp(op, bytes32(0), 100000);
            assertEq(validation, 1, "old permit must reject each independently changed commitment");
            assertEq(context, "", "invalid permit retains empty context");
        }
    }

    function testPermitDomainsBindChainEntryPointAndPaymaster() public {
        PackedUserOperation memory op = PermitVector.operation();
        vm.chainId(1);
        vm.prank(EP);
        (, uint256 validation) = pm.validatePaymasterUserOp(op, bytes32(0), 100000);
        assertEq(validation, 1, "permit chain domain");
        vm.chainId(421614);
        EntryPointFixture otherEP = new EntryPointFixture();
        SignaturePaymaster otherImplementation = new SignaturePaymaster(address(otherEP), vm.addr(2), address(this));
        vm.etch(PM, address(otherImplementation).code);
        vm.prank(address(otherEP));
        (, validation) = pm.validatePaymasterUserOp(op, bytes32(0), 100000);
        assertEq(validation, 1, "permit immutable EP commitment");
        vm.etch(B, address(managed).code);
        bytes20 newPM = bytes20(B);
        for (uint256 i; i < 20; ++i) {
            op.paymasterAndData[i] = newPM[i];
        }
        vm.prank(EP);
        (, validation) = SignaturePaymaster(payable(B)).validatePaymasterUserOp(op, bytes32(0), 100000);
        assertEq(validation, 1, "permit verifying PM domain");
    }

    function testPermitDoesNotReplaceAccountRootValidation() public {
        PackedUserOperation memory op = PermitVector.operation();
        vm.prank(EP);
        (, uint256 feeValidation) = pm.validatePaymasterUserOp(op, bytes32(0), 100000);
        assertEq(
            feeValidation,
            411376139330303118190543359632547650298999954319716587362949529600,
            "fee permit remains valid with invalid root sig"
        );
        WalletDelegate implementation = new WalletDelegate(EP);
        vm.etch(A, address(implementation).code);
        vm.deal(A, 2 ether);
        vm.prank(EP);
        assertEq(
            WalletDelegate(payable(A)).validateUserOp(op, bytes32(0), 1 ether),
            1,
            "valid sponsorship cannot authorize assets"
        );
        assertEq(A.balance, 2 ether, "invalid account signature cannot trigger prefund");
        bytes memory feeSignature = new bytes(65);
        for (uint256 i; i < 65; ++i) {
            feeSignature[i] = op.paymasterAndData[308 + i];
        }
        op.signature = abi.encode(uint8(1), uint8(1), uint48(1000), uint48(1100), feeSignature);
        vm.prank(EP);
        assertEq(
            WalletDelegate(payable(A)).validateUserOp(op, bytes32(0), 0),
            1,
            "sponsor signature is not root operation signature"
        );
        op.signature = abi.encode(
            uint8(1),
            uint8(1),
            uint48(1000),
            uint48(1100),
            hex"ab71b2cac569e13528fb8a3b25139be26bc9adba6979543acba300915b49493553b0a3cabcc715ea2872d00b6aa0178ee997996628d2b02a7d5fcdecf3c7fffd1c"
        );
        vm.prank(EP);
        assertEq(
            WalletDelegate(payable(A)).validateUserOp(
                op, 0x1111111111111111111111111111111111111111111111111111111111111111, 0
            ),
            411376139330303118190543359632547650298999954319716587362949529600,
            "independent correct root control"
        );
    }

    function testCanonicalUnsignedStubReturnsSignatureFailure() public {
        PackedUserOperation memory op = PermitVector.operation();
        for (uint256 i = 308; i < 372; ++i) {
            op.paymasterAndData[i] = 0;
        }
        op.paymasterAndData[372] = bytes1(uint8(27));
        vm.prank(EP);
        (bytes memory context, uint256 validation) = pm.validatePaymasterUserOp(op, bytes32(0), 100000);
        assertEq(context, "", "stub context empty");
        assertEq(validation, 1, "canonical r0s0v27 stub is non-executable, not malformed");
    }

    function testPaymasterReturnsWindowAtEveryTimestampBoundary() public {
        uint256[6] memory times = [uint256(999), 1000, 1001, 1099, 1100, 1101];
        for (uint256 i; i < times.length; ++i) {
            vm.warp(times[i]);
            vm.prank(EP);
            (, uint256 validation) = pm.validatePaymasterUserOp(PermitVector.operation(), bytes32(0), 100000);
            assertEq(
                validation,
                411376139330303118190543359632547650298999954319716587362949529600,
                "PM returns signed window; only real EP classifies current time"
            );
        }
    }
}

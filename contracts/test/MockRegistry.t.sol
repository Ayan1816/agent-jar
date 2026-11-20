// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockRegistry} from "./mocks/MockRegistry.sol";

contract MockRegistryTest is Test {
    MockRegistry internal registry;

    address internal alice;
    address internal bob;

    event Registered(bytes32 indexed labelhash, address indexed owner, string handle);

    function setUp() public {
        registry = new MockRegistry();
        alice = makeAddr("alice");
        bob = makeAddr("bob");
    }

    function test_register_resolvesForwardReverseAndBalance() public {
        vm.prank(alice);
        registry.register("alice");

        assertEq(registry.ownerOfHandle("alice"), alice);
        assertEq(registry.handleOf(alice), "alice");
        assertEq(registry.balanceOf(alice), 1);
        assertEq(registry.balanceOf(bob), 0);
        assertEq(registry.ownerOf(uint256(keccak256("alice"))), alice);
    }

    function test_register_emitsRegistered() public {
        bytes32 labelhash = keccak256("alice");
        vm.expectEmit(true, true, false, true, address(registry));
        emit Registered(labelhash, alice, "alice");

        vm.prank(alice);
        registry.register("alice");
    }

    function test_register_allowsDigitsAndTheLabelAi() public {
        vm.prank(alice);
        registry.register("agent123");
        assertEq(registry.handleOf(alice), "agent123");

        vm.prank(bob);
        registry.register("ai");
        assertEq(registry.ownerOfHandle("ai"), bob);
        assertEq(registry.balanceOf(bob), 1);
    }

    function test_unregisteredLookupsAreEmpty() public view {
        assertEq(registry.ownerOfHandle("missing"), address(0));
        assertEq(registry.handleOf(alice), "");
        assertEq(registry.balanceOf(alice), 0);
    }

    function test_ownerOfHandle_doesNotNormalizeCase() public {
        vm.prank(alice);
        registry.register("alice");

        assertEq(registry.ownerOfHandle("Alice"), address(0));
        assertEq(registry.ownerOfHandle("ALICE"), address(0));
        assertEq(registry.ownerOfHandle("alice"), alice);
    }

    function test_revert_uppercaseHandle() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(MockRegistry.InvalidHandle.selector, "Alice"));
        registry.register("Alice");
    }

    function test_revert_handleWithDotAiSuffix() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(MockRegistry.InvalidHandle.selector, "alice.ai"));
        registry.register("alice.ai");
    }

    function test_revert_bareDotAiAndUpperSuffix() public {
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(MockRegistry.InvalidHandle.selector, ".ai"));
        registry.register(".ai");
        vm.expectRevert(abi.encodeWithSelector(MockRegistry.InvalidHandle.selector, "alice.AI"));
        registry.register("alice.AI");
        vm.stopPrank();
    }

    function test_revert_emptyAndSymbolHandles() public {
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(MockRegistry.InvalidHandle.selector, ""));
        registry.register("");
        vm.expectRevert(abi.encodeWithSelector(MockRegistry.InvalidHandle.selector, "alice_bob"));
        registry.register("alice_bob");
        vm.expectRevert(abi.encodeWithSelector(MockRegistry.InvalidHandle.selector, "alice-bob"));
        registry.register("alice-bob");
        vm.expectRevert(abi.encodeWithSelector(MockRegistry.InvalidHandle.selector, "alice bob"));
        registry.register("alice bob");
        vm.stopPrank();
    }

    function test_revert_secondHandleForSameAddress() public {
        vm.startPrank(alice);
        registry.register("alice");
        vm.expectRevert(abi.encodeWithSelector(MockRegistry.AlreadyRegistered.selector, alice));
        registry.register("bob");
        vm.stopPrank();

        assertEq(registry.handleOf(alice), "alice");
        assertEq(registry.balanceOf(alice), 1);
        assertEq(registry.ownerOfHandle("bob"), address(0));
    }

    function test_revert_duplicateHandle() public {
        vm.prank(alice);
        registry.register("alice");

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(MockRegistry.HandleTaken.selector, "alice"));
        registry.register("alice");

        assertEq(registry.balanceOf(bob), 0);
        assertEq(registry.ownerOfHandle("alice"), alice);
    }

    function test_twoAddressesCanRegisterDifferentHandles() public {
        vm.prank(alice);
        registry.register("alice");
        vm.prank(bob);
        registry.register("bob");

        assertEq(registry.ownerOfHandle("alice"), alice);
        assertEq(registry.ownerOfHandle("bob"), bob);
        assertEq(registry.handleOf(alice), "alice");
        assertEq(registry.handleOf(bob), "bob");
        assertEq(registry.balanceOf(alice), 1);
        assertEq(registry.balanceOf(bob), 1);
    }

    function test_revert_transferFrom() public {
        uint256 tokenId = _registerAlice();

        vm.prank(alice);
        vm.expectRevert(MockRegistry.NonTransferable.selector);
        registry.transferFrom(alice, bob, tokenId);

        assertEq(registry.ownerOf(tokenId), alice);
        assertEq(registry.balanceOf(alice), 1);
        assertEq(registry.balanceOf(bob), 0);
        assertEq(registry.handleOf(alice), "alice");
    }

    function test_revert_transferToSelf() public {
        uint256 tokenId = _registerAlice();

        vm.prank(alice);
        vm.expectRevert(MockRegistry.NonTransferable.selector);
        registry.transferFrom(alice, alice, tokenId);
    }

    function test_revert_safeTransferFrom() public {
        uint256 tokenId = _registerAlice();

        vm.prank(alice);
        vm.expectRevert(MockRegistry.NonTransferable.selector);
        registry.safeTransferFrom(alice, bob, tokenId);

        vm.prank(alice);
        vm.expectRevert(MockRegistry.NonTransferable.selector);
        registry.safeTransferFrom(alice, bob, tokenId, "data");
    }

    function test_revert_approveAndOperator() public {
        uint256 tokenId = _registerAlice();

        vm.prank(alice);
        vm.expectRevert(MockRegistry.NonTransferable.selector);
        registry.approve(bob, tokenId);
        assertEq(registry.getApproved(tokenId), address(0));

        vm.prank(alice);
        vm.expectRevert(MockRegistry.NonTransferable.selector);
        registry.setApprovalForAll(bob, true);
        assertFalse(registry.isApprovedForAll(alice, bob));
    }

    function test_revert_thirdPartyTransfer() public {
        uint256 tokenId = _registerAlice();

        vm.prank(bob);
        vm.expectRevert(MockRegistry.NonTransferable.selector);
        registry.transferFrom(alice, bob, tokenId);
    }

    function test_balanceOf_revertsForZeroAddress() public {
        vm.expectRevert(abi.encodeWithSignature("ERC721InvalidOwner(address)", address(0)));
        registry.balanceOf(address(0));
    }

    function _registerAlice() internal returns (uint256 tokenId) {
        vm.prank(alice);
        registry.register("alice");
        tokenId = uint256(keccak256("alice"));
    }
}

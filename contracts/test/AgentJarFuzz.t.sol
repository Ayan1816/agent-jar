// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {AgentJar} from "../src/AgentJar.sol";
import {AgentJarMetadata} from "../src/libraries/AgentJarMetadata.sol";
import {MockRegistry} from "./mocks/MockRegistry.sol";

contract FuzzERC20 is ERC20 {
    constructor() ERC20("Fuzz USD", "FUSD") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract AgentJarFuzzTest is Test {
    MockRegistry internal registry;
    FuzzERC20 internal usdt;
    FuzzERC20 internal usdc;
    AgentJar internal jar;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal nonHolder = makeAddr("nonHolder");

    function setUp() public {
        registry = new MockRegistry();
        usdt = new FuzzERC20();
        usdc = new FuzzERC20();
        jar = new AgentJar(registry, usdt, usdc);

        vm.prank(alice);
        registry.register("alice");
        vm.prank(bob);
        registry.register("bob");
    }

    function testFuzz_tipBNB_verifiedVsUnverified(uint96 rawAmount, bool senderIsVerified) public {
        uint256 amount = bound(uint256(rawAmount), jar.MIN_NATIVE_TIP(), type(uint96).max);
        address sender = senderIsVerified ? bob : nonHolder;
        vm.deal(sender, amount);

        uint256 aliceBefore = alice.balance;
        vm.prank(sender);
        jar.tipBNB{value: amount}("alice", "fuzz");

        assertEq(alice.balance, aliceBefore + amount);
        assertEq(address(jar).balance, 0);

        (uint32 tips, uint32 supporters, uint96 bnbReceived,) = jar.recipientStats(alice);
        assertEq(bnbReceived, amount);
        if (senderIsVerified) {
            assertEq(tips, 1);
            assertEq(supporters, 1);
            assertEq(jar.getScore(alice), 6);
            assertTrue(jar.isActiveAgent(alice));
            assertTrue(jar.isActiveAgent(bob));
        } else {
            assertEq(tips, 0);
            assertEq(supporters, 0);
            assertEq(jar.getScore(alice), 0);
            assertEq(jar.getScore(nonHolder), 0);
            assertFalse(jar.isActiveAgent(nonHolder));
            assertFalse(jar.isActiveAgent(alice));
        }
    }

    function testFuzz_tipToken_revertsPastUint96(uint256 excess) public {
        uint256 overflowAmount = uint256(type(uint96).max) + 1 + bound(excess, 0, 1e18);
        usdt.mint(bob, overflowAmount);
        vm.startPrank(bob);
        usdt.approve(address(jar), overflowAmount);
        vm.expectRevert(abi.encodeWithSelector(SafeCast.SafeCastOverflowedUintDowncast.selector, 96, overflowAmount));
        jar.tipToken("alice", address(usdt), overflowAmount, "overflow");
        vm.stopPrank();
    }

    function testFuzz_createPoll_durationAndLengths(uint64 duration, uint16 qLen, uint8 optLen, bool supporterOnly)
        public
    {
        uint256 questionLength = bound(uint256(qLen), 0, 240);
        uint256 optionLength = bound(uint256(optLen), 0, 90);
        string memory question = _repeatByte("q", questionLength);
        string[] memory opts = new string[](2);
        opts[0] = _repeatByte("a", optionLength);
        opts[1] = "ok";

        uint256 maxQ = jar.MAX_QUESTION_BYTES();
        uint256 maxO = jar.MAX_OPTION_BYTES();
        uint64 minD = jar.MIN_POLL_DURATION();
        uint64 maxD = jar.MAX_POLL_DURATION();

        vm.prank(alice);
        if (questionLength == 0 || questionLength > maxQ) {
            vm.expectRevert(AgentJar.InvalidQuestion.selector);
            jar.createPoll(question, opts, duration, supporterOnly);
        } else if (duration < minD || duration > maxD) {
            vm.expectRevert(AgentJar.InvalidDuration.selector);
            jar.createPoll(question, opts, duration, supporterOnly);
        } else if (optionLength == 0 || optionLength > maxO) {
            vm.expectRevert(AgentJar.InvalidOptions.selector);
            jar.createPoll(question, opts, duration, supporterOnly);
        } else {
            uint256 pollId = jar.createPoll(question, opts, duration, supporterOnly);
            (, uint64 endTime,, bool gated,,,,) = jar.getPoll(pollId);
            assertEq(endTime, uint64(vm.getBlockTimestamp() + duration));
            assertEq(gated, supporterOnly);
            assertEq(jar.getScore(alice), 0);
        }
    }

    function testFuzz_activeAgentsPagination(uint8 countRaw, uint256 offset, uint256 limit) public {
        uint256 count = bound(uint256(countRaw), 0, 25);
        for (uint256 i; i < count; ++i) {
            address agent = address(uint160(0xB000 + i));
            string memory handle = string.concat("a", vm.toString(i));
            vm.prank(agent);
            registry.register(handle);
            vm.deal(agent, 1 ether);
            vm.prank(agent);
            jar.tipBNB{value: jar.MIN_NATIVE_TIP()}("alice", "hi");
        }

        uint256 total = jar.activeAgentCount();
        address[] memory page = jar.getActiveAgents(offset, limit);

        if (offset >= total || limit == 0) {
            assertEq(page.length, 0);
        } else {
            uint256 expectedLen = total - offset;
            if (limit < expectedLen) expectedLen = limit;
            assertEq(page.length, expectedLen);
            for (uint256 i; i < expectedLen; ++i) {
                assertEq(page[i], jar.activeAgents(offset + i));
                assertTrue(jar.isActiveAgent(page[i]));
            }
        }
    }

    function testFuzz_bountyTieSplit_conservesEveryWei(uint96 rawAmount, uint32 durationRaw) public {
        uint256 amount = bound(uint256(rawAmount), jar.MIN_NATIVE_TIP(), 1_000 ether);
        uint64 duration = uint64(bound(uint256(durationRaw), jar.MIN_BOUNTY_DURATION(), jar.MAX_BOUNTY_DURATION()));
        uint64 deadline = uint64(vm.getBlockTimestamp() + duration);

        vm.deal(alice, amount);
        uint256 aliceStart = alice.balance;
        uint256 bobStart = bob.balance;

        vm.prank(alice);
        uint256 id = jar.createBounty{value: amount}("bob", address(0), amount, deadline, keccak256("spec"));
        vm.prank(bob);
        jar.submitBountyWork(id, keccak256("work"));
        vm.prank(alice);
        jar.openDispute(id);

        vm.warp(jar.getBounty(id).disputeDeadline);
        jar.resolveExpiredDispute(id);

        uint256 workerShare = amount / 2;
        uint256 creatorShare = amount - workerShare;
        assertEq(workerShare + creatorShare, amount);
        assertEq(bob.balance, bobStart + workerShare);
        assertEq(alice.balance, aliceStart - amount + creatorShare);
        assertEq(address(jar).balance, 0);
    }

    function testFuzz_metadataEscaping_removesRawXmlDelimiters(string memory raw) public pure {
        string memory xmlSafe = AgentJarMetadata.escapeXml(raw);
        bytes memory b = bytes(xmlSafe);
        for (uint256 i; i < b.length; ++i) {
            assertTrue(b[i] != "<" && b[i] != ">" && b[i] != '"' && b[i] != "'");
        }

        string memory jsonSafe = AgentJarMetadata.escapeJson(raw);
        bytes memory jb = bytes(jsonSafe);
        // Every '"' in escaped JSON must be preceded by an odd number of backslashes.
        for (uint256 i; i < jb.length; ++i) {
            if (jb[i] == '"') {
                uint256 slashes;
                uint256 k = i;
                while (k > 0 && jb[k - 1] == "\\") {
                    slashes += 1;
                    k -= 1;
                }
                assertEq(slashes % 2, 1);
            }
        }
    }

    function _repeatByte(bytes1 ch, uint256 len) internal pure returns (string memory) {
        bytes memory out = new bytes(len);
        for (uint256 i; i < len; ++i) {
            out[i] = ch;
        }
        return string(out);
    }
}

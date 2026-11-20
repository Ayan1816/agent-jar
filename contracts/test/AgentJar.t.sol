// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {AgentJar} from "../src/AgentJar.sol";
import {MockRegistry} from "./mocks/MockRegistry.sol";

contract TipERC20 is ERC20 {
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Receives a native tip and tries to tip again before the outer call finishes.
contract ReenteringRecipient {
    AgentJar private immutable jar;
    string private otherHandle;
    bool public reenterFailed;

    constructor(AgentJar jar_, string memory otherHandle_) {
        jar = jar_;
        otherHandle = otherHandle_;
    }

    receive() external payable {
        try jar.tipBNB{value: 0.0001 ether}(otherHandle, "again") {
            reenterFailed = false;
        } catch {
            reenterFailed = true;
        }
    }
}

contract AgentJarTest is Test {
    event TipSent(
        address indexed sender,
        address indexed recipient,
        address indexed token,
        uint256 amount,
        string handle,
        string message
    );

    MockRegistry internal registry;
    TipERC20 internal usdt;
    TipERC20 internal usdc;
    AgentJar internal jar;

    uint256 internal constant MIN_NATIVE = 0.0001 ether;
    uint256 internal constant MIN_USD = 0.1 ether;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal tipper = makeAddr("tipper");

    function setUp() public {
        registry = new MockRegistry();
        usdt = new TipERC20("Test Dollar", "TDR");
        usdc = new TipERC20("Test Dollar Coin", "TDC");
        jar = new AgentJar(registry, usdt, usdc);
        assertEq(jar.MIN_NATIVE_TIP(), MIN_NATIVE);
        assertEq(jar.MIN_USD_TIP(), MIN_USD);

        _register(alice, "alice");
        _register(bob, "bob");
        _register(carol, "carol");

        vm.deal(alice, 10 ether);
        vm.deal(bob, 10 ether);
        vm.deal(carol, 10 ether);
        vm.deal(tipper, 10 ether);

        usdt.mint(tipper, 1_000 ether);
        usdc.mint(tipper, 1_000 ether);
        usdt.mint(alice, 1_000 ether);
        usdc.mint(alice, 1_000 ether);

        vm.prank(tipper);
        usdt.approve(address(jar), type(uint256).max);
        vm.prank(tipper);
        usdc.approve(address(jar), type(uint256).max);
        vm.prank(alice);
        usdt.approve(address(jar), type(uint256).max);
        vm.prank(alice);
        usdc.approve(address(jar), type(uint256).max);
    }

    function test_tipBNB_forwardsAndLeavesZeroBalance() public {
        uint256 amount = MIN_NATIVE;
        uint256 recipientBefore = alice.balance;
        uint256 senderBefore = tipper.balance;

        vm.expectEmit(true, true, true, true, address(jar));
        emit TipSent(tipper, alice, address(0), amount, "alice", "gm");
        vm.prank(tipper);
        jar.tipBNB{value: amount}("alice", "gm");

        assertEq(alice.balance, recipientBefore + amount);
        assertEq(tipper.balance, senderBefore - amount);
        assertEq(address(jar).balance, 0);
        assertEq(usdt.balanceOf(address(jar)), 0);

        (uint32 tips, uint32 supporters, uint96 nativeReceived, uint96 usdReceived) = jar.recipientStats(alice);
        assertEq(tips, 1);
        assertEq(supporters, 1);
        assertEq(nativeReceived, amount);
        assertEq(usdReceived, 0);

        (bool ok,) = address(jar).call{value: 1}("");
        assertFalse(ok);
        assertEq(address(jar).balance, 0);
    }

    function test_tipBNB_normalizesRahimAiToRahim() public {
        address rahim = makeAddr("rahim");
        _register(rahim, "rahim");
        uint256 before = rahim.balance;

        vm.expectEmit(true, true, true, true, address(jar));
        emit TipSent(tipper, rahim, address(0), MIN_NATIVE, "rahim", "hello");
        vm.prank(tipper);
        jar.tipBNB{value: MIN_NATIVE}("Rahim.ai", "hello");

        assertEq(rahim.balance, before + MIN_NATIVE);
        assertEq(address(jar).balance, 0);
        assertEq(registry.ownerOfHandle("rahim"), rahim);

        vm.prank(tipper);
        jar.tipBNB{value: MIN_NATIVE}("RAHIM.AI", "again");
        (uint32 tips,, uint96 nativeReceived,) = jar.recipientStats(rahim);
        assertEq(tips, 2);
        assertEq(nativeReceived, MIN_NATIVE * 2);
    }

    function test_tipBNB_revertsSelfTip() public {
        vm.prank(alice);
        vm.expectRevert(AgentJar.SelfTip.selector);
        jar.tipBNB{value: MIN_NATIVE}("Alice.AI", "nope");
        assertEq(address(jar).balance, 0);
    }

    function test_tipBNB_revertsUnknownHandle() public {
        vm.prank(tipper);
        vm.expectRevert(AgentJar.UnknownHandle.selector);
        jar.tipBNB{value: MIN_NATIVE}("missing", "hi");

        vm.prank(tipper);
        vm.expectRevert(AgentJar.UnknownHandle.selector);
        jar.tipBNB{value: MIN_NATIVE}(".ai", "hi");
    }

    function test_tip_revertsBelowMinimum() public {
        vm.prank(tipper);
        vm.expectRevert(AgentJar.TipTooSmall.selector);
        jar.tipBNB{value: MIN_NATIVE - 1}("alice", "hi");

        vm.prank(tipper);
        vm.expectRevert(AgentJar.TipTooSmall.selector);
        jar.tipToken("alice", address(usdt), MIN_USD - 1, "hi");

        assertEq(address(jar).balance, 0);
        assertEq(usdt.balanceOf(address(jar)), 0);
        assertEq(usdt.balanceOf(alice), 1_000 ether);
    }

    function test_tip_messageLengthBoundary() public {
        vm.prank(tipper);
        jar.tipBNB{value: MIN_NATIVE}("alice", new string(280));

        vm.prank(tipper);
        vm.expectRevert(AgentJar.MessageTooLong.selector);
        jar.tipBNB{value: MIN_NATIVE}("alice", new string(281));

        vm.prank(tipper);
        vm.expectRevert(AgentJar.MessageTooLong.selector);
        jar.tipToken("bob", address(usdc), MIN_USD, new string(281));
    }

    function test_tipToken_usdtForwardsAndTracksUsd() public {
        uint256 amount = MIN_USD;
        uint256 senderBefore = usdt.balanceOf(tipper);
        uint256 recipientBefore = usdt.balanceOf(alice);

        vm.expectEmit(true, true, true, true, address(jar));
        emit TipSent(tipper, alice, address(usdt), amount, "alice", "usd");
        vm.prank(tipper);
        jar.tipToken("alice", address(usdt), amount, "usd");

        assertEq(usdt.balanceOf(alice), recipientBefore + amount);
        assertEq(usdt.balanceOf(tipper), senderBefore - amount);
        assertEq(usdt.balanceOf(address(jar)), 0);
        assertEq(address(jar).balance, 0);

        (uint32 tips, uint32 supporters, uint96 nativeReceived, uint96 usdReceived) = jar.recipientStats(alice);
        assertEq(tips, 1);
        assertEq(supporters, 1);
        assertEq(nativeReceived, 0);
        assertEq(usdReceived, amount);
    }

    function test_tipToken_usdcForwardsAndLeavesZeroBalance() public {
        uint256 amount = 2 * MIN_USD;
        vm.prank(tipper);
        jar.tipToken("bob", address(usdc), amount, "usdc");

        assertEq(usdc.balanceOf(bob), amount);
        assertEq(usdc.balanceOf(address(jar)), 0);
        (,,, uint96 usdReceived) = jar.recipientStats(bob);
        assertEq(usdReceived, amount);
    }

    function test_tipToken_revertsUnsupportedToken() public {
        TipERC20 other = new TipERC20("Other", "OTH");
        other.mint(tipper, 1 ether);
        vm.prank(tipper);
        other.approve(address(jar), type(uint256).max);

        vm.prank(tipper);
        vm.expectRevert(AgentJar.UnsupportedToken.selector);
        jar.tipToken("alice", address(other), MIN_USD, "no");

        vm.prank(tipper);
        vm.expectRevert(AgentJar.UnsupportedToken.selector);
        jar.tipToken("alice", address(0), MIN_USD, "no");

        assertEq(other.balanceOf(alice), 0);
        assertEq(other.balanceOf(address(jar)), 0);
    }

    function test_tip_countsUniqueSupportersAndRecipientsOnce() public {
        vm.startPrank(tipper);
        jar.tipBNB{value: MIN_NATIVE}("alice", "one");
        jar.tipBNB{value: MIN_NATIVE}("alice", "two");
        jar.tipToken("bob", address(usdt), MIN_USD, "three");
        vm.stopPrank();

        (, uint32 aliceSupporters,,) = jar.recipientStats(alice);
        (uint32 tipped,,,,,,,) = jar.senderStats(tipper);
        assertEq(aliceSupporters, 1);
        assertEq(tipped, 2);

        vm.prank(bob);
        jar.tipBNB{value: MIN_NATIVE}("alice", "from bob");
        (, aliceSupporters,,) = jar.recipientStats(alice);
        assertEq(aliceSupporters, 2);
        (uint32 bobTipped,,,,,,,) = jar.senderStats(bob);
        assertEq(bobTipped, 1);
    }

    function test_tipBNB_revertsOnReentrancy() public {
        ReenteringRecipient attacker = new ReenteringRecipient(jar, "alice");
        vm.deal(address(attacker), 1 ether);
        vm.prank(address(attacker));
        registry.register("attacker");

        uint256 before = address(attacker).balance;
        vm.prank(tipper);
        jar.tipBNB{value: MIN_NATIVE}("attacker", "hi");

        assertTrue(attacker.reenterFailed());
        assertEq(address(attacker).balance, before + MIN_NATIVE);
        assertEq(address(jar).balance, 0);
        (, uint32 supporters,,) = jar.recipientStats(address(attacker));
        assertEq(supporters, 1);
    }

    function test_createPoll_recordsDetailsForHolder() public {
        assertEq(jar.balanceOf(alice), 0);
        string[] memory options = _pair();
        uint64 duration = 1 hours;

        vm.prank(alice);
        uint256 pollId = jar.createPoll("Ship it?", options, duration);

        assertEq(pollId, 0);
        assertEq(jar.pollCount(), 1);
        (
            address creator,
            uint64 endTime,
            bool open,
            string memory question,
            string[] memory stored,
            uint32[] memory votes
        ) = jar.getPoll(pollId);
        assertEq(creator, alice);
        assertEq(endTime, uint64(block.timestamp + duration));
        assertTrue(open);
        assertEq(question, "Ship it?");
        assertEq(stored.length, 2);
        assertEq(stored[0], "yes");
        assertEq(stored[1], "no");
        assertEq(votes[0], 0);
        assertEq(jar.optionVotes(pollId, 0), 0);
        assertFalse(jar.hasVoted(pollId, bob));
    }

    function test_createPoll_revertsForNonHolderAndInvalidArgs() public {
        string[] memory options = _pair();
        vm.prank(tipper);
        vm.expectRevert(AgentJar.NotHolder.selector);
        jar.createPoll("q", options, 1 hours);

        vm.startPrank(alice);
        vm.expectRevert(AgentJar.InvalidQuestion.selector);
        jar.createPoll("", options, 1 hours);

        string[] memory one = new string[](1);
        one[0] = "only";
        vm.expectRevert(AgentJar.InvalidOptions.selector);
        jar.createPoll("q", one, 1 hours);

        string[] memory seven = new string[](7);
        for (uint256 i; i < 7; ++i) seven[i] = "opt";
        vm.expectRevert(AgentJar.InvalidOptions.selector);
        jar.createPoll("q", seven, 1 hours);

        string[] memory blank = _pair();
        blank[1] = "";
        vm.expectRevert(AgentJar.InvalidOptions.selector);
        jar.createPoll("q", blank, 1 hours);

        vm.expectRevert(AgentJar.InvalidDuration.selector);
        jar.createPoll("q", options, uint64(1 hours) - 1);
        vm.expectRevert(AgentJar.InvalidDuration.selector);
        jar.createPoll("q", options, uint64(30 days) + 1);

        uint256 created = jar.createPoll("q", options, 30 days);
        assertEq(created, 0);
        vm.stopPrank();
        assertEq(jar.pollCount(), 1);
    }

    function test_createPoll_rateLimitsThreePerUtcDay() public {
        string[] memory options = _pair();
        vm.startPrank(alice);
        jar.createPoll("one", options, 1 hours);
        jar.createPoll("two", options, 1 hours);
        jar.createPoll("three", options, 1 hours);
        vm.expectRevert(AgentJar.PollRateLimited.selector);
        jar.createPoll("four", options, 1 hours);
        vm.warp(block.timestamp + 1 days);
        uint256 pollId = jar.createPoll("next day", options, 1 hours);
        vm.stopPrank();

        assertEq(pollId, 3);
        assertEq(jar.pollCount(), 4);
        (,,,,, uint32 lastVoteDay, uint32 pollDay, uint8 pollsToday) = jar.senderStats(alice);
        assertEq(lastVoteDay, 0);
        assertEq(pollDay, uint32(block.timestamp / 1 days) + 1);
        assertEq(pollsToday, 1);
    }

    function test_vote_revertsForNonHolderDoubleVoteExpiryAndBadIndex() public {
        vm.prank(alice);
        uint256 pollId = jar.createPoll("Pick", _pair(), 1 hours);

        vm.prank(tipper);
        vm.expectRevert(AgentJar.NotHolder.selector);
        jar.vote(pollId, 0);

        vm.prank(bob);
        jar.vote(pollId, 1);
        assertTrue(jar.hasVoted(pollId, bob));
        assertEq(jar.optionVotes(pollId, 1), 1);

        vm.prank(bob);
        vm.expectRevert(AgentJar.AlreadyVoted.selector);
        jar.vote(pollId, 0);

        vm.prank(carol);
        vm.expectRevert(AgentJar.InvalidOption.selector);
        jar.vote(pollId, 2);

        vm.prank(carol);
        vm.expectRevert(AgentJar.PollNotFound.selector);
        jar.vote(9, 0);

        (, uint64 endTime,,,,) = jar.getPoll(pollId);
        vm.warp(endTime);
        vm.prank(carol);
        vm.expectRevert(AgentJar.PollClosed.selector);
        jar.vote(pollId, 0);
        (,, bool open,,,) = jar.getPoll(pollId);
        assertFalse(open);
    }

    function test_vote_streakIncrementsResetsAndKeepsBest() public {
        vm.startPrank(alice);
        uint256 first = jar.createPoll("d0a", _pair(), 30 days);
        uint256 second = jar.createPoll("d0b", _pair(), 30 days);
        uint256 third = jar.createPoll("d0c", _pair(), 30 days);
        vm.stopPrank();

        vm.startPrank(bob);
        jar.vote(first, 0);
        jar.vote(second, 0);
        vm.stopPrank();
        (,,, uint32 currentStreak, uint32 bestStreak,,,) = jar.senderStats(bob);
        assertEq(currentStreak, 1);
        assertEq(bestStreak, 1);

        vm.warp(block.timestamp + 1 days);
        vm.prank(alice);
        uint256 fourth = jar.createPoll("d1", _pair(), 30 days);
        vm.prank(bob);
        jar.vote(third, 0);
        (,,, currentStreak, bestStreak,,,) = jar.senderStats(bob);
        assertEq(currentStreak, 2);
        assertEq(bestStreak, 2);

        vm.warp(block.timestamp + 2 days);
        vm.prank(bob);
        jar.vote(fourth, 1);
        (uint32 tipped, uint32 pollVotes, uint32 pollsCreated, uint32 streakNow, uint32 bestNow,,,) =
            jar.senderStats(bob);
        assertEq(tipped, 0);
        assertEq(pollsCreated, 0);
        assertEq(pollVotes, 4);
        assertEq(streakNow, 1);
        assertEq(bestNow, 2);

        (,,,,, uint32[] memory tally) = jar.getPoll(fourth);
        assertEq(tally[1], 1);
    }

    function test_scoreFormula_weightsEachComponent() public {
        vm.prank(bob);
        jar.tipBNB{value: MIN_NATIVE}("alice", "a");
        vm.prank(carol);
        jar.tipBNB{value: MIN_NATIVE}("alice", "b");
        vm.prank(alice);
        jar.tipToken("bob", address(usdt), MIN_USD, "back");
        vm.prank(alice);
        uint256 pollId = jar.createPoll("q", _pair(), 1 hours);
        vm.prank(alice);
        jar.vote(pollId, 0);

        // supporters 2*5 + tipped 1*3 + tips 2 + votes 1 + streak 2 + polls 2 = 20
        assertEq(jar.getScore(alice), 20);
        (uint8 tierId, string memory tierName) = jar.getTier(jar.getScore(alice));
        assertEq(tierId, 2);
        assertEq(tierName, "Bronze");

        // Bob received one tip (5+1) and tipped one agent (3) = 9, still Spark.
        assertEq(jar.getScore(bob), 9);
        (tierId, tierName) = jar.getTier(jar.getScore(bob));
        assertEq(tierId, 1);
        assertEq(tierName, "Spark");
    }

    function test_score_capsTipsAt100() public {
        for (uint256 i; i < 101; ++i) {
            vm.prank(tipper);
            jar.tipBNB{value: MIN_NATIVE}("alice", "g");
        }
        (uint32 tips, uint32 supporters,,) = jar.recipientStats(alice);
        assertEq(tips, 101);
        assertEq(supporters, 1);
        assertEq(jar.getScore(alice), 5 + 100);
    }

    function test_getTier_boundariesFromNoneThroughLegend() public view {
        _assertTier(0, 0, "None");
        _assertTier(1, 1, "Spark");
        _assertTier(9, 1, "Spark");
        _assertTier(10, 2, "Bronze");
        _assertTier(39, 2, "Bronze");
        _assertTier(40, 3, "Silver");
        _assertTier(119, 3, "Silver");
        _assertTier(120, 4, "Gold");
        _assertTier(399, 4, "Gold");
        _assertTier(400, 5, "Legend");
        _assertTier(1_000, 5, "Legend");
    }

    function test_score_crossesSparkThroughLegend() public {
        assertEq(jar.getScore(alice), 0);
        (uint8 tierId,) = jar.getTier(jar.getScore(alice));
        assertEq(tierId, 0);

        for (uint256 i; i < 80; ++i) {
            address supporter = address(uint160(0xA000 + i));
            vm.deal(supporter, 1 ether);
            vm.prank(supporter);
            jar.tipBNB{value: MIN_NATIVE}("alice", "g");
            uint256 score = jar.getScore(alice);
            if (i == 0) {
                assertEq(score, 6);
                (tierId,) = jar.getTier(score);
                assertEq(tierId, 1);
            } else if (i == 1) {
                assertEq(score, 12);
                (tierId,) = jar.getTier(score);
                assertEq(tierId, 2);
            } else if (i == 6) {
                assertEq(score, 42);
                (tierId,) = jar.getTier(score);
                assertEq(tierId, 3);
            } else if (i == 19) {
                assertEq(score, 120);
                (tierId,) = jar.getTier(score);
                assertEq(tierId, 4);
            }
        }

        uint256 legendScore = jar.getScore(alice);
        assertEq(legendScore, 480);
        (tierId,) = jar.getTier(legendScore);
        assertEq(tierId, 5);
    }

    function test_claimBadge_requiresHolderAndActivity() public {
        vm.prank(tipper);
        vm.expectRevert(AgentJar.NotHolder.selector);
        jar.claimBadge();

        vm.prank(alice);
        vm.expectRevert(AgentJar.ScoreTooLow.selector);
        jar.claimBadge();

        vm.prank(bob);
        jar.tipBNB{value: MIN_NATIVE}("alice", "gm");
        assertGe(jar.getScore(alice), 1);

        vm.prank(alice);
        uint256 tokenId = jar.claimBadge();
        assertEq(tokenId, jar.tokenIdOf(alice));
        assertEq(jar.ownerOf(tokenId), alice);
        assertEq(jar.balanceOf(alice), 1);
        assertEq(jar.name(), "AgentJar Badge");
        assertEq(jar.symbol(), "AJB");

        vm.prank(alice);
        vm.expectRevert(AgentJar.BadgeAlreadyClaimed.selector);
        jar.claimBadge();
    }

    function test_badge_isSoulbound() public {
        vm.prank(bob);
        jar.tipBNB{value: MIN_NATIVE}("alice", "gm");
        vm.prank(alice);
        uint256 tokenId = jar.claimBadge();

        vm.startPrank(alice);
        vm.expectRevert(AgentJar.NonTransferable.selector);
        jar.transferFrom(alice, bob, tokenId);
        vm.expectRevert(AgentJar.NonTransferable.selector);
        jar.safeTransferFrom(alice, bob, tokenId);
        vm.expectRevert(AgentJar.NonTransferable.selector);
        jar.safeTransferFrom(alice, bob, tokenId, "");
        vm.expectRevert(AgentJar.NonTransferable.selector);
        jar.approve(bob, tokenId);
        vm.expectRevert(AgentJar.NonTransferable.selector);
        jar.setApprovalForAll(bob, true);
        vm.stopPrank();

        assertEq(jar.ownerOf(tokenId), alice);
        assertEq(jar.balanceOf(alice), 1);
        assertEq(jar.balanceOf(bob), 0);
    }

    function test_tokenURI_updatesWhenScoreIncreases() public {
        vm.prank(alice);
        jar.createPoll("q", _pair(), 1 hours);
        assertEq(jar.getScore(alice), 2);

        vm.prank(alice);
        uint256 tokenId = jar.claimBadge();
        string memory before = _metadata(tokenId);
        string memory beforeSvg = _svg(before);
        assertTrue(_has(before, '"trait_type":"Handle","value":"alice"'));
        assertTrue(_has(before, '"trait_type":"Score","value":2'));
        assertTrue(_has(before, '"trait_type":"Tier","value":"Spark"'));
        assertTrue(_has(beforeSvg, "@alice"));
        assertTrue(_has(beforeSvg, "Spark"));
        assertTrue(_has(beforeSvg, "#0B0E11"));
        assertTrue(_has(beforeSvg, "#161A1E"));
        assertTrue(_has(beforeSvg, "#F0B90B"));
        assertFalse(_has(before, "Binance"));

        vm.prank(bob);
        jar.tipBNB{value: MIN_NATIVE}("alice", "one");
        vm.prank(carol);
        jar.tipBNB{value: MIN_NATIVE}("alice", "two");
        // poll 2 + two supporters (10) + two tips (2) = 14
        assertEq(jar.getScore(alice), 14);

        string memory updated = _metadata(tokenId);
        string memory updatedSvg = _svg(updated);
        assertTrue(_has(updated, '"trait_type":"Score","value":14'));
        assertTrue(_has(updated, '"trait_type":"Tier","value":"Bronze"'));
        assertTrue(_has(updatedSvg, "Bronze"));
        assertTrue(_has(updatedSvg, "@alice"));
        assertFalse(_has(updated, '"value":"Spark"'));
        assertEq(jar.ownerOf(tokenId), alice);
    }

    function _register(address account, string memory handle) internal {
        vm.prank(account);
        registry.register(handle);
    }

    function _pair() internal pure returns (string[] memory options) {
        options = new string[](2);
        options[0] = "yes";
        options[1] = "no";
    }

    function _assertTier(uint256 score, uint8 expectedId, string memory expectedName) internal view {
        (uint8 tierId, string memory tierName) = jar.getTier(score);
        assertEq(tierId, expectedId);
        assertEq(tierName, expectedName);
    }

    function _metadata(uint256 tokenId) internal view returns (string memory) {
        bytes memory uri = bytes(jar.tokenURI(tokenId));
        bytes memory prefix = bytes("data:application/json;base64,");
        bytes memory encoded = new bytes(uri.length - prefix.length);
        for (uint256 i; i < encoded.length; ++i) {
            encoded[i] = uri[prefix.length + i];
        }
        return string(Base64.decode(string(encoded)));
    }

    function _svg(string memory json) internal pure returns (string memory) {
        string memory encoded = _between(json, "data:image/svg+xml;base64,", "\"}");
        return string(Base64.decode(encoded));
    }

    function _between(string memory haystack, string memory start, string memory endMarker)
        internal
        pure
        returns (string memory)
    {
        bytes memory h = bytes(haystack);
        bytes memory s = bytes(start);
        bytes memory e = bytes(endMarker);
        uint256 startAt = _indexOf(h, s, 0);
        uint256 from = startAt + s.length;
        uint256 endAt = _indexOf(h, e, from);
        bytes memory out = new bytes(endAt - from);
        for (uint256 i; i < out.length; ++i) {
            out[i] = h[from + i];
        }
        return string(out);
    }

    function _has(string memory haystack, string memory needle) internal pure returns (bool) {
        bytes memory h = bytes(haystack);
        bytes memory n = bytes(needle);
        if (n.length == 0 || n.length > h.length) return false;
        return _indexOf(h, n, 0) != type(uint256).max;
    }

    function _indexOf(bytes memory haystack, bytes memory needle, uint256 from) internal pure returns (uint256) {
        if (needle.length == 0 || haystack.length < needle.length || from > haystack.length - needle.length) {
            return type(uint256).max;
        }
        uint256 last = haystack.length - needle.length;
        for (uint256 i = from; i <= last; ++i) {
            bool matched = true;
            for (uint256 j; j < needle.length; ++j) {
                if (haystack[i + j] != needle[j]) {
                    matched = false;
                    break;
                }
            }
            if (matched) return i;
        }
        return type(uint256).max;
    }
}

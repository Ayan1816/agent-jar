// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {AgentJar} from "../src/AgentJar.sol";
import {IAgentIdRegistry} from "../src/interfaces/IAgentIdRegistry.sol";
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

/// @dev Malicious contract that reverts on BNB receive until toggled, and can attempt reentrancy on claim.
contract RevertingRecipient {
    bool public acceptBNB;
    bool public attemptReenterClaim;
    bool public claimReenterFailed;
    AgentJar public targetJar;

    function setAcceptBNB(bool accept_) external {
        acceptBNB = accept_;
    }

    function armClaimReentrancy(AgentJar jar_) external {
        targetJar = jar_;
        attemptReenterClaim = true;
        acceptBNB = true;
    }

    function claim(AgentJar jar_) external {
        jar_.claimPendingBNB();
    }

    receive() external payable {
        require(acceptBNB, "NO_BNB");
        if (attemptReenterClaim) {
            attemptReenterClaim = false;
            try targetJar.claimPendingBNB() {
                claimReenterFailed = false;
            } catch {
                claimReenterFailed = true;
            }
        }
    }
}

/// @dev Gas-griefing recipient that burns its forwarded gas stipend in an infinite loop.
contract GasGrieferRecipient {
    receive() external payable {
        uint256 x;
        while (true) {
            unchecked {
                x += 1;
            }
        }
    }
}

/// @dev Registry returning arbitrary unvalidated handle strings to test JSON and XML escaping.
contract SpecialCharRegistry is IAgentIdRegistry {
    mapping(address => string) private _handles;
    mapping(bytes32 => address) private _owners;

    function setHandle(address owner, string calldata handle) external {
        _handles[owner] = handle;
        _owners[keccak256(bytes(handle))] = owner;
    }

    function ownerOfHandle(string calldata handle) external view returns (address) {
        return _owners[keccak256(bytes(handle))];
    }

    function handleOf(address owner) external view returns (string memory) {
        return _handles[owner];
    }

    function balanceOf(address owner) external view returns (uint256) {
        return bytes(_handles[owner]).length > 0 ? 1 : 0;
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
    event PendingWithdrawalCredited(address indexed recipient, uint256 amount);
    event PendingWithdrawalClaimed(address indexed recipient, uint256 amount);

    MockRegistry internal registry;
    TipERC20 internal usdt;
    TipERC20 internal usdc;
    AgentJar internal jar;

    uint256 internal constant MIN_NATIVE = 0.0001 ether;
    uint256 internal constant MIN_USD = 0.1 ether;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal dave = makeAddr("dave");
    address internal tipper = makeAddr("tipper"); // non-holder

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
        _register(dave, "dave");

        address[5] memory accounts = [alice, bob, carol, dave, tipper];
        for (uint256 i; i < accounts.length; ++i) {
            vm.deal(accounts[i], 10 ether);
            usdt.mint(accounts[i], 1_000 ether);
            usdc.mint(accounts[i], 1_000 ether);
            vm.startPrank(accounts[i]);
            usdt.approve(address(jar), type(uint256).max);
            usdc.approve(address(jar), type(uint256).max);
            vm.stopPrank();
        }
    }

    // -------------------------------------------------------------------------
    // Tipping & Anti-Wash-Farming
    // -------------------------------------------------------------------------

    function test_tipBNB_nonHolderForwardsWithoutInflatingReputation() public {
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

        // Volume tracked, but reputation & directory untouched for non-holder sender.
        (uint32 tips, uint32 supporters, uint96 nativeReceived, uint96 usdReceived) = jar.recipientStats(alice);
        assertEq(tips, 0);
        assertEq(supporters, 0);
        assertEq(nativeReceived, amount);
        assertEq(usdReceived, 0);
        assertEq(jar.getScore(alice), 0);
        assertEq(jar.getScore(tipper), 0);
        assertFalse(jar.isActiveAgent(tipper));
        assertFalse(jar.isActiveAgent(alice));
        assertEq(jar.activeAgentCount(), 0);

        // Contract rejects accidental direct BNB transfers.
        (bool ok,) = address(jar).call{value: 1}("");
        assertFalse(ok);
        assertEq(address(jar).balance, 0);

        // Once tipper registers an Agent ID and tips again, verified reputation counts!
        _register(tipper, "tipper");
        vm.prank(tipper);
        jar.tipBNB{value: amount}("alice", "verified now");

        (tips, supporters, nativeReceived,) = jar.recipientStats(alice);
        assertEq(tips, 1);
        assertEq(supporters, 1);
        assertEq(nativeReceived, amount * 2);
        assertEq(jar.getScore(alice), 6);
        assertEq(jar.getScore(tipper), 3);
        assertTrue(jar.isActiveAgent(tipper));
        assertTrue(jar.isActiveAgent(alice));
    }

    function test_tipBNB_verifiedHolderNormalizesRahimAiToRahim() public {
        address rahim = makeAddr("rahim");
        _register(rahim, "rahim");
        uint256 before = rahim.balance;

        vm.expectEmit(true, true, true, true, address(jar));
        emit TipSent(bob, rahim, address(0), MIN_NATIVE, "rahim", "hello");
        vm.prank(bob);
        jar.tipBNB{value: MIN_NATIVE}("Rahim.ai", "hello");

        assertEq(rahim.balance, before + MIN_NATIVE);
        assertEq(address(jar).balance, 0);

        vm.prank(bob);
        jar.tipBNB{value: MIN_NATIVE}("RAHIM.AI", "again");
        (uint32 tips, uint32 supporters, uint96 nativeReceived,) = jar.recipientStats(rahim);
        assertEq(tips, 2);
        assertEq(supporters, 1);
        assertEq(nativeReceived, MIN_NATIVE * 2);
    }

    function test_tipBNB_revertsSelfTipAndUnknownHandle() public {
        vm.prank(alice);
        vm.expectRevert(AgentJar.SelfTip.selector);
        jar.tipBNB{value: MIN_NATIVE}("Alice.AI", "nope");
        assertEq(address(jar).balance, 0);

        vm.prank(bob);
        vm.expectRevert(AgentJar.UnknownHandle.selector);
        jar.tipBNB{value: MIN_NATIVE}("missing", "hi");

        vm.prank(bob);
        vm.expectRevert(AgentJar.UnknownHandle.selector);
        jar.tipBNB{value: MIN_NATIVE}(".ai", "hi");
    }

    function test_tip_revertsBelowMinimumAndMessageLengthBoundary() public {
        vm.prank(bob);
        vm.expectRevert(AgentJar.TipTooSmall.selector);
        jar.tipBNB{value: MIN_NATIVE - 1}("alice", "hi");

        vm.prank(bob);
        vm.expectRevert(AgentJar.TipTooSmall.selector);
        jar.tipToken("alice", address(usdt), MIN_USD - 1, "hi");

        vm.prank(bob);
        jar.tipBNB{value: MIN_NATIVE}("alice", new string(280));

        vm.prank(bob);
        vm.expectRevert(AgentJar.MessageTooLong.selector);
        jar.tipBNB{value: MIN_NATIVE}("alice", new string(281));

        vm.prank(bob);
        vm.expectRevert(AgentJar.MessageTooLong.selector);
        jar.tipToken("alice", address(usdc), MIN_USD, new string(281));
    }

    function test_tipToken_usdtUsdcAndUnsupportedToken() public {
        uint256 amount = MIN_USD;
        uint256 aliceUsdtBefore = usdt.balanceOf(alice);

        vm.expectEmit(true, true, true, true, address(jar));
        emit TipSent(bob, alice, address(usdt), amount, "alice", "usd");
        vm.prank(bob);
        jar.tipToken("alice", address(usdt), amount, "usd");

        assertEq(usdt.balanceOf(alice), aliceUsdtBefore + amount);
        assertEq(usdt.balanceOf(address(jar)), 0);

        (uint32 tips, uint32 supporters, uint96 nativeReceived, uint96 usdReceived) = jar.recipientStats(alice);
        assertEq(tips, 1);
        assertEq(supporters, 1);
        assertEq(nativeReceived, 0);
        assertEq(usdReceived, amount);

        // Non-holder USDC tip forwards funds but does NOT add reputation
        uint256 bobUsdcBefore = usdc.balanceOf(bob);
        vm.prank(tipper);
        jar.tipToken("bob", address(usdc), 2 * MIN_USD, "usdc");
        assertEq(usdc.balanceOf(bob), bobUsdcBefore + 2 * MIN_USD);
        assertEq(usdc.balanceOf(address(jar)), 0);
        (uint32 bobTips, uint32 bobSupporters,, uint96 bobUsd) = jar.recipientStats(bob);
        assertEq(bobTips, 0);
        assertEq(bobSupporters, 0);
        assertEq(bobUsd, 2 * MIN_USD);

        // Unsupported tokens revert
        TipERC20 other = new TipERC20("Other", "OTH");
        other.mint(bob, 1 ether);
        vm.startPrank(bob);
        other.approve(address(jar), type(uint256).max);
        vm.expectRevert(AgentJar.UnsupportedToken.selector);
        jar.tipToken("alice", address(other), MIN_USD, "no");
        vm.expectRevert(AgentJar.UnsupportedToken.selector);
        jar.tipToken("alice", address(0), MIN_USD, "no");
        vm.stopPrank();
    }

    function test_tip_countsVerifiedUniqueSupportersOnce() public {
        vm.startPrank(bob);
        jar.tipBNB{value: MIN_NATIVE}("alice", "one");
        jar.tipBNB{value: MIN_NATIVE}("alice", "two");
        jar.tipToken("carol", address(usdt), MIN_USD, "three");
        vm.stopPrank();

        (uint32 aliceTips, uint32 aliceSupporters,,) = jar.recipientStats(alice);
        (uint32 bobTipped,,,,,,,) = jar.senderStats(bob);
        assertEq(aliceTips, 2);
        assertEq(aliceSupporters, 1);
        assertEq(bobTipped, 2);

        // 50 wash-farming non-holder wallets cannot inflate alice's score
        for (uint256 i; i < 50; ++i) {
            address sybil = address(uint160(0xF000 + i));
            vm.deal(sybil, 1 ether);
            vm.prank(sybil);
            jar.tipBNB{value: MIN_NATIVE}("alice", "wash");
        }
        (aliceTips, aliceSupporters,,) = jar.recipientStats(alice);
        assertEq(aliceTips, 2);
        assertEq(aliceSupporters, 1);
        assertEq(jar.getScore(alice), 7); // 1*5 + 2
    }

    function test_tipBNB_revertsOnReentrancy() public {
        ReenteringRecipient attacker = new ReenteringRecipient(jar, "alice");
        vm.deal(address(attacker), 1 ether);
        vm.prank(address(attacker));
        registry.register("attacker");

        uint256 before = address(attacker).balance;
        vm.prank(bob);
        jar.tipBNB{value: MIN_NATIVE}("attacker", "hi");

        assertTrue(attacker.reenterFailed());
        assertEq(address(attacker).balance, before + MIN_NATIVE);
        assertEq(address(jar).balance, 0);
        assertEq(jar.pendingWithdrawals(address(attacker)), 0);
        (, uint32 supporters,,) = jar.recipientStats(address(attacker));
        assertEq(supporters, 1);
    }

    // -------------------------------------------------------------------------
    // Pull-Payment BNB Fallback & SafeCast
    // -------------------------------------------------------------------------

    function test_tipBNB_revertingAndGasGriefingRecipientUsePendingWithdrawals() public {
        RevertingRecipient blocker = new RevertingRecipient();
        vm.prank(address(blocker));
        registry.register("blocker");

        vm.expectEmit(true, false, false, true, address(jar));
        emit PendingWithdrawalCredited(address(blocker), MIN_NATIVE);
        vm.prank(bob);
        jar.tipBNB{value: MIN_NATIVE}("blocker", "no dos");

        assertEq(address(blocker).balance, 0);
        assertEq(jar.pendingWithdrawals(address(blocker)), MIN_NATIVE);
        assertEq(address(jar).balance, MIN_NATIVE);

        // Claim fails while blocker still rejects BNB, preserving balance
        vm.expectRevert(AgentJar.TransferFailed.selector);
        blocker.claim(jar);
        assertEq(jar.pendingWithdrawals(address(blocker)), MIN_NATIVE);

        // Reentrancy during claimPendingBNB is blocked and payout succeeds
        blocker.armClaimReentrancy(jar);
        vm.expectEmit(true, false, false, true, address(jar));
        emit PendingWithdrawalClaimed(address(blocker), MIN_NATIVE);
        blocker.claim(jar);

        assertTrue(blocker.claimReenterFailed());
        assertEq(address(blocker).balance, MIN_NATIVE);
        assertEq(jar.pendingWithdrawals(address(blocker)), 0);
        assertEq(address(jar).balance, 0);

        // Second claim reverts NothingToClaim
        vm.expectRevert(AgentJar.NothingToClaim.selector);
        blocker.claim(jar);

        // Gas-griefer infinite loop cannot DoS tipper
        GasGrieferRecipient griefer = new GasGrieferRecipient();
        vm.prank(address(griefer));
        registry.register("griefer");
        vm.prank(bob);
        jar.tipBNB{value: MIN_NATIVE}("griefer", "capped gas");
        assertEq(jar.pendingWithdrawals(address(griefer)), MIN_NATIVE);
    }

    function test_safeCast_revertsOnUint96Overflow() public {
        uint256 tooLarge = uint256(type(uint96).max) + 1;
        usdt.mint(bob, tooLarge);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(SafeCast.SafeCastOverflowedUintDowncast.selector, 96, tooLarge));
        jar.tipToken("alice", address(usdt), tooLarge, "huge");
    }

    // -------------------------------------------------------------------------
    // Persistent Active Agent Directory & Pagination
    // -------------------------------------------------------------------------

    function test_activeAgents_directoryAndPaginationEdgeCases() public {
        assertEq(jar.activeAgentCount(), 0);
        assertEq(jar.getActiveAgents(0, 10).length, 0);

        // Verified activity registers agents once in deterministic order
        vm.prank(alice);
        jar.createPoll("Q1", _pair(), 6 hours); // [alice]
        vm.prank(bob);
        jar.tipBNB{value: MIN_NATIVE}("carol", "hi"); // [alice, bob, carol]
        vm.prank(dave);
        jar.vote(0, 0); // [alice, bob, carol, dave]
        // Duplicate activity does not re-register
        vm.prank(alice);
        jar.vote(0, 1);

        assertEq(jar.activeAgentCount(), 4);
        assertTrue(jar.isActiveAgent(alice));
        assertTrue(jar.isActiveAgent(bob));
        assertTrue(jar.isActiveAgent(carol));
        assertTrue(jar.isActiveAgent(dave));
        assertFalse(jar.isActiveAgent(tipper));

        address[] memory p1 = jar.getActiveAgents(0, 2);
        assertEq(p1.length, 2);
        assertEq(p1[0], alice);
        assertEq(p1[1], bob);

        address[] memory p2 = jar.getActiveAgents(2, 2);
        assertEq(p2.length, 2);
        assertEq(p2[0], carol);
        assertEq(p2[1], dave);

        // Limit exceeding remaining & max uint256 does not overflow
        address[] memory tail = jar.getActiveAgents(3, type(uint256).max);
        assertEq(tail.length, 1);
        assertEq(tail[0], dave);

        // Out-of-bounds offset or zero limit returns empty array
        assertEq(jar.getActiveAgents(4, 5).length, 0);
        assertEq(jar.getActiveAgents(99, 5).length, 0);
        assertEq(jar.getActiveAgents(0, 0).length, 0);
    }

    // -------------------------------------------------------------------------
    // Poll Hardening: Caps, Duration, Supporter Gate, 3-Vote Score Rule
    // -------------------------------------------------------------------------

    function test_createPoll_enforcesCapsDurationAndRateLimit() public {
        string[] memory options = _pair();
        vm.prank(tipper);
        vm.expectRevert(AgentJar.NotHolder.selector);
        jar.createPoll("q", options, 6 hours);

        vm.startPrank(alice);
        // Empty & >200 byte question revert
        vm.expectRevert(AgentJar.InvalidQuestion.selector);
        jar.createPoll("", options, 6 hours);
        vm.expectRevert(AgentJar.InvalidQuestion.selector);
        jar.createPoll(_repeat("q", 201), options, 6 hours);

        // Option count & >64 byte option revert
        string[] memory one = new string[](1);
        one[0] = "only";
        vm.expectRevert(AgentJar.InvalidOptions.selector);
        jar.createPoll("q", one, 6 hours);

        string[] memory seven = new string[](7);
        for (uint256 i; i < 7; ++i) {
            seven[i] = "opt";
        }
        vm.expectRevert(AgentJar.InvalidOptions.selector);
        jar.createPoll("q", seven, 6 hours);

        string[] memory blank = _pair();
        blank[1] = "";
        vm.expectRevert(AgentJar.InvalidOptions.selector);
        jar.createPoll("q", blank, 6 hours);

        string[] memory longOpt = _pair();
        longOpt[0] = _repeat("o", 65);
        vm.expectRevert(AgentJar.InvalidOptions.selector);
        jar.createPoll("q", longOpt, 6 hours);

        // Duration bounds: 6 hours .. 7 days
        vm.expectRevert(AgentJar.InvalidDuration.selector);
        jar.createPoll("q", options, uint64(6 hours) - 1);
        vm.expectRevert(AgentJar.InvalidDuration.selector);
        jar.createPoll("q", options, uint64(7 days) + 1);

        // Exact max boundaries succeed (200-byte question, 64-byte option, 6h & 7d durations)
        string[] memory exactOpt = _pair();
        exactOpt[0] = _repeat("o", 64);
        uint256 p0 = jar.createPoll(_repeat("q", 200), exactOpt, 6 hours, false);
        uint256 p1 = jar.createPoll("mid", options, 3 days, true);
        uint256 p2 = jar.createPoll("max", options, 7 days, false);
        assertEq(p0, 0);
        assertEq(p1, 1);
        assertEq(p2, 2);

        // 4th poll in same UTC day reverts
        vm.expectRevert(AgentJar.PollRateLimited.selector);
        jar.createPoll("four", options, 6 hours);

        // Creating 3 polls awards ZERO free score!
        assertEq(jar.getScore(alice), 0);
        assertEq(jar.qualifiedPolls(alice), 0);

        // Next UTC day resets rate limit
        vm.warp(vm.getBlockTimestamp() + 1 days);
        uint256 p3 = jar.createPoll("next day", options, 6 hours);
        assertEq(p3, 3);
        vm.stopPrank();
    }

    function test_poll_creatorScoreAwardedOnlyAtThreeUniqueVotes() public {
        vm.prank(alice);
        uint256 pollId = jar.createPoll("Need 3 votes?", _pair(), 1 days);
        assertEq(jar.getScore(alice), 0);

        // Vote 1 (bob) -> still 0 creator score
        vm.prank(bob);
        jar.vote(pollId, 0);
        assertEq(jar.qualifiedPolls(alice), 0);
        assertEq(jar.getScore(alice), 0);

        // Vote 2 (carol) -> still 0 creator score
        vm.prank(carol);
        jar.vote(pollId, 1);
        assertEq(jar.qualifiedPolls(alice), 0);
        assertEq(jar.getScore(alice), 0);

        // Vote 3 (dave) -> hits 3 unique Agent ID votes -> +2 creator score!
        vm.prank(dave);
        jar.vote(pollId, 0);
        assertEq(jar.qualifiedPolls(alice), 1);
        assertEq(jar.getScore(alice), 2);

        // Vote 4 (alice herself) -> qualifiedPolls does NOT double count (stays 1)
        vm.prank(alice);
        jar.vote(pollId, 0);
        assertEq(jar.qualifiedPolls(alice), 1);
        // alice score: 2 (1 qualified poll) + 1 (vote) + 2 (streak 1) = 5
        assertEq(jar.getScore(alice), 5);

        (,,,, uint32 totalVotes,,,) = jar.getPoll(pollId);
        assertEq(totalVotes, 4);
    }

    function test_poll_supporterOnlyAllowsVerifiedTippersAndBountyPartnersOnly() public {
        vm.prank(alice);
        uint256 pollId = jar.createPoll("Supporters only", _pair(), 1 days, true);
        (,,, bool supporterOnly,,,,) = jar.getPoll(pollId);
        assertTrue(supporterOnly);

        // Unrelated holder (dave) & creator (alice) cannot vote
        vm.prank(dave);
        vm.expectRevert(AgentJar.NotSupporter.selector);
        jar.vote(pollId, 0);
        vm.prank(alice);
        vm.expectRevert(AgentJar.NotSupporter.selector);
        jar.vote(pollId, 0);

        // Non-holder cannot vote even after tipping
        vm.prank(tipper);
        jar.tipBNB{value: MIN_NATIVE}("alice", "nonholder");
        vm.prank(tipper);
        vm.expectRevert(AgentJar.NotHolder.selector);
        jar.vote(pollId, 0);

        // Bob becomes supporter via verified tip -> can vote
        vm.prank(bob);
        jar.tipBNB{value: MIN_NATIVE}("alice", "tip");
        vm.prank(bob);
        jar.vote(pollId, 0);
        assertTrue(jar.hasVoted(pollId, bob));

        // Carol becomes supporter by completing a bounty WITH alice (carol as creator, alice as worker)
        uint64 deadline = uint64(block.timestamp + 2 hours);
        vm.prank(carol);
        uint256 bountyId =
            jar.createBounty{value: MIN_NATIVE}("alice", address(0), MIN_NATIVE, deadline, keccak256("s"));
        vm.prank(alice);
        jar.submitBountyWork(bountyId, keccak256("d"));
        vm.prank(carol);
        jar.approveBounty(bountyId);

        assertTrue(jar.isSupporter(alice, carol));
        vm.prank(carol);
        jar.vote(pollId, 1);
        assertTrue(jar.hasVoted(pollId, carol));
    }

    function test_vote_streakAndExpiry() public {
        vm.startPrank(alice);
        uint256 first = jar.createPoll("d0a", _pair(), 7 days);
        uint256 second = jar.createPoll("d0b", _pair(), 7 days);
        uint256 third = jar.createPoll("d0c", _pair(), 7 days);
        vm.stopPrank();

        vm.startPrank(bob);
        jar.vote(first, 0);
        jar.vote(second, 0);
        vm.expectRevert(AgentJar.AlreadyVoted.selector);
        jar.vote(first, 1);
        vm.expectRevert(AgentJar.InvalidOption.selector);
        jar.vote(third, 2);
        vm.expectRevert(AgentJar.PollNotFound.selector);
        jar.vote(99, 0);
        vm.stopPrank();

        (,,, uint32 currentStreak, uint32 bestStreak,,,) = jar.senderStats(bob);
        assertEq(currentStreak, 1);
        assertEq(bestStreak, 1);

        vm.warp(vm.getBlockTimestamp() + 1 days);
        vm.prank(alice);
        uint256 fourth = jar.createPoll("d1", _pair(), 7 days);
        vm.prank(bob);
        jar.vote(third, 0);
        (,,, currentStreak, bestStreak,,,) = jar.senderStats(bob);
        assertEq(currentStreak, 2);
        assertEq(bestStreak, 2);

        vm.warp(vm.getBlockTimestamp() + 2 days);
        vm.prank(bob);
        jar.vote(fourth, 1);
        (,,, currentStreak, bestStreak,,,) = jar.senderStats(bob);
        assertEq(currentStreak, 1);
        assertEq(bestStreak, 2);

        // Expiry check
        (, uint64 endTime,,,,,,) = jar.getPoll(first);
        vm.warp(endTime);
        vm.prank(carol);
        vm.expectRevert(AgentJar.PollClosed.selector);
        jar.vote(first, 0);
        (,, bool open,,,,,) = jar.getPoll(first);
        assertFalse(open);
    }

    // -------------------------------------------------------------------------
    // Scoring, Tiers, Soulbound Passport & SVG/JSON Escaping
    // -------------------------------------------------------------------------

    function test_scoreFormula_weightsAllComponentsIncludingBounties() public {
        // 2 verified supporters tip alice: +2*5 (supporters) + 2 (tips) = 12
        vm.prank(bob);
        jar.tipBNB{value: MIN_NATIVE}("alice", "a");
        vm.prank(carol);
        jar.tipBNB{value: MIN_NATIVE}("alice", "b");
        // alice tips bob: +3 (agentIdsTipped)
        vm.prank(alice);
        jar.tipToken("bob", address(usdt), MIN_USD, "back");
        // alice creates poll & 3 unique agents vote (bob, carol, alice): +2 (qualifiedPoll) + 1 (vote) + 2 (streak)
        vm.prank(alice);
        uint256 pollId = jar.createPoll("q", _pair(), 6 hours);
        vm.prank(bob);
        jar.vote(pollId, 0);
        vm.prank(carol);
        jar.vote(pollId, 0);
        vm.prank(alice);
        jar.vote(pollId, 0);
        // alice & bob complete 1 bounty: +10 each
        uint64 deadline = uint64(block.timestamp + 2 hours);
        vm.prank(alice);
        uint256 bountyId = jar.createBounty{value: MIN_NATIVE}("bob", address(0), MIN_NATIVE, deadline, keccak256("s"));
        vm.prank(bob);
        jar.submitBountyWork(bountyId, keccak256("d"));
        vm.prank(alice);
        jar.approveBounty(bountyId);

        // supporters 10 + tipped 3 + tips 2 + votes 1 + streak 2 + qualifiedPoll 2 + bounty 10 = 30
        assertEq(jar.getScore(alice), 30);
        (uint8 tierId, string memory tierName) = jar.getTier(jar.getScore(alice));
        assertEq(tierId, 2);
        assertEq(tierName, "Bronze");
    }

    function test_score_capsVerifiedTipsAt100() public {
        for (uint256 i; i < 101; ++i) {
            vm.prank(bob);
            jar.tipBNB{value: MIN_NATIVE}("alice", "g");
        }
        (uint32 tips, uint32 supporters,,) = jar.recipientStats(alice);
        assertEq(tips, 101);
        assertEq(supporters, 1);
        assertEq(jar.getScore(alice), 5 + 100);
    }

    function test_getTier_boundariesAndProgressionThroughLegend() public {
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

        for (uint256 i; i < 80; ++i) {
            address supporter = address(uint160(0xA000 + i));
            _register(supporter, string.concat("s", vm.toString(i)));
            vm.deal(supporter, 1 ether);
            vm.prank(supporter);
            jar.tipBNB{value: MIN_NATIVE}("alice", "g");
        }
        assertEq(jar.getScore(alice), 480);
        (uint8 tierId,) = jar.getTier(jar.getScore(alice));
        assertEq(tierId, 5);
    }

    function test_badge_claimSoulboundAndDynamicPassportWithBounties() public {
        vm.prank(tipper);
        vm.expectRevert(AgentJar.NotHolder.selector);
        jar.claimBadge();

        vm.prank(alice);
        vm.expectRevert(AgentJar.ScoreTooLow.selector);
        jar.claimBadge();

        vm.prank(bob);
        jar.tipBNB{value: MIN_NATIVE}("alice", "gm");
        assertEq(jar.getScore(alice), 6);

        vm.prank(alice);
        uint256 tokenId = jar.claimBadge();
        assertEq(tokenId, jar.tokenIdOf(alice));
        assertEq(jar.ownerOf(tokenId), alice);
        assertEq(jar.name(), "AgentJar Badge");
        assertEq(jar.symbol(), "AJB");

        vm.startPrank(alice);
        vm.expectRevert(AgentJar.BadgeAlreadyClaimed.selector);
        jar.claimBadge();
        vm.expectRevert(AgentJar.NonTransferable.selector);
        jar.transferFrom(alice, bob, tokenId);
        vm.expectRevert(AgentJar.NonTransferable.selector);
        jar.safeTransferFrom(alice, bob, tokenId);
        vm.expectRevert(AgentJar.NonTransferable.selector);
        jar.approve(bob, tokenId);
        vm.expectRevert(AgentJar.NonTransferable.selector);
        jar.setApprovalForAll(bob, true);
        vm.stopPrank();

        string memory before = _metadata(tokenId);
        string memory beforeSvg = _svg(before);
        assertTrue(_has(before, '"trait_type":"Handle","value":"alice"'));
        assertTrue(_has(before, '"trait_type":"Score","value":6'));
        assertTrue(_has(before, '"trait_type":"Tier","value":"Spark"'));
        assertTrue(_has(before, '"trait_type":"Bounties Completed","value":0'));
        assertTrue(_has(beforeSvg, "AGENTJAR PASSPORT"));
        assertTrue(_has(beforeSvg, "@alice"));
        assertTrue(_has(beforeSvg, "#0B0E11"));
        assertTrue(_has(beforeSvg, "#161A1E"));
        assertTrue(_has(beforeSvg, "#F0B90B"));
        assertFalse(_has(before, "Binance"));

        // Complete a bounty -> score jumps from 6 to 16 (Bronze) & Bounties Completed updates live!
        uint64 deadline = uint64(block.timestamp + 2 hours);
        vm.prank(alice);
        uint256 bId = jar.createBounty{value: MIN_NATIVE}("bob", address(0), MIN_NATIVE, deadline, keccak256("s"));
        vm.prank(bob);
        jar.submitBountyWork(bId, keccak256("d"));
        vm.prank(alice);
        jar.approveBounty(bId);

        string memory updated = _metadata(tokenId);
        string memory updatedSvg = _svg(updated);
        assertTrue(_has(updated, '"trait_type":"Score","value":16'));
        assertTrue(_has(updated, '"trait_type":"Tier","value":"Bronze"'));
        assertTrue(_has(updated, '"trait_type":"Bounties Completed","value":1'));
        assertTrue(_has(updatedSvg, "Bronze"));
        assertTrue(_has(updatedSvg, "BOUNTIES"));
        assertTrue(_has(updatedSvg, ">1<"));
    }

    function test_tokenURI_escapesJsonAndXmlSpecialCharacters() public {
        SpecialCharRegistry specialReg = new SpecialCharRegistry();
        AgentJar specialJar = new AgentJar(specialReg, usdt, usdc);

        address attacker = makeAddr("xssAgent");
        address helper = makeAddr("helperAgent");
        string memory maliciousHandle = 'a"b\\c<script>&\'';
        specialReg.setHandle(attacker, maliciousHandle);
        specialReg.setHandle(helper, "helper");

        vm.deal(helper, 1 ether);
        vm.prank(helper);
        specialJar.tipBNB{value: MIN_NATIVE}(maliciousHandle, "tip");

        vm.prank(attacker);
        uint256 tokenId = specialJar.claimBadge();

        bytes memory uri = bytes(specialJar.tokenURI(tokenId));
        bytes memory prefix = bytes("data:application/json;base64,");
        bytes memory encoded = new bytes(uri.length - prefix.length);
        for (uint256 i; i < encoded.length; ++i) {
            encoded[i] = uri[prefix.length + i];
        }
        string memory json = string(Base64.decode(string(encoded)));
        string memory svg = _svg(json);

        // JSON has escaped quotes and backslashes
        assertTrue(_has(json, '"trait_type":"Handle","value":"a\\"b\\\\c<script>&\'"'));
        // SVG has XML-escaped entities and zero raw <script> injection
        assertFalse(_has(svg, "<script>"));
        assertTrue(_has(svg, "@a&quot;b\\c&lt;script&gt;&amp;&#39;"));
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    function _register(address account, string memory handle) internal {
        vm.prank(account);
        registry.register(handle);
    }

    function _pair() internal pure returns (string[] memory options) {
        options = new string[](2);
        options[0] = "yes";
        options[1] = "no";
    }

    function _repeat(bytes1 ch, uint256 len) internal pure returns (string memory) {
        bytes memory out = new bytes(len);
        for (uint256 i; i < len; ++i) {
            out[i] = ch;
        }
        return string(out);
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
        string memory encoded = _between(json, "data:image/svg+xml;base64,", '"}');
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

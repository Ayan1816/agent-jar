// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {AgentJar} from "../src/AgentJar.sol";
import {MockRegistry} from "./mocks/MockRegistry.sol";

contract BountyTestERC20 is ERC20 {
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Contract Agent ID holder that can toggle rejecting BNB to test pull-payment fallback.
contract ToggleBNBReceiver {
    bool public acceptBNB;

    constructor(bool acceptInitially) {
        acceptBNB = acceptInitially;
    }

    function setAcceptBNB(bool accept_) external {
        acceptBNB = accept_;
    }

    function register(MockRegistry reg, string calldata handle) external {
        reg.register(handle);
    }

    function createBounty(
        AgentJar jar,
        string calldata workerHandle,
        address token,
        uint256 amount,
        uint64 deadline,
        bytes32 specHash
    ) external returns (uint256) {
        return jar.createBounty{value: token == address(0) ? amount : 0}(
            workerHandle, token, amount, deadline, specHash
        );
    }

    function submitWork(AgentJar jar, uint256 bountyId, bytes32 deliverableHash) external {
        jar.submitBountyWork(bountyId, deliverableHash);
    }

    function reclaim(AgentJar jar, uint256 bountyId) external {
        jar.reclaimExpiredBounty(bountyId);
    }

    function claimPending(AgentJar jar) external {
        jar.claimPendingBNB();
    }

    receive() external payable {
        require(acceptBNB, "REJECT_BNB");
    }
}

contract AgentJarBountyTest is Test {
    MockRegistry internal registry;
    BountyTestERC20 internal usdt;
    BountyTestERC20 internal usdc;
    AgentJar internal jar;

    uint256 internal constant MIN_NATIVE = 0.0001 ether;
    uint256 internal constant MIN_USD = 0.1 ether;
    bytes32 internal constant SPEC = keccak256("ipfs://spec-v1");
    bytes32 internal constant DELIVERABLE = keccak256("ipfs://deliverable-v1");

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal dave = makeAddr("dave");
    address internal erin = makeAddr("erin");
    address internal freshHolder = makeAddr("freshHolder");
    address internal outsider = makeAddr("outsider");

    function setUp() public {
        registry = new MockRegistry();
        usdt = new BountyTestERC20("Tether USD", "USDT");
        usdc = new BountyTestERC20("USD Coin", "USDC");
        jar = new AgentJar(registry, usdt, usdc);

        _register(alice, "alice");
        _register(bob, "bob");
        _register(carol, "carol");
        _register(dave, "dave");
        _register(erin, "erin");
        _register(freshHolder, "fresh");

        address[6] memory funded = [alice, bob, carol, dave, erin, outsider];
        for (uint256 i; i < funded.length; ++i) {
            vm.deal(funded[i], 20 ether);
            usdt.mint(funded[i], 5_000 ether);
            usdc.mint(funded[i], 5_000 ether);
            vm.startPrank(funded[i]);
            usdt.approve(address(jar), type(uint256).max);
            usdc.approve(address(jar), type(uint256).max);
            vm.stopPrank();
        }

        // Give carol, dave, and erin non-zero reputation score so they qualify as independent jurors.
        vm.prank(carol);
        jar.tipBNB{value: MIN_NATIVE}("dave", "rep");
        vm.prank(erin);
        jar.tipBNB{value: MIN_NATIVE}("carol", "rep");
        assertGt(jar.getScore(carol), 0);
        assertGt(jar.getScore(dave), 0);
        assertGt(jar.getScore(erin), 0);
        assertEq(jar.getScore(freshHolder), 0);
    }

    function test_createBounty_bnbHappyPathAndApproval() public {
        uint256 amount = 0.5 ether;
        uint64 deadline = uint64(block.timestamp + 2 hours);
        uint256 bobBefore = bob.balance;
        uint256 aliceBefore = alice.balance;

        vm.prank(alice);
        uint256 bountyId = jar.createBounty{value: amount}("Bob.AI", address(0), amount, deadline, SPEC);

        assertEq(bountyId, 0);
        assertEq(jar.bountyCount(), 1);
        assertEq(address(jar).balance, amount);
        assertEq(alice.balance, aliceBefore - amount);
        assertTrue(jar.isActiveAgent(alice));

        AgentJar.Bounty memory b = jar.getBounty(bountyId);
        assertEq(b.creator, alice);
        assertEq(b.worker, bob);
        assertEq(b.token, address(0));
        assertEq(b.amount, amount);
        assertEq(b.deadline, deadline);
        assertEq(b.specHash, SPEC);
        assertEq(uint8(b.status), uint8(AgentJar.BountyStatus.Open));

        vm.prank(bob);
        jar.submitBountyWork(bountyId, DELIVERABLE);
        assertTrue(jar.isActiveAgent(bob));
        b = jar.getBounty(bountyId);
        assertEq(b.deliverableHash, DELIVERABLE);
        assertEq(b.submittedAt, uint64(block.timestamp));
        assertEq(uint8(b.status), uint8(AgentJar.BountyStatus.Submitted));

        vm.prank(alice);
        jar.approveBounty(bountyId);

        assertEq(bob.balance, bobBefore + amount);
        assertEq(address(jar).balance, 0);
        assertEq(jar.bountiesCompleted(alice), 1);
        assertEq(jar.bountiesCompleted(bob), 1);
        assertEq(jar.getScore(alice), 10);
        assertEq(jar.getScore(bob), 10);
        assertTrue(jar.isSupporter(alice, bob));
        assertTrue(jar.isSupporter(bob, alice));
        assertEq(uint8(jar.getBounty(bountyId).status), uint8(AgentJar.BountyStatus.Completed));
    }

    function test_createBounty_usdtAndUsdcHappyPath() public {
        uint64 deadline = uint64(vm.getBlockTimestamp() + 1 hours);

        // USDT bounty
        uint256 usdtAmount = 25 ether;
        uint256 bobUsdtBefore = usdt.balanceOf(bob);
        vm.prank(alice);
        uint256 id0 = jar.createBounty("bob", address(usdt), usdtAmount, deadline, SPEC);
        assertEq(usdt.balanceOf(address(jar)), usdtAmount);

        vm.warp(deadline); // Exact deadline is still valid for submission
        vm.prank(bob);
        jar.submitBountyWork(id0, DELIVERABLE);

        vm.prank(alice);
        jar.approveBounty(id0);
        assertEq(usdt.balanceOf(bob), bobUsdtBefore + usdtAmount);
        assertEq(usdt.balanceOf(address(jar)), 0);

        // USDC bounty with max 14-day duration
        uint256 usdcAmount = 50 ether;
        uint64 maxDeadline = uint64(vm.getBlockTimestamp() + 14 days);
        uint256 bobUsdcBefore = usdc.balanceOf(bob);
        vm.prank(alice);
        uint256 id1 = jar.createBounty("BOB", address(usdc), usdcAmount, maxDeadline, SPEC);
        assertEq(usdc.balanceOf(address(jar)), usdcAmount);

        vm.prank(bob);
        jar.submitBountyWork(id1, DELIVERABLE);
        vm.prank(alice);
        jar.approveBounty(id1);

        assertEq(usdc.balanceOf(bob), bobUsdcBefore + usdcAmount);
        assertEq(usdc.balanceOf(address(jar)), 0);
        assertEq(jar.bountiesCompleted(alice), 2);
        assertEq(jar.bountiesCompleted(bob), 2);
    }

    function test_createBounty_revertsOnInvalidArgs() public {
        uint64 okDeadline = uint64(block.timestamp + 2 hours);

        // Non-holder creator
        vm.prank(outsider);
        vm.expectRevert(AgentJar.NotHolder.selector);
        jar.createBounty{value: MIN_NATIVE}("bob", address(0), MIN_NATIVE, okDeadline, SPEC);

        vm.startPrank(alice);
        // Unknown worker
        vm.expectRevert(AgentJar.UnknownHandle.selector);
        jar.createBounty{value: MIN_NATIVE}("nobody", address(0), MIN_NATIVE, okDeadline, SPEC);

        // Self bounty
        vm.expectRevert(AgentJar.SelfBounty.selector);
        jar.createBounty{value: MIN_NATIVE}("alice.ai", address(0), MIN_NATIVE, okDeadline, SPEC);

        // Zero spec hash
        vm.expectRevert(AgentJar.InvalidSpecHash.selector);
        jar.createBounty{value: MIN_NATIVE}("bob", address(0), MIN_NATIVE, okDeadline, bytes32(0));

        // Deadline too soon / too far
        vm.expectRevert(AgentJar.InvalidDeadline.selector);
        jar.createBounty{value: MIN_NATIVE}("bob", address(0), MIN_NATIVE, uint64(block.timestamp + 1 hours - 1), SPEC);
        vm.expectRevert(AgentJar.InvalidDeadline.selector);
        jar.createBounty{value: MIN_NATIVE}("bob", address(0), MIN_NATIVE, uint64(block.timestamp + 14 days + 1), SPEC);

        // Native amount too small & msg.value mismatch
        vm.expectRevert(AgentJar.BountyAmountTooSmall.selector);
        jar.createBounty{value: MIN_NATIVE - 1}("bob", address(0), MIN_NATIVE - 1, okDeadline, SPEC);
        vm.expectRevert(AgentJar.InvalidMsgValue.selector);
        jar.createBounty{value: MIN_NATIVE + 1}("bob", address(0), MIN_NATIVE, okDeadline, SPEC);

        // ERC-20 amount too small, non-zero msg.value, unsupported token
        vm.expectRevert(AgentJar.BountyAmountTooSmall.selector);
        jar.createBounty("bob", address(usdt), MIN_USD - 1, okDeadline, SPEC);
        vm.expectRevert(AgentJar.InvalidMsgValue.selector);
        jar.createBounty{value: 1}("bob", address(usdt), MIN_USD, okDeadline, SPEC);
        vm.expectRevert(AgentJar.UnsupportedToken.selector);
        jar.createBounty("bob", makeAddr("randomToken"), MIN_USD, okDeadline, SPEC);
        vm.stopPrank();
    }

    function test_submitAndApprove_revertsOnBadAccessAndStatus() public {
        uint64 deadline = uint64(vm.getBlockTimestamp() + 2 hours);
        vm.prank(alice);
        uint256 id = jar.createBounty{value: 1 ether}("bob", address(0), 1 ether, deadline, SPEC);

        vm.prank(alice);
        vm.expectRevert(AgentJar.BountyNotFound.selector);
        jar.approveBounty(99);

        vm.prank(alice);
        vm.expectRevert(AgentJar.InvalidBountyStatus.selector);
        jar.approveBounty(id);

        vm.prank(alice);
        vm.expectRevert(AgentJar.NotBountyWorker.selector);
        jar.submitBountyWork(id, DELIVERABLE);

        vm.prank(bob);
        vm.expectRevert(AgentJar.InvalidDeliverableHash.selector);
        jar.submitBountyWork(id, bytes32(0));

        // Submit after deadline fails
        vm.warp(deadline + 1);
        vm.prank(bob);
        vm.expectRevert(AgentJar.BountyExpired.selector);
        jar.submitBountyWork(id, DELIVERABLE);

        // Fresh bounty: submit then test double submit and unauthorized approve
        uint64 deadline2 = uint64(vm.getBlockTimestamp() + 2 hours);
        vm.prank(alice);
        uint256 id2 = jar.createBounty{value: 1 ether}("bob", address(0), 1 ether, deadline2, SPEC);
        vm.prank(bob);
        jar.submitBountyWork(id2, DELIVERABLE);

        vm.prank(bob);
        vm.expectRevert(AgentJar.InvalidBountyStatus.selector);
        jar.submitBountyWork(id2, DELIVERABLE);

        vm.prank(bob);
        vm.expectRevert(AgentJar.NotBountyCreator.selector);
        jar.approveBounty(id2);

        vm.prank(alice);
        jar.approveBounty(id2);
        vm.prank(alice);
        vm.expectRevert(AgentJar.InvalidBountyStatus.selector);
        jar.approveBounty(id2);
    }

    function test_reclaimExpiredBounty_refundsBnbAndUsdt() public {
        uint64 deadline = uint64(vm.getBlockTimestamp() + 2 hours);
        uint256 aliceBnbBefore = alice.balance;
        uint256 aliceUsdtBefore = usdt.balanceOf(alice);

        vm.startPrank(alice);
        uint256 idBnb = jar.createBounty{value: 1 ether}("bob", address(0), 1 ether, deadline, SPEC);
        uint256 idUsdt = jar.createBounty("bob", address(usdt), 10 ether, deadline, SPEC);

        // Cannot reclaim before or at deadline
        vm.warp(deadline);
        vm.expectRevert(AgentJar.BountyNotExpired.selector);
        jar.reclaimExpiredBounty(idBnb);
        vm.stopPrank();

        // Non-creator cannot reclaim
        vm.warp(deadline + 1);
        vm.prank(bob);
        vm.expectRevert(AgentJar.NotBountyCreator.selector);
        jar.reclaimExpiredBounty(idBnb);

        // Creator reclaims both
        vm.startPrank(alice);
        jar.reclaimExpiredBounty(idBnb);
        jar.reclaimExpiredBounty(idUsdt);
        vm.expectRevert(AgentJar.InvalidBountyStatus.selector);
        jar.reclaimExpiredBounty(idBnb);
        vm.stopPrank();

        assertEq(alice.balance, aliceBnbBefore);
        assertEq(usdt.balanceOf(alice), aliceUsdtBefore);
        assertEq(address(jar).balance, 0);
        assertEq(usdt.balanceOf(address(jar)), 0);
        assertEq(jar.bountiesCompleted(alice), 0);
        assertEq(uint8(jar.getBounty(idBnb).status), uint8(AgentJar.BountyStatus.Refunded));
    }

    function test_reclaimExpiredBounty_revertsIfWorkSubmitted() public {
        uint64 deadline = uint64(block.timestamp + 2 hours);
        vm.prank(alice);
        uint256 id = jar.createBounty{value: 1 ether}("bob", address(0), 1 ether, deadline, SPEC);
        vm.prank(bob);
        jar.submitBountyWork(id, DELIVERABLE);

        vm.warp(deadline + 1 days);
        vm.prank(alice);
        vm.expectRevert(AgentJar.InvalidBountyStatus.selector);
        jar.reclaimExpiredBounty(id);
    }

    function test_openDispute_creatorImmediateAndWorkerAfter24Hours() public {
        uint64 deadline = uint64(vm.getBlockTimestamp() + 2 hours);
        vm.prank(alice);
        uint256 id1 = jar.createBounty{value: 1 ether}("bob", address(0), 1 ether, deadline, SPEC);

        // Cannot open dispute while still Open
        vm.prank(alice);
        vm.expectRevert(AgentJar.InvalidBountyStatus.selector);
        jar.openDispute(id1);

        vm.prank(bob);
        jar.submitBountyWork(id1, DELIVERABLE);
        uint256 submittedAt = vm.getBlockTimestamp();

        // Third party cannot open dispute
        vm.prank(carol);
        vm.expectRevert(AgentJar.NotBountyParty.selector);
        jar.openDispute(id1);

        // Worker must wait 24 hours after submission
        vm.warp(submittedAt + 24 hours - 1);
        vm.prank(bob);
        vm.expectRevert(AgentJar.DisputeTooEarly.selector);
        jar.openDispute(id1);

        // At 24 hours, worker succeeds
        vm.warp(submittedAt + 24 hours);
        vm.prank(bob);
        jar.openDispute(id1);

        AgentJar.Bounty memory b = jar.getBounty(id1);
        assertEq(uint8(b.status), uint8(AgentJar.BountyStatus.Disputed));
        assertEq(b.disputeDeadline, uint64(vm.getBlockTimestamp() + 48 hours));

        // Second bounty: creator can open dispute immediately after submission
        uint64 deadline2 = uint64(vm.getBlockTimestamp() + 2 hours);
        vm.prank(alice);
        uint256 id2 = jar.createBounty{value: 1 ether}("bob", address(0), 1 ether, deadline2, SPEC);
        vm.prank(bob);
        jar.submitBountyWork(id2, DELIVERABLE);
        vm.prank(alice);
        jar.openDispute(id2);
        assertEq(uint8(jar.getBounty(id2).status), uint8(AgentJar.BountyStatus.Disputed));
    }

    function test_voteDispute_jurorGuardsAnd2Of3WorkerWin() public {
        uint256 id = _createSubmittedDisputedBounty(address(0), 2 ether, true);
        uint256 bobBefore = bob.balance;

        // Non-holder cannot vote
        vm.prank(outsider);
        vm.expectRevert(AgentJar.NotHolder.selector);
        jar.voteDispute(id, true);

        // Creator and worker are not independent
        vm.prank(alice);
        vm.expectRevert(AgentJar.JurorNotIndependent.selector);
        jar.voteDispute(id, false);
        vm.prank(bob);
        vm.expectRevert(AgentJar.JurorNotIndependent.selector);
        jar.voteDispute(id, true);

        // Fresh Agent ID with score 0 cannot vote (Sybil-free)
        vm.prank(freshHolder);
        vm.expectRevert(AgentJar.ScoreTooLow.selector);
        jar.voteDispute(id, true);

        // Vote 1: carol votes for worker (1-0)
        vm.prank(carol);
        jar.voteDispute(id, true);
        assertTrue(jar.hasVotedDispute(id, carol));
        assertEq(uint8(jar.getBounty(id).status), uint8(AgentJar.BountyStatus.Disputed));

        // Double vote blocked
        vm.prank(carol);
        vm.expectRevert(AgentJar.AlreadyVoted.selector);
        jar.voteDispute(id, true);

        // Vote 2: dave votes for creator (1-1)
        vm.prank(dave);
        jar.voteDispute(id, false);
        assertEq(uint8(jar.getBounty(id).status), uint8(AgentJar.BountyStatus.Disputed));

        // Vote 3: erin votes for worker (2-1) -> immediate finalization!
        vm.prank(erin);
        jar.voteDispute(id, true);

        assertEq(uint8(jar.getBounty(id).status), uint8(AgentJar.BountyStatus.Completed));
        assertEq(bob.balance, bobBefore + 2 ether);
        assertEq(address(jar).balance, 0);
        assertEq(jar.bountiesCompleted(bob), 1);
        assertEq(jar.bountiesCompleted(alice), 0);
        assertTrue(jar.isSupporter(alice, bob));
    }

    function test_voteDispute_2Of3CreatorRefundOnUsdc() public {
        uint256 amount = 100 ether;
        uint256 aliceBefore = usdc.balanceOf(alice);
        uint256 id = _createSubmittedDisputedBounty(address(usdc), amount, true);

        vm.prank(carol);
        jar.voteDispute(id, false);
        vm.prank(dave);
        jar.voteDispute(id, false);

        // Finalized immediately after 2 creator votes
        assertEq(uint8(jar.getBounty(id).status), uint8(AgentJar.BountyStatus.Refunded));
        assertEq(usdc.balanceOf(alice), aliceBefore);
        assertEq(usdc.balanceOf(address(jar)), 0);
        assertEq(jar.bountiesCompleted(alice), 0);
        assertEq(jar.bountiesCompleted(bob), 0);

        // Third juror cannot vote on already-resolved dispute
        vm.prank(erin);
        vm.expectRevert(AgentJar.InvalidBountyStatus.selector);
        jar.voteDispute(id, true);
    }

    function test_resolveExpiredDispute_pluralityAnd5050TieFallback() public {
        // Case A: 0-0 tie on ODD native wei amount -> 50/50 split with zero dust
        uint256 oddAmount = 1 ether + 1;
        uint256 idTie = _createSubmittedDisputedBounty(address(0), oddAmount, true);
        uint64 dDeadline = jar.getBounty(idTie).disputeDeadline;

        // Reverts while active
        vm.expectRevert(AgentJar.DisputeActive.selector);
        jar.resolveExpiredDispute(idTie);

        // Warp past 48h window: voting now reverts DisputeExpired
        vm.warp(dDeadline);
        vm.prank(carol);
        vm.expectRevert(AgentJar.DisputeExpired.selector);
        jar.voteDispute(idTie, true);

        uint256 aliceBefore = alice.balance;
        uint256 bobBefore = bob.balance;
        // Permissionless resolution by outsider
        vm.prank(outsider);
        jar.resolveExpiredDispute(idTie);

        assertEq(uint8(jar.getBounty(idTie).status), uint8(AgentJar.BountyStatus.Split));
        assertEq(bob.balance, bobBefore + (oddAmount / 2));
        assertEq(alice.balance, aliceBefore + (oddAmount - (oddAmount / 2)));
        assertEq(address(jar).balance, 0);

        // Case B: 1-1 tie on USDT -> 50/50 split
        uint256 idTie11 = _createSubmittedDisputedBounty(address(usdt), 10 ether, true);
        vm.prank(carol);
        jar.voteDispute(idTie11, true);
        vm.prank(dave);
        jar.voteDispute(idTie11, false);
        vm.warp(jar.getBounty(idTie11).disputeDeadline);
        uint256 aliceUsdtBefore = usdt.balanceOf(alice);
        uint256 bobUsdtBefore = usdt.balanceOf(bob);
        jar.resolveExpiredDispute(idTie11);
        assertEq(uint8(jar.getBounty(idTie11).status), uint8(AgentJar.BountyStatus.Split));
        assertEq(bobUsdtBefore + 5 ether, usdt.balanceOf(bob));
        assertEq(aliceUsdtBefore + 5 ether, usdt.balanceOf(alice));
        assertEq(usdt.balanceOf(address(jar)), 0);

        // Case C: 1-0 plurality for worker after 48h -> 100% to worker
        uint256 idWorkerLead = _createSubmittedDisputedBounty(address(0), 1 ether, true);
        vm.prank(carol);
        jar.voteDispute(idWorkerLead, true);
        vm.warp(jar.getBounty(idWorkerLead).disputeDeadline);
        bobBefore = bob.balance;
        jar.resolveExpiredDispute(idWorkerLead);
        assertEq(uint8(jar.getBounty(idWorkerLead).status), uint8(AgentJar.BountyStatus.Completed));
        assertEq(bob.balance, bobBefore + 1 ether);
        assertEq(jar.bountiesCompleted(bob), 1);

        // Case D: 0-1 plurality for creator after 48h -> 100% refund to creator
        uint256 idCreatorLead = _createSubmittedDisputedBounty(address(0), 1 ether, true);
        vm.prank(carol);
        jar.voteDispute(idCreatorLead, false);
        vm.warp(jar.getBounty(idCreatorLead).disputeDeadline);
        aliceBefore = alice.balance;
        jar.resolveExpiredDispute(idCreatorLead);
        assertEq(uint8(jar.getBounty(idCreatorLead).status), uint8(AgentJar.BountyStatus.Refunded));
        assertEq(alice.balance, aliceBefore + 1 ether);
    }

    function test_bountyPayout_revertingContractFallsBackToPendingWithdrawals() public {
        ToggleBNBReceiver smartWorker = new ToggleBNBReceiver(false);
        smartWorker.register(registry, "smartworker");

        uint64 deadline = uint64(block.timestamp + 2 hours);
        vm.prank(alice);
        uint256 id = jar.createBounty{value: 1 ether}("smartworker", address(0), 1 ether, deadline, SPEC);

        smartWorker.submitWork(jar, id, DELIVERABLE);

        // Approval succeeds even though worker contract rejects BNB
        vm.prank(alice);
        jar.approveBounty(id);
        assertEq(jar.pendingWithdrawals(address(smartWorker)), 1 ether);
        assertEq(address(smartWorker).balance, 0);
        assertEq(address(jar).balance, 1 ether);

        // Worker enables BNB reception and pulls funds
        smartWorker.setAcceptBNB(true);
        smartWorker.claimPending(jar);
        assertEq(address(smartWorker).balance, 1 ether);
        assertEq(jar.pendingWithdrawals(address(smartWorker)), 0);
        assertEq(address(jar).balance, 0);

        // Also verify reverting creator during reclaim falls back safely
        ToggleBNBReceiver smartCreator = new ToggleBNBReceiver(false);
        smartCreator.register(registry, "smartcreator");
        vm.deal(address(smartCreator), 2 ether);

        uint64 d2 = uint64(vm.getBlockTimestamp() + 1 hours);
        uint256 id2 = smartCreator.createBounty(jar, "bob", address(0), 1 ether, d2, SPEC);
        assertEq(address(smartCreator).balance, 1 ether);
        vm.warp(d2 + 1);
        smartCreator.reclaim(jar, id2);
        assertEq(jar.pendingWithdrawals(address(smartCreator)), 1 ether);
        smartCreator.setAcceptBNB(true);
        smartCreator.claimPending(jar);
        assertEq(address(smartCreator).balance, 2 ether);
        assertEq(address(jar).balance, 0);

        // Verify reverting worker during dispute 50/50 split does NOT block creator payout
        smartWorker.setAcceptBNB(false);
        uint64 d3 = uint64(vm.getBlockTimestamp() + 2 hours);
        vm.prank(alice);
        uint256 id3 = jar.createBounty{value: 1 ether}("smartworker", address(0), 1 ether, d3, SPEC);
        smartWorker.submitWork(jar, id3, DELIVERABLE);
        vm.prank(alice);
        jar.openDispute(id3);
        vm.warp(jar.getBounty(id3).disputeDeadline);

        uint256 aliceBefore = alice.balance;
        jar.resolveExpiredDispute(id3);
        assertEq(alice.balance, aliceBefore + 0.5 ether);
        assertEq(jar.pendingWithdrawals(address(smartWorker)), 0.5 ether);
        smartWorker.setAcceptBNB(true);
        smartWorker.claimPending(jar);
        assertEq(jar.pendingWithdrawals(address(smartWorker)), 0);
        assertEq(address(jar).balance, 0);
    }

    function _createSubmittedDisputedBounty(address token, uint256 amount, bool creatorOpens)
        internal
        returns (uint256 id)
    {
        uint64 deadline = uint64(vm.getBlockTimestamp() + 2 hours);
        vm.prank(alice);
        if (token == address(0)) {
            id = jar.createBounty{value: amount}("bob", address(0), amount, deadline, SPEC);
        } else {
            id = jar.createBounty("bob", token, amount, deadline, SPEC);
        }
        vm.prank(bob);
        jar.submitBountyWork(id, DELIVERABLE);
        if (creatorOpens) {
            vm.prank(alice);
            jar.openDispute(id);
        } else {
            vm.warp(vm.getBlockTimestamp() + 24 hours);
            vm.prank(bob);
            jar.openDispute(id);
        }
    }

    function _register(address account, string memory handle) internal {
        vm.prank(account);
        registry.register(handle);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AgentJar} from "../src/AgentJar.sol";
import {IAgentIdRegistry} from "../src/interfaces/IAgentIdRegistry.sol";

/// @notice Fork tests against the live Agent ID registry and stablecoins on BSC mainnet.
contract AgentJarForkTest is Test {
    IAgentIdRegistry internal constant REGISTRY = IAgentIdRegistry(0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F);
    IERC20 internal constant USDT = IERC20(0x55d398326f99059fF775485246999027B3197955);
    IERC20 internal constant USDC = IERC20(0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d);

    /// @dev Soulbound mainnet holders verified from the live BSC SPACE ID Agent ID registry.
    address internal constant ALICE = 0xA506ac7069937571DC56C5f8FDa53c4A729456c6;
    address internal constant BOB = 0x0d4c837A175F6fe604C690d747BE34396592f85f;
    address internal constant CAROL = 0x86Ae4bfe4Cbe0e2607a3d73CC8A2f479597DFB1a;
    address internal constant CHARLIE = 0xa30a5d457965862042731c0197e9Aedc18D5Cc3F;
    address internal constant DAVE = 0xf2142c0Dc89762b752Dd1BB749f5b6a4c5790f42;

    string internal constant PRIMARY_RPC = "https://bsc-dataseed.binance.org";
    string internal constant FALLBACK_RPC = "https://bsc-rpc.publicnode.com";

    AgentJar internal jar;
    address internal tipper;

    function setUp() public {
        _forkBsc();
        jar = new AgentJar(REGISTRY, USDT, USDC);
        tipper = makeAddr("tipper");
        vm.deal(tipper, 1 ether);
        vm.deal(ALICE, 2 ether);
        vm.deal(BOB, 2 ether);
        vm.deal(CAROL, 2 ether);
        vm.deal(CHARLIE, 2 ether);
        vm.deal(DAVE, 2 ether);
    }

    function test_fork_pinsMainnetAddressesAndChain() public view {
        assertEq(block.chainid, 56);
        assertEq(address(jar.registry()), address(REGISTRY));
        assertEq(address(jar.usdt()), address(USDT));
        assertEq(address(jar.usdc()), address(USDC));
    }

    function test_fork_registryResolvesCanonicalHandlesOnly() public view {
        assertEq(REGISTRY.balanceOf(ALICE), 1);
        assertEq(REGISTRY.handleOf(ALICE), "alice");
        assertEq(REGISTRY.ownerOfHandle("alice"), ALICE);

        assertEq(REGISTRY.balanceOf(BOB), 1);
        assertEq(REGISTRY.handleOf(BOB), "bob");
        assertEq(REGISTRY.ownerOfHandle("bob"), BOB);

        assertEq(REGISTRY.balanceOf(CAROL), 1);
        assertEq(REGISTRY.ownerOfHandle("carol"), CAROL);
        assertEq(REGISTRY.balanceOf(CHARLIE), 1);
        assertEq(REGISTRY.ownerOfHandle("charlie"), CHARLIE);
        assertEq(REGISTRY.balanceOf(DAVE), 1);
        assertEq(REGISTRY.ownerOfHandle("dave"), DAVE);

        assertEq(REGISTRY.ownerOfHandle("Alice"), address(0));
        assertEq(REGISTRY.ownerOfHandle("alice.ai"), address(0));
        assertEq(REGISTRY.balanceOf(tipper), 0);
        assertEq(REGISTRY.handleOf(tipper), "");
    }

    function test_fork_nonHolderCannotPollVoteClaimOrCreateBounty() public {
        uint256 minNative = jar.MIN_NATIVE_TIP();
        uint64 deadline = uint64(vm.getBlockTimestamp() + 2 hours);
        vm.prank(ALICE);
        uint256 pollId = jar.createPoll("Fork poll?", _pair(), 6 hours);

        vm.startPrank(tipper);
        vm.expectRevert(AgentJar.NotHolder.selector);
        jar.createPoll("no", _pair(), 6 hours);
        vm.expectRevert(AgentJar.NotHolder.selector);
        jar.vote(pollId, 0);
        vm.expectRevert(AgentJar.NotHolder.selector);
        jar.claimBadge();
        vm.expectRevert(AgentJar.NotHolder.selector);
        jar.createBounty{value: minNative}("alice", address(0), minNative, deadline, keccak256("s"));
        vm.stopPrank();

        assertEq(jar.pollCount(), 1);
        assertFalse(jar.hasVoted(pollId, tipper));
    }

    function test_fork_antiWashFarmingAndVerifiedTipsOnRealTokens() public {
        deal(address(USDT), tipper, 1_000 ether);
        deal(address(USDC), tipper, 1_000 ether);
        deal(address(USDT), BOB, 1_000 ether);

        uint256 nativeBefore = ALICE.balance;
        uint256 usdtBefore = USDT.balanceOf(ALICE);
        uint256 usdcBefore = USDC.balanceOf(ALICE);
        uint256 nativeTip = jar.MIN_NATIVE_TIP();
        uint256 usdTip = jar.MIN_USD_TIP();

        // Non-holder tips forward 100% with 0 custody, but do NOT inflate reputation or activeAgents.
        vm.startPrank(tipper);
        USDT.approve(address(jar), type(uint256).max);
        USDC.approve(address(jar), type(uint256).max);
        jar.tipBNB{value: nativeTip}("Alice.ai", "fork native");
        jar.tipToken("alice", address(USDT), usdTip, "fork usdt");
        jar.tipToken("ALICE", address(USDC), usdTip, "fork usdc");
        vm.stopPrank();

        assertEq(ALICE.balance, nativeBefore + nativeTip);
        assertEq(USDT.balanceOf(ALICE), usdtBefore + usdTip);
        assertEq(USDC.balanceOf(ALICE), usdcBefore + usdTip);
        assertEq(address(jar).balance, 0);
        assertEq(USDT.balanceOf(address(jar)), 0);
        assertEq(USDC.balanceOf(address(jar)), 0);

        (uint32 tips, uint32 supporters, uint96 nativeReceived, uint96 usdReceived) = jar.recipientStats(ALICE);
        assertEq(tips, 0);
        assertEq(supporters, 0);
        assertEq(nativeReceived, nativeTip);
        assertEq(usdReceived, usdTip * 2);
        assertEq(jar.getScore(ALICE), 0);
        assertEq(jar.activeAgentCount(), 0);

        // Verified holder BOB tips ALICE with real BSC USDT -> increments score & activeAgents.
        vm.startPrank(BOB);
        USDT.approve(address(jar), type(uint256).max);
        jar.tipToken("alice.ai", address(USDT), usdTip, "verified");
        vm.stopPrank();

        (tips, supporters,, usdReceived) = jar.recipientStats(ALICE);
        assertEq(tips, 1);
        assertEq(supporters, 1);
        assertEq(usdReceived, usdTip * 3);
        assertEq(jar.getScore(ALICE), 6);
        assertEq(jar.activeAgentCount(), 2);

        vm.prank(ALICE);
        vm.expectRevert(AgentJar.SelfTip.selector);
        jar.tipBNB{value: nativeTip}("alice.AI", "self");
    }

    function test_fork_pollQualificationSupporterGateAndDirectory() public {
        // Public poll awards creator score only once 3 unique Agent ID holders vote.
        vm.prank(ALICE);
        uint256 pollId = jar.createPoll("Ship v2 on BSC?", _pair(), 1 days, false);
        assertEq(jar.getScore(ALICE), 0);

        vm.prank(BOB);
        jar.vote(pollId, 0);
        vm.prank(CAROL);
        jar.vote(pollId, 0);
        assertEq(jar.getScore(ALICE), 0);

        vm.prank(DAVE);
        jar.vote(pollId, 1);
        assertEq(jar.qualifiedPolls(ALICE), 1);
        assertEq(jar.getScore(ALICE), 2);

        // Supporter-only poll blocks non-supporter DAVE, allows verified tipper BOB.
        uint256 minNative = jar.MIN_NATIVE_TIP();
        vm.prank(BOB);
        jar.tipBNB{value: minNative}("alice", "support");
        vm.prank(ALICE);
        uint256 gatedId = jar.createPoll("Supporters?", _pair(), 6 hours, true);

        vm.prank(DAVE);
        vm.expectRevert(AgentJar.NotSupporter.selector);
        jar.vote(gatedId, 0);

        vm.prank(BOB);
        jar.vote(gatedId, 0);
        assertTrue(jar.hasVoted(gatedId, BOB));

        // Active agent pagination returns all 4 verified mainnet holders.
        assertEq(jar.activeAgentCount(), 4);
        address[] memory page = jar.getActiveAgents(1, 2);
        assertEq(page.length, 2);
        assertEq(page[0], BOB);
        assertEq(page[1], CAROL);
    }

    function test_fork_a2aBountyUsdtAndDynamicPassport() public {
        deal(address(USDT), ALICE, 500 ether);
        uint256 bountyAmount = 10 ether;
        uint256 bobUsdtBefore = USDT.balanceOf(BOB);

        vm.startPrank(ALICE);
        USDT.approve(address(jar), bountyAmount);
        uint256 bountyId = jar.createBounty(
            "Bob.ai", address(USDT), bountyAmount, uint64(block.timestamp + 2 hours), keccak256("mainnet-spec")
        );
        vm.stopPrank();
        assertEq(USDT.balanceOf(address(jar)), bountyAmount);

        vm.prank(BOB);
        jar.submitBountyWork(bountyId, keccak256("mainnet-work"));

        vm.prank(ALICE);
        jar.approveBounty(bountyId);

        assertEq(USDT.balanceOf(BOB), bobUsdtBefore + bountyAmount);
        assertEq(USDT.balanceOf(address(jar)), 0);
        assertEq(jar.bountiesCompleted(ALICE), 1);
        assertEq(jar.bountiesCompleted(BOB), 1);
        assertEq(jar.getScore(ALICE), 10);

        vm.prank(ALICE);
        uint256 tokenId = jar.claimBadge();
        assertEq(jar.ownerOf(tokenId), ALICE);

        string memory metadata = _metadata(tokenId);
        string memory svg = _svg(metadata);
        assertTrue(_has(metadata, '"trait_type":"Handle","value":"alice"'));
        assertTrue(_has(metadata, '"trait_type":"Tier","value":"Bronze"'));
        assertTrue(_has(metadata, '"trait_type":"Bounties Completed","value":1'));
        assertTrue(_has(svg, "AGENTJAR PASSPORT"));
        assertTrue(_has(svg, "#0B0E11"));
        assertTrue(_has(svg, "#F0B90B"));

        vm.prank(ALICE);
        vm.expectRevert(AgentJar.NonTransferable.selector);
        jar.transferFrom(ALICE, BOB, tokenId);
    }

    function test_fork_a2aBountyThreeJurorDisputeOnRealUsdc() public {
        deal(address(USDC), ALICE, 500 ether);
        // Give 3 independent mainnet holders (CAROL, CHARLIE, DAVE) reputation score > 0.
        uint256 minNative = jar.MIN_NATIVE_TIP();
        vm.prank(CAROL);
        jar.tipBNB{value: minNative}("charlie", "rep");
        vm.prank(DAVE);
        jar.tipBNB{value: minNative}("carol", "rep");

        uint256 amount = 25 ether;
        uint256 bobUsdcBefore = USDC.balanceOf(BOB);

        vm.startPrank(ALICE);
        USDC.approve(address(jar), amount);
        uint256 bountyId =
            jar.createBounty("bob", address(USDC), amount, uint64(block.timestamp + 2 hours), keccak256("usdc-spec"));
        vm.stopPrank();

        vm.prank(BOB);
        jar.submitBountyWork(bountyId, keccak256("usdc-deliverable"));

        // Creator disputes submitted work -> 3 mainnet jurors resolve 2-1 for worker BOB.
        vm.prank(ALICE);
        jar.openDispute(bountyId);

        vm.prank(CAROL);
        jar.voteDispute(bountyId, true);
        vm.prank(CHARLIE);
        jar.voteDispute(bountyId, false);
        vm.prank(DAVE);
        jar.voteDispute(bountyId, true);

        assertEq(uint8(jar.getBounty(bountyId).status), uint8(AgentJar.BountyStatus.Completed));
        assertEq(USDC.balanceOf(BOB), bobUsdcBefore + amount);
        assertEq(USDC.balanceOf(address(jar)), 0);
        assertEq(jar.bountiesCompleted(BOB), 1);
        assertEq(jar.bountiesCompleted(ALICE), 0);
    }

    function _forkBsc() internal {
        try this.forkAt(PRIMARY_RPC) {}
        catch {
            this.forkAt(FALLBACK_RPC);
        }
    }

    /// @dev External so a failed primary RPC can be caught and the fallback used.
    function forkAt(string calldata url) external {
        vm.createSelectFork(url);
    }

    function _pair() internal pure returns (string[] memory options) {
        options = new string[](2);
        options[0] = "yes";
        options[1] = "no";
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
        uint256 from = _indexOf(h, s, 0) + s.length;
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

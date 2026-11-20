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

    /// @dev Soulbound mainnet holders read from the registry: handle `alice` and handle `bob`.
    address internal constant ALICE = 0xA506ac7069937571DC56C5f8FDa53c4A729456c6;
    address internal constant BOB = 0x0d4c837A175F6fe604C690d747BE34396592f85f;

    string internal constant PRIMARY_RPC = "https://bsc-dataseed.binance.org";
    string internal constant FALLBACK_RPC = "https://bsc-rpc.publicnode.com";

    AgentJar internal jar;
    address internal tipper;

    function setUp() public {
        _forkBsc();
        jar = new AgentJar(REGISTRY, USDT, USDC);
        tipper = makeAddr("tipper");
        vm.deal(tipper, 1 ether);
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

        assertEq(REGISTRY.ownerOfHandle("Alice"), address(0));
        assertEq(REGISTRY.ownerOfHandle("alice.ai"), address(0));
        assertEq(REGISTRY.balanceOf(tipper), 0);
        assertEq(REGISTRY.handleOf(tipper), "");
    }

    function test_fork_nonHolderCannotPollVoteOrClaim() public {
        vm.prank(ALICE);
        uint256 pollId = jar.createPoll("Fork poll?", _pair(), 1 hours);

        vm.startPrank(tipper);
        vm.expectRevert(AgentJar.NotHolder.selector);
        jar.createPoll("no", _pair(), 1 hours);
        vm.expectRevert(AgentJar.NotHolder.selector);
        jar.vote(pollId, 0);
        vm.expectRevert(AgentJar.NotHolder.selector);
        jar.claimBadge();
        vm.stopPrank();

        assertEq(jar.pollCount(), 1);
        assertFalse(jar.hasVoted(pollId, tipper));
    }

    function test_fork_holderPollVoteAndLiveBadge() public {
        vm.prank(ALICE);
        vm.expectRevert(AgentJar.ScoreTooLow.selector);
        jar.claimBadge();

        vm.startPrank(ALICE);
        uint256 pollId = jar.createPoll("Ship the jar?", _pair(), 1 hours);
        jar.vote(pollId, 0);
        vm.stopPrank();

        assertTrue(jar.hasVoted(pollId, ALICE));
        assertEq(jar.optionVotes(pollId, 0), 1);
        assertGe(jar.getScore(ALICE), 1);
        (uint8 tierId, string memory tierName) = jar.getTier(jar.getScore(ALICE));
        assertEq(tierId, 1);
        assertEq(tierName, "Spark");

        vm.prank(ALICE);
        uint256 tokenId = jar.claimBadge();
        assertEq(tokenId, jar.tokenIdOf(ALICE));
        assertEq(jar.ownerOf(tokenId), ALICE);
        assertEq(jar.balanceOf(ALICE), 1);

        string memory metadata = _metadata(tokenId);
        assertTrue(_has(metadata, '"trait_type":"Handle","value":"alice"'));
        assertTrue(_has(metadata, '"trait_type":"Tier","value":"Spark"'));
        assertTrue(_has(_svg(metadata), "#0B0E11"));
        assertTrue(_has(_svg(metadata), "#F0B90B"));

        vm.prank(ALICE);
        vm.expectRevert(AgentJar.NonTransferable.selector);
        jar.transferFrom(ALICE, BOB, tokenId);
        assertEq(jar.ownerOf(tokenId), ALICE);
    }

    function test_fork_tipsForwardOnRealTokensAndLeaveZeroCustody() public {
        deal(address(USDT), tipper, 1_000 ether);
        deal(address(USDC), tipper, 1_000 ether);

        uint256 nativeBefore = ALICE.balance;
        uint256 usdtBefore = USDT.balanceOf(ALICE);
        uint256 usdcBefore = USDC.balanceOf(ALICE);
        uint256 nativeTip = jar.MIN_NATIVE_TIP();
        uint256 usdTip = jar.MIN_USD_TIP();

        assertEq(REGISTRY.ownerOfHandle("Alice.ai"), address(0));

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
        assertEq(USDT.balanceOf(tipper), 1_000 ether - usdTip);
        assertEq(USDC.balanceOf(tipper), 1_000 ether - usdTip);

        (uint32 tips, uint32 supporters, uint96 nativeReceived, uint96 usdReceived) = jar.recipientStats(ALICE);
        assertEq(tips, 3);
        assertEq(supporters, 1);
        assertEq(nativeReceived, nativeTip);
        assertEq(usdReceived, usdTip * 2);

        vm.prank(ALICE);
        vm.expectRevert(AgentJar.SelfTip.selector);
        jar.tipBNB{value: nativeTip}("alice.AI", "self");
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

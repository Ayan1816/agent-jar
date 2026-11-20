// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IAgentIdRegistry
/// @notice Read interface for the Agent ID registry on BNB Smart Chain (chain ID 56).
/// @dev Mainnet deployment: 0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F.
///      Handles are the lowercase label only. The `.ai` suffix is not part of the
///      on-chain handle. `ownerOfHandle` does not normalize its input.
interface IAgentIdRegistry {
    /// @notice Forward resolution. Returns `address(0)` when `handle` is not registered.
    function ownerOfHandle(string calldata handle) external view returns (address);

    /// @notice Reverse resolution. Returns an empty string when `owner` has no handle.
    function handleOf(address owner) external view returns (string memory);

    /// @notice ERC-721 balance. A registered address holds exactly one soulbound handle.
    function balanceOf(address owner) external view returns (uint256);
}

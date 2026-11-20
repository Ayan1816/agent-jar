// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IAgentIdRegistry} from "../../src/interfaces/IAgentIdRegistry.sol";

/// @title MockRegistry
/// @notice Test double for the Agent ID registry.
/// @dev Handles must be non-empty and contain only `a-z` and `0-9`. That rejects
///      uppercase input and any `.ai` suffix (`alice.ai` is not a valid handle;
///      the label `alice` is). Each address can register one handle. The token is
///      soulbound: transfers and approvals revert. There is no owner and no admin.
contract MockRegistry is ERC721, IAgentIdRegistry {
    mapping(address owner => string handle) private _handleOf;
    mapping(bytes32 labelhash => address owner) private _ownerOfHandle;

    error InvalidHandle(string handle);
    error HandleTaken(string handle);
    error AlreadyRegistered(address owner);
    error NonTransferable();

    event Registered(bytes32 indexed labelhash, address indexed owner, string handle);

    constructor() ERC721("Mock Agent ID", "MAID") {}

    /// @notice Register `handle` to the caller. The token id is `uint256(keccak256(handle))`.
    function register(string calldata handle) external {
        if (!_isCanonicalHandle(handle)) revert InvalidHandle(handle);
        if (bytes(_handleOf[msg.sender]).length != 0) revert AlreadyRegistered(msg.sender);

        bytes32 labelhash = keccak256(bytes(handle));
        if (_ownerOfHandle[labelhash] != address(0)) revert HandleTaken(handle);

        _handleOf[msg.sender] = handle;
        _ownerOfHandle[labelhash] = msg.sender;
        _mint(msg.sender, uint256(labelhash));
        emit Registered(labelhash, msg.sender, handle);
    }

    /// @inheritdoc IAgentIdRegistry
    function ownerOfHandle(string calldata handle) external view returns (address) {
        return _ownerOfHandle[keccak256(bytes(handle))];
    }

    /// @inheritdoc IAgentIdRegistry
    function handleOf(address owner) external view returns (string memory) {
        return _handleOf[owner];
    }

    /// @inheritdoc IAgentIdRegistry
    function balanceOf(address owner) public view override(ERC721, IAgentIdRegistry) returns (uint256) {
        return super.balanceOf(owner);
    }

    /// @dev Mint is the only permitted `_update`. Existing tokens cannot move or burn.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        if (_ownerOf(tokenId) != address(0)) revert NonTransferable();
        return super._update(to, tokenId, auth);
    }

    function approve(address, uint256) public pure override {
        revert NonTransferable();
    }

    function setApprovalForAll(address, bool) public pure override {
        revert NonTransferable();
    }

    /// @dev Canonical handles are the lowercase label, with no `.ai` suffix and no other symbols.
    function _isCanonicalHandle(string calldata handle) internal pure returns (bool) {
        bytes calldata characters = bytes(handle);
        uint256 length = characters.length;
        if (length == 0) return false;

        for (uint256 i = 0; i < length; ++i) {
            bytes1 character = characters[i];
            bool isDigit = character >= 0x30 && character <= 0x39;
            bool isLower = character >= 0x61 && character <= 0x7a;
            if (!isDigit && !isLower) return false;
        }
        return true;
    }
}

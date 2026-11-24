// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";

/// @title AgentJarMetadata
/// @notice Pure on-chain JSON and SVG renderer with JSON/XML escaping for the Agent Reputation Passport.
library AgentJarMetadata {
    /// @notice Render the base64-encoded JSON metadata URI for a soulbound Agent Reputation Passport.
    /// @dev `handle` is raw from the registry and escaped separately for JSON and XML contexts.
    function tokenURI(
        string memory handle,
        string memory scoreText,
        string memory tierName,
        string memory bountiesText,
        string memory supportersText,
        string memory streakText
    ) internal pure returns (string memory) {
        string memory json = badgeJson(handle, scoreText, tierName, bountiesText, supportersText, streakText);
        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }

    function badgeJson(
        string memory handle,
        string memory scoreText,
        string memory tierName,
        string memory bountiesText,
        string memory supportersText,
        string memory streakText
    ) internal pure returns (string memory) {
        string memory image = Base64.encode(bytes(badgeSvg(handle, scoreText, tierName, bountiesText)));
        string memory safeHandle = escapeJson(handle);
        return string.concat(
            '{"name":"AgentJar Reputation Passport","description":"Soulbound Agent Reputation Passport. Score, tier, and completed bounties are read live from AgentJar.","attributes":[{"trait_type":"Handle","value":"',
            safeHandle,
            '"},{"trait_type":"Score","value":',
            scoreText,
            '},{"trait_type":"Tier","value":"',
            tierName,
            '"},{"trait_type":"Bounties Completed","value":',
            bountiesText,
            '},{"trait_type":"Verified Supporters","value":',
            supportersText,
            '},{"trait_type":"Best Streak","value":',
            streakText,
            '}],"image":"data:image/svg+xml;base64,',
            image,
            '"}'
        );
    }

    function badgeSvg(string memory handle, string memory scoreText, string memory tierName, string memory bountiesText)
        internal
        pure
        returns (string memory)
    {
        string memory safeHandle = escapeXml(handle);
        return string.concat(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 320">',
            '<rect width="320" height="320" rx="24" fill="#0B0E11"/>',
            '<rect x="16" y="16" width="288" height="288" rx="16" fill="#161A1E" stroke="#F0B90B" stroke-width="3"/>',
            '<text x="160" y="54" text-anchor="middle" fill="#F0B90B" font-family="monospace" font-size="13" letter-spacing="2">AGENTJAR PASSPORT</text>',
            '<line x1="40" y1="68" x2="280" y2="68" stroke="#F0B90B" stroke-opacity="0.3"/>',
            '<text x="160" y="114" text-anchor="middle" fill="#F0B90B" font-family="monospace" font-size="30">',
            tierName,
            '</text><text x="160" y="148" text-anchor="middle" fill="#EAECEF" font-family="monospace" font-size="16">@',
            safeHandle,
            '</text><line x1="160" y1="176" x2="160" y2="238" stroke="#F0B90B" stroke-opacity="0.3"/>',
            '<text x="96" y="210" text-anchor="middle" fill="#F0B90B" font-family="monospace" font-size="26">',
            scoreText,
            '</text><text x="96" y="232" text-anchor="middle" fill="#848E9C" font-family="monospace" font-size="11">SCORE</text>',
            '<text x="224" y="210" text-anchor="middle" fill="#F0B90B" font-family="monospace" font-size="26">',
            bountiesText,
            '</text><text x="224" y="232" text-anchor="middle" fill="#848E9C" font-family="monospace" font-size="11">BOUNTIES</text>',
            '<text x="160" y="278" text-anchor="middle" fill="#F0B90B" font-family="monospace" font-size="11">SOULBOUND AGENT ID</text></svg>'
        );
    }

    /// @notice Escape JSON string special characters (`"`, `\`, and common control bytes).
    function escapeJson(string memory input) internal pure returns (string memory) {
        bytes memory src = bytes(input);
        uint256 len = src.length;
        uint256 extra = 0;
        for (uint256 i; i < len; ++i) {
            bytes1 c = src[i];
            if (c == 0x22 || c == 0x5c || c == 0x0a || c == 0x0d || c == 0x09) {
                unchecked {
                    extra += 1;
                }
            }
        }
        if (extra == 0) return input;

        bytes memory out = new bytes(len + extra);
        uint256 j = 0;
        for (uint256 i; i < len; ++i) {
            bytes1 c = src[i];
            if (c == 0x22 || c == 0x5c) {
                out[j++] = 0x5c;
                out[j++] = c;
            } else if (c == 0x0a) {
                out[j++] = 0x5c;
                out[j++] = 0x6e;
            } else if (c == 0x0d) {
                out[j++] = 0x5c;
                out[j++] = 0x72;
            } else if (c == 0x09) {
                out[j++] = 0x5c;
                out[j++] = 0x74;
            } else {
                out[j++] = c;
            }
        }
        return string(out);
    }

    /// @notice Escape XML special characters (`&`, `<`, `>`, `"`, `'`) to prevent SVG/XML injection.
    function escapeXml(string memory input) internal pure returns (string memory) {
        bytes memory src = bytes(input);
        uint256 len = src.length;
        uint256 extra = 0;
        for (uint256 i; i < len; ++i) {
            bytes1 c = src[i];
            if (c == 0x26) {
                unchecked {
                    extra += 4;
                }
            } else if (c == 0x3c || c == 0x3e) {
                unchecked {
                    extra += 3;
                }
            } else if (c == 0x22) {
                unchecked {
                    extra += 5;
                }
            } else if (c == 0x27) {
                unchecked {
                    extra += 4;
                }
            }
        }
        if (extra == 0) return input;

        bytes memory out = new bytes(len + extra);
        uint256 j = 0;
        for (uint256 i; i < len; ++i) {
            bytes1 c = src[i];
            if (c == 0x26) {
                out[j++] = "&";
                out[j++] = "a";
                out[j++] = "m";
                out[j++] = "p";
                out[j++] = ";";
            } else if (c == 0x3c) {
                out[j++] = "&";
                out[j++] = "l";
                out[j++] = "t";
                out[j++] = ";";
            } else if (c == 0x3e) {
                out[j++] = "&";
                out[j++] = "g";
                out[j++] = "t";
                out[j++] = ";";
            } else if (c == 0x22) {
                out[j++] = "&";
                out[j++] = "q";
                out[j++] = "u";
                out[j++] = "o";
                out[j++] = "t";
                out[j++] = ";";
            } else if (c == 0x27) {
                out[j++] = "&";
                out[j++] = "#";
                out[j++] = "3";
                out[j++] = "9";
                out[j++] = ";";
            } else {
                out[j++] = c;
            }
        }
        return string(out);
    }
}

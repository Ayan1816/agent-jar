// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {IAgentIdRegistry} from "./interfaces/IAgentIdRegistry.sol";

/// @title AgentJar
/// @notice Ownerless tipping, polls, streaks, and a soulbound reputation badge.
/// @dev There is no owner, no admin, no pause, and no protocol fee. Tips are forwarded
///      to the handle owner in the same transaction. The badge cannot be transferred.
contract AgentJar is ERC721, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant MIN_NATIVE_TIP = 0.0001 ether;
    /// @dev Both pinned stablecoins use 18 decimals, so 0.10 tokens is `1e17` base units.
    uint256 public constant MIN_USD_TIP = 0.1 ether;
    uint256 public constant MAX_MESSAGE_BYTES = 280;
    uint64 public constant MIN_POLL_DURATION = 1 hours;
    uint64 public constant MAX_POLL_DURATION = 30 days;
    uint8 public constant MAX_POLLS_PER_DAY = 3;
    uint8 public constant MIN_OPTIONS = 2;
    uint8 public constant MAX_OPTIONS = 6;

    IAgentIdRegistry public immutable registry;
    IERC20 public immutable usdt;
    IERC20 public immutable usdc;

    /// @notice Tip totals for an address that has received tips.
    /// @dev Packed into one storage slot.
    struct RecipientStats {
        uint32 tipsReceived;
        uint32 uniqueSupporters;
        uint96 bnbReceived;
        uint96 usdReceived;
    }

    /// @notice Tip, poll, and streak totals for an address.
    /// @dev `lastVoteDay` and `pollDay` store `block.timestamp / 1 days + 1`.
    ///      Zero means that account has never voted or never created a poll.
    ///      Packed into one storage slot.
    struct SenderStats {
        uint32 agentIdsTipped;
        uint32 pollVotes;
        uint32 pollsCreated;
        uint32 currentStreak;
        uint32 bestStreak;
        uint32 lastVoteDay;
        uint32 pollDay;
        uint8 pollsToday;
    }

    struct Poll {
        uint32[6] votes;
        uint64 endTime;
        address creator;
        uint8 optionCount;
        string question;
    }

    mapping(address account => RecipientStats) public recipientStats;
    mapping(address account => SenderStats) public senderStats;
    mapping(address recipient => mapping(address supporter => bool tipped)) private _tipped;

    uint256 public pollCount;
    mapping(uint256 pollId => Poll) private _polls;
    mapping(uint256 pollId => mapping(uint8 index => string option)) private _options;
    mapping(uint256 pollId => mapping(address voter => bool voted)) private _hasVoted;

    error ZeroAddress();
    error NotHolder();
    error UnknownHandle();
    error SelfTip();
    error TipTooSmall();
    error MessageTooLong();
    error UnsupportedToken();
    error TransferFailed();
    error InvalidQuestion();
    error InvalidOptions();
    error InvalidDuration();
    error PollRateLimited();
    error PollNotFound();
    error PollClosed();
    error AlreadyVoted();
    error InvalidOption();
    error ScoreTooLow();
    error BadgeAlreadyClaimed();
    error NonTransferable();

    event TipSent(
        address indexed sender,
        address indexed recipient,
        address indexed token,
        uint256 amount,
        string handle,
        string message
    );
    event PollCreated(uint256 indexed pollId, address indexed creator, uint64 endTime);
    event VoteCast(uint256 indexed pollId, address indexed voter, uint8 optionIndex);

    constructor(IAgentIdRegistry registry_, IERC20 usdt_, IERC20 usdc_) ERC721("AgentJar Badge", "AJB") {
        if (address(registry_) == address(0) || address(usdt_) == address(0) || address(usdc_) == address(0)) {
            revert ZeroAddress();
        }
        registry = registry_;
        usdt = usdt_;
        usdc = usdc_;
    }

    /// @notice Tip the owner of `rawHandle` with the chain's native coin.
    /// @dev `rawHandle` may include an optional `.ai` suffix and any ASCII case.
    ///      `token` in {TipSent} is `address(0)` for a native tip.
    function tipBNB(string calldata rawHandle, string calldata message) external payable nonReentrant {
        if (msg.value < MIN_NATIVE_TIP) revert TipTooSmall();
        _checkMessage(message);
        (address recipient, string memory handle) = _resolve(rawHandle);
        _recordTip(recipient, msg.value, true);
        (bool ok,) = recipient.call{value: msg.value}("");
        if (!ok) revert TransferFailed();
        emit TipSent(msg.sender, recipient, address(0), msg.value, handle, message);
    }

    /// @notice Tip the owner of `rawHandle` with USDT or USDC. The contract never holds the tokens.
    function tipToken(string calldata rawHandle, address token, uint256 amount, string calldata message)
        external
        nonReentrant
    {
        if (token != address(usdt) && token != address(usdc)) revert UnsupportedToken();
        if (amount < MIN_USD_TIP) revert TipTooSmall();
        _checkMessage(message);
        (address recipient, string memory handle) = _resolve(rawHandle);
        _recordTip(recipient, amount, false);
        IERC20(token).safeTransferFrom(msg.sender, recipient, amount);
        emit TipSent(msg.sender, recipient, token, amount, handle, message);
    }

    /// @notice Create a poll. Caller must hold an Agent ID. At most three polls per UTC day.
    function createPoll(string calldata question, string[] calldata options, uint64 duration)
        external
        returns (uint256 pollId)
    {
        _requireHolder(msg.sender);
        if (bytes(question).length == 0) revert InvalidQuestion();
        uint256 optionCount = options.length;
        if (optionCount < MIN_OPTIONS || optionCount > MAX_OPTIONS) revert InvalidOptions();
        if (duration < MIN_POLL_DURATION || duration > MAX_POLL_DURATION) revert InvalidDuration();

        uint32 today = _dayIndex();
        SenderStats storage stats = senderStats[msg.sender];
        if (stats.pollDay != today) {
            stats.pollDay = today;
            stats.pollsToday = 0;
        }
        if (stats.pollsToday >= MAX_POLLS_PER_DAY) revert PollRateLimited();

        pollId = pollCount;
        Poll storage poll = _polls[pollId];
        poll.creator = msg.sender;
        poll.endTime = uint64(block.timestamp + duration);
        poll.optionCount = uint8(optionCount);
        poll.question = question;
        for (uint256 i; i < optionCount; ++i) {
            if (bytes(options[i]).length == 0) revert InvalidOptions();
            _options[pollId][uint8(i)] = options[i];
        }

        unchecked {
            stats.pollsToday += 1;
            stats.pollsCreated += 1;
            pollCount = pollId + 1;
        }
        emit PollCreated(pollId, msg.sender, poll.endTime);
    }

    /// @notice Vote on an open poll. One vote per holder. Updates the UTC-day voting streak.
    function vote(uint256 pollId, uint8 optionIndex) external {
        _requireHolder(msg.sender);
        if (pollId >= pollCount) revert PollNotFound();
        Poll storage poll = _polls[pollId];
        if (block.timestamp >= poll.endTime) revert PollClosed();
        if (optionIndex >= poll.optionCount) revert InvalidOption();
        if (_hasVoted[pollId][msg.sender]) revert AlreadyVoted();

        _hasVoted[pollId][msg.sender] = true;
        unchecked {
            poll.votes[optionIndex] += 1;
        }
        _bumpStreak(senderStats[msg.sender]);
        emit VoteCast(pollId, msg.sender, optionIndex);
    }

    /// @notice Mint the soulbound badge. Requires an Agent ID and a score of at least 1.
    /// @return tokenId Deterministic id `uint256(uint160(msg.sender))`.
    function claimBadge() external returns (uint256 tokenId) {
        _requireHolder(msg.sender);
        if (getScore(msg.sender) < 1) revert ScoreTooLow();
        tokenId = tokenIdOf(msg.sender);
        if (_ownerOf(tokenId) != address(0)) revert BadgeAlreadyClaimed();
        _mint(msg.sender, tokenId);
    }

    /// @notice `5 * supporters + 3 * recipients tipped + min(tips, 100) + votes + 2 * bestStreak + 2 * polls`.
    function getScore(address user) public view returns (uint256) {
        RecipientStats storage recipient = recipientStats[user];
        SenderStats storage sender = senderStats[user];
        uint256 cappedTips = recipient.tipsReceived;
        if (cappedTips > 100) cappedTips = 100;
        return 5 * uint256(recipient.uniqueSupporters) + 3 * uint256(sender.agentIdsTipped) + cappedTips
            + uint256(sender.pollVotes) + 2 * uint256(sender.bestStreak) + 2 * uint256(sender.pollsCreated);
    }

    /// @notice Map a score to a tier id and name.
    /// @dev 0 None, 1 Spark, 2 Bronze, 3 Silver, 4 Gold, 5 Legend.
    function getTier(uint256 score) public pure returns (uint8 tierId, string memory tierName) {
        if (score >= 400) return (5, "Legend");
        if (score >= 120) return (4, "Gold");
        if (score >= 40) return (3, "Silver");
        if (score >= 10) return (2, "Bronze");
        if (score >= 1) return (1, "Spark");
        return (0, "None");
    }

    function tokenIdOf(address account) public pure returns (uint256) {
        return uint256(uint160(account));
    }

    function hasVoted(uint256 pollId, address voter) external view returns (bool) {
        if (pollId >= pollCount) revert PollNotFound();
        return _hasVoted[pollId][voter];
    }

    function optionVotes(uint256 pollId, uint8 optionIndex) external view returns (uint32) {
        if (pollId >= pollCount) revert PollNotFound();
        if (optionIndex >= _polls[pollId].optionCount) revert InvalidOption();
        return _polls[pollId].votes[optionIndex];
    }

    /// @notice Poll creator, deadline, open flag, question, options, and per-option vote counts.
    function getPoll(uint256 pollId)
        external
        view
        returns (
            address creator,
            uint64 endTime,
            bool open,
            string memory question,
            string[] memory options,
            uint32[] memory votes
        )
    {
        if (pollId >= pollCount) revert PollNotFound();
        Poll storage poll = _polls[pollId];
        creator = poll.creator;
        endTime = poll.endTime;
        open = block.timestamp < endTime;
        question = poll.question;
        uint256 count = poll.optionCount;
        options = new string[](count);
        votes = new uint32[](count);
        for (uint256 i; i < count; ++i) {
            options[i] = _options[pollId][uint8(i)];
            votes[i] = poll.votes[i];
        }
    }

    /// @inheritdoc ERC721
    /// @dev Score, tier, and handle are read on every call. Nothing is cached.
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        address owner = ownerOf(tokenId);
        uint256 score = getScore(owner);
        (, string memory tierName) = getTier(score);
        string memory handle = registry.handleOf(owner);
        string memory scoreText = Strings.toString(score);
        string memory json = _badgeJson(handle, scoreText, tierName);
        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }

    /// @dev Mint from `address(0)` is the only permitted update.
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

    function _resolve(string calldata rawHandle) internal view returns (address recipient, string memory handle) {
        handle = _normalize(rawHandle);
        recipient = registry.ownerOfHandle(handle);
        if (recipient == address(0)) revert UnknownHandle();
        if (recipient == msg.sender) revert SelfTip();
    }

    /// @dev Lowercase ASCII A-Z, then drop one trailing `.ai` suffix when present.
    function _normalize(string calldata rawHandle) internal pure returns (string memory) {
        bytes memory data = bytes(rawHandle);
        uint256 length = data.length;
        for (uint256 i; i < length; ++i) {
            bytes1 character = data[i];
            if (character >= 0x41 && character <= 0x5A) {
                data[i] = bytes1(uint8(character) + 32);
            }
        }
        if (
            length >= 3 && data[length - 3] == 0x2e && data[length - 2] == 0x61 && data[length - 1] == 0x69
        ) {
            length -= 3;
            bytes memory trimmed = new bytes(length);
            for (uint256 i; i < length; ++i) {
                trimmed[i] = data[i];
            }
            return string(trimmed);
        }
        return string(data);
    }

    function _checkMessage(string calldata message) internal pure {
        if (bytes(message).length > MAX_MESSAGE_BYTES) revert MessageTooLong();
    }

    function _recordTip(address recipient, uint256 amount, bool nativeTip) internal {
        RecipientStats storage stats = recipientStats[recipient];
        unchecked {
            stats.tipsReceived += 1;
        }
        if (nativeTip) {
            stats.bnbReceived += uint96(amount);
        } else {
            stats.usdReceived += uint96(amount);
        }
        if (!_tipped[recipient][msg.sender]) {
            _tipped[recipient][msg.sender] = true;
            unchecked {
                stats.uniqueSupporters += 1;
                senderStats[msg.sender].agentIdsTipped += 1;
            }
        }
    }

    function _bumpStreak(SenderStats storage stats) internal {
        uint32 today = _dayIndex();
        if (stats.lastVoteDay != today) {
            if (stats.lastVoteDay + 1 == today) {
                unchecked {
                    stats.currentStreak += 1;
                }
            } else {
                stats.currentStreak = 1;
            }
        }
        if (stats.currentStreak > stats.bestStreak) {
            stats.bestStreak = stats.currentStreak;
        }
        stats.lastVoteDay = today;
        unchecked {
            stats.pollVotes += 1;
        }
    }

    /// @dev One-based day index so a stored zero still means "never".
    function _dayIndex() internal view returns (uint32) {
        return uint32(block.timestamp / 1 days) + 1;
    }

    function _requireHolder(address account) internal view {
        if (registry.balanceOf(account) == 0) revert NotHolder();
    }

    function _badgeJson(string memory handle, string memory scoreText, string memory tierName)
        internal
        pure
        returns (string memory)
    {
        string memory image = Base64.encode(bytes(_badgeSvg(handle, scoreText, tierName)));
        return string.concat(
            '{"name":"AgentJar Badge","description":"Soulbound reputation badge. Score and tier are read live from AgentJar.","attributes":[{"trait_type":"Handle","value":"',
            handle,
            '"},{"trait_type":"Score","value":',
            scoreText,
            '},{"trait_type":"Tier","value":"',
            tierName,
            '"}],"image":"data:image/svg+xml;base64,',
            image,
            '"}'
        );
    }

    function _badgeSvg(string memory handle, string memory scoreText, string memory tierName)
        internal
        pure
        returns (string memory)
    {
        return string.concat(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 320">',
            '<rect width="320" height="320" rx="24" fill="#0B0E11"/>',
            '<rect x="16" y="16" width="288" height="288" rx="16" fill="#161A1E" stroke="#F0B90B" stroke-width="3"/>',
            '<text x="160" y="72" text-anchor="middle" fill="#F0B90B" font-family="monospace" font-size="16">AGENTJAR</text>',
            '<text x="160" y="136" text-anchor="middle" fill="#F0B90B" font-family="monospace" font-size="32">',
            tierName,
            '</text><text x="160" y="178" text-anchor="middle" fill="#F0B90B" font-family="monospace" font-size="18">@',
            handle,
            '</text><text x="160" y="232" text-anchor="middle" fill="#F0B90B" font-family="monospace" font-size="28">',
            scoreText,
            '</text><text x="160" y="260" text-anchor="middle" fill="#F0B90B" font-family="monospace" font-size="12">SCORE</text></svg>'
        );
    }
}

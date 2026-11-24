// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {IAgentIdRegistry} from "./interfaces/IAgentIdRegistry.sol";
import {AgentJarMetadata} from "./libraries/AgentJarMetadata.sol";

/// @title AgentJar
/// @notice Ownerless, immutable tipping, hardened polls, A2A micro-bounty escrow with 3-juror dispute
///         resolution, persistent active-agent directory, and a soulbound Agent Reputation Passport.
/// @dev There is no owner, no admin, no pause, no upgrade proxy, and 0% protocol fee.
///      Native BNB transfers attempt instant forwarding and fall back to pull-payment
///      (`pendingWithdrawals` + `claimPendingBNB`) if a contract recipient reverts.
contract AgentJar is ERC721, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    uint256 public constant MIN_NATIVE_TIP = 0.0001 ether;
    /// @dev Both pinned stablecoins use 18 decimals, so 0.10 tokens is `1e17` base units.
    uint256 public constant MIN_USD_TIP = 0.1 ether;
    uint256 public constant MAX_MESSAGE_BYTES = 280;
    uint256 public constant MAX_QUESTION_BYTES = 200;
    uint256 public constant MAX_OPTION_BYTES = 64;
    uint64 public constant MIN_POLL_DURATION = 6 hours;
    uint64 public constant MAX_POLL_DURATION = 7 days;
    uint8 public constant MAX_POLLS_PER_DAY = 3;
    uint8 public constant MIN_OPTIONS = 2;
    uint8 public constant MAX_OPTIONS = 6;
    uint32 public constant POLL_SCORE_MIN_VOTES = 3;

    uint64 public constant MIN_BOUNTY_DURATION = 1 hours;
    uint64 public constant MAX_BOUNTY_DURATION = 14 days;
    uint64 public constant DISPUTE_APPROVAL_GRACE = 24 hours;
    uint64 public constant DISPUTE_WINDOW = 48 hours;
    uint8 public constant DISPUTE_MAJORITY = 2;

    /// @dev Gas stipend for instant native BNB forwarding. Generous enough for smart wallets,
    ///      bounded to prevent gas-griefing DoS by malicious contract recipients.
    uint256 private constant BNB_FORWARD_GAS = 100_000;

    IAgentIdRegistry public immutable registry;
    IERC20 public immutable usdt;
    IERC20 public immutable usdc;

    /// @notice Tip totals for an address that has received tips.
    /// @dev `tipsReceived` and `uniqueSupporters` count verified Agent ID senders only.
    ///      Packed into one storage slot.
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
        address creator;
        uint64 endTime;
        uint8 optionCount;
        bool supporterOnly;
        bool scoreAwarded;
        uint32 totalVotes;
        string question;
    }

    enum BountyStatus {
        Open,
        Submitted,
        Disputed,
        Completed,
        Refunded,
        Split
    }

    struct Bounty {
        address creator;
        uint64 deadline;
        BountyStatus status;
        uint8 votesForWorker;
        uint8 votesForCreator;
        address worker;
        uint64 submittedAt;
        address token;
        uint64 disputeDeadline;
        uint256 amount;
        bytes32 specHash;
        bytes32 deliverableHash;
    }

    mapping(address account => RecipientStats) public recipientStats;
    mapping(address account => SenderStats) public senderStats;
    mapping(address account => uint32) public qualifiedPolls;
    mapping(address account => uint32) public bountiesCompleted;
    mapping(address account => uint256) public pendingWithdrawals;

    address[] public activeAgents;
    mapping(address account => bool) public isActiveAgent;

    mapping(address recipient => mapping(address supporter => bool tipped)) private _tipped;
    mapping(address partyA => mapping(address partyB => bool completed)) private _bountyCompletedWith;

    uint256 public pollCount;
    mapping(uint256 pollId => Poll) private _polls;
    mapping(uint256 pollId => mapping(uint8 index => string option)) private _options;
    mapping(uint256 pollId => mapping(address voter => bool voted)) private _hasVoted;

    uint256 public bountyCount;
    mapping(uint256 bountyId => Bounty) private _bounties;
    mapping(uint256 bountyId => mapping(address juror => bool voted)) private _hasVotedDispute;

    error ZeroAddress();
    error NotHolder();
    error UnknownHandle();
    error SelfTip();
    error SelfBounty();
    error TipTooSmall();
    error MessageTooLong();
    error UnsupportedToken();
    error TransferFailed();
    error NothingToClaim();
    error InvalidQuestion();
    error InvalidOptions();
    error InvalidDuration();
    error PollRateLimited();
    error PollNotFound();
    error PollClosed();
    error AlreadyVoted();
    error InvalidOption();
    error NotSupporter();
    error ScoreTooLow();
    error BadgeAlreadyClaimed();
    error NonTransferable();
    error BountyAmountTooSmall();
    error InvalidMsgValue();
    error InvalidDeadline();
    error InvalidSpecHash();
    error InvalidDeliverableHash();
    error BountyNotFound();
    error InvalidBountyStatus();
    error NotBountyCreator();
    error NotBountyWorker();
    error NotBountyParty();
    error BountyExpired();
    error BountyNotExpired();
    error DisputeTooEarly();
    error DisputeExpired();
    error DisputeActive();
    error JurorNotIndependent();

    event TipSent(
        address indexed sender,
        address indexed recipient,
        address indexed token,
        uint256 amount,
        string handle,
        string message
    );
    event ActiveAgentRegistered(address indexed agent);
    event PendingWithdrawalCredited(address indexed recipient, uint256 amount);
    event PendingWithdrawalClaimed(address indexed recipient, uint256 amount);
    event PollCreated(uint256 indexed pollId, address indexed creator, uint64 endTime, bool supporterOnly);
    event VoteCast(uint256 indexed pollId, address indexed voter, uint8 optionIndex);
    event BountyCreated(
        uint256 indexed bountyId,
        address indexed creator,
        address indexed worker,
        address token,
        uint256 amount,
        uint64 deadline,
        bytes32 specHash,
        string workerHandle
    );
    event BountyWorkSubmitted(uint256 indexed bountyId, address indexed worker, bytes32 deliverableHash);
    event BountyApproved(
        uint256 indexed bountyId, address indexed creator, address indexed worker, address token, uint256 amount
    );
    event BountyReclaimed(uint256 indexed bountyId, address indexed creator, address token, uint256 amount);
    event DisputeOpened(uint256 indexed bountyId, address indexed opener, uint64 disputeDeadline);
    event DisputeVoteCast(uint256 indexed bountyId, address indexed juror, bool releaseToWorker);
    event DisputeResolved(uint256 indexed bountyId, BountyStatus outcome, uint256 workerAmount, uint256 creatorAmount);

    constructor(IAgentIdRegistry registry_, IERC20 usdt_, IERC20 usdc_) ERC721("AgentJar Badge", "AJB") {
        if (address(registry_) == address(0) || address(usdt_) == address(0) || address(usdc_) == address(0)) {
            revert ZeroAddress();
        }
        registry = registry_;
        usdt = usdt_;
        usdc = usdc_;
    }

    // -------------------------------------------------------------------------
    // Tipping & Pull-Payment Withdrawal
    // -------------------------------------------------------------------------

    /// @notice Tip the owner of `rawHandle` with the chain's native coin.
    /// @dev Anyone may tip, but only verified Agent ID senders increment reputation stats.
    ///      Instant forwarding is attempted first; if the recipient contract reverts, the amount
    ///      is safely credited to `pendingWithdrawals[recipient]`.
    function tipBNB(string calldata rawHandle, string calldata message) external payable nonReentrant {
        if (msg.value < MIN_NATIVE_TIP) revert TipTooSmall();
        _checkMessage(message);
        (address recipient, string memory handle) = _resolveTipTarget(rawHandle);
        _recordTip(recipient, msg.value, true);
        emit TipSent(msg.sender, recipient, address(0), msg.value, handle, message);
        _sendBNB(recipient, msg.value);
    }

    /// @notice Tip the owner of `rawHandle` with USDT or USDC. The contract never holds tip tokens.
    /// @dev Anyone may tip, but only verified Agent ID senders increment reputation stats.
    function tipToken(string calldata rawHandle, address token, uint256 amount, string calldata message)
        external
        nonReentrant
    {
        if (token != address(usdt) && token != address(usdc)) revert UnsupportedToken();
        if (amount < MIN_USD_TIP) revert TipTooSmall();
        _checkMessage(message);
        (address recipient, string memory handle) = _resolveTipTarget(rawHandle);
        _recordTip(recipient, amount, false);
        emit TipSent(msg.sender, recipient, token, amount, handle, message);
        IERC20(token).safeTransferFrom(msg.sender, recipient, amount);
    }

    /// @notice Claim native BNB credited after a failed direct push transfer.
    function claimPendingBNB() external nonReentrant {
        uint256 amount = pendingWithdrawals[msg.sender];
        if (amount == 0) revert NothingToClaim();
        pendingWithdrawals[msg.sender] = 0;
        emit PendingWithdrawalClaimed(msg.sender, amount);
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    // -------------------------------------------------------------------------
    // Polls
    // -------------------------------------------------------------------------

    /// @notice Create a public poll. Caller must hold an Agent ID. At most three polls per UTC day.
    function createPoll(string calldata question, string[] calldata options, uint64 duration)
        external
        returns (uint256 pollId)
    {
        return _createPoll(question, options, duration, false);
    }

    /// @notice Create a poll with an optional `supporterOnly` voting gate.
    /// @dev Creator receives poll score only once the poll reaches at least 3 unique Agent ID votes.
    function createPoll(string calldata question, string[] calldata options, uint64 duration, bool supporterOnly)
        external
        returns (uint256 pollId)
    {
        return _createPoll(question, options, duration, supporterOnly);
    }

    /// @notice Vote on an open poll. One vote per verified Agent ID. Updates the UTC-day voting streak.
    function vote(uint256 pollId, uint8 optionIndex) external {
        _requireHolder(msg.sender);
        if (pollId >= pollCount) revert PollNotFound();
        Poll storage poll = _polls[pollId];
        if (block.timestamp >= poll.endTime) revert PollClosed();
        if (optionIndex >= poll.optionCount) revert InvalidOption();
        if (_hasVoted[pollId][msg.sender]) revert AlreadyVoted();
        if (poll.supporterOnly && !isSupporter(poll.creator, msg.sender)) revert NotSupporter();

        _hasVoted[pollId][msg.sender] = true;
        poll.votes[optionIndex] += 1;
        uint32 newTotal = poll.totalVotes + 1;
        poll.totalVotes = newTotal;
        if (!poll.scoreAwarded && newTotal >= POLL_SCORE_MIN_VOTES) {
            poll.scoreAwarded = true;
            qualifiedPolls[poll.creator] += 1;
        }
        _bumpStreak(senderStats[msg.sender]);
        _registerActiveAgent(msg.sender);
        emit VoteCast(pollId, msg.sender, optionIndex);
    }

    // -------------------------------------------------------------------------
    // A2A Micro-Bounty Escrow & 3-Juror Sybil-Free Dispute Resolution
    // -------------------------------------------------------------------------

    /// @notice Create and fund a non-custodial A2A micro-bounty for a verified worker Agent ID.
    /// @param rawWorkerHandle Worker Agent ID handle (case-insensitive, optional `.ai` suffix).
    /// @param token `address(0)` for native BNB, or pinned BSC USDT/USDC.
    /// @param amount Escrowed payout amount (0% protocol fee).
    /// @param deadline Submission deadline between `block.timestamp + 1 hours` and `block.timestamp + 14 days`.
    /// @param specHash Non-zero content hash of the bounty specification.
    function createBounty(
        string calldata rawWorkerHandle,
        address token,
        uint256 amount,
        uint64 deadline,
        bytes32 specHash
    ) external payable nonReentrant returns (uint256 bountyId) {
        _requireHolder(msg.sender);
        (address worker, string memory workerHandle) = _resolveHandle(rawWorkerHandle);
        if (worker == msg.sender) revert SelfBounty();
        if (specHash == bytes32(0)) revert InvalidSpecHash();
        if (deadline < block.timestamp + MIN_BOUNTY_DURATION || deadline > block.timestamp + MAX_BOUNTY_DURATION) {
            revert InvalidDeadline();
        }

        if (token == address(0)) {
            if (amount < MIN_NATIVE_TIP) revert BountyAmountTooSmall();
            if (msg.value != amount) revert InvalidMsgValue();
        } else if (token == address(usdt) || token == address(usdc)) {
            if (msg.value != 0) revert InvalidMsgValue();
            if (amount < MIN_USD_TIP) revert BountyAmountTooSmall();
        } else {
            revert UnsupportedToken();
        }

        bountyId = bountyCount;
        bountyCount = bountyId + 1;

        Bounty storage bounty = _bounties[bountyId];
        bounty.creator = msg.sender;
        bounty.worker = worker;
        bounty.token = token;
        bounty.amount = amount;
        bounty.deadline = deadline;
        bounty.specHash = specHash;
        bounty.status = BountyStatus.Open;

        _registerActiveAgent(msg.sender);
        emit BountyCreated(bountyId, msg.sender, worker, token, amount, deadline, specHash, workerHandle);

        if (token != address(0)) {
            IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        }
    }

    /// @notice Submit completed work for an open bounty before its deadline.
    function submitBountyWork(uint256 bountyId, bytes32 deliverableHash) external {
        if (bountyId >= bountyCount) revert BountyNotFound();
        _requireHolder(msg.sender);
        Bounty storage bounty = _bounties[bountyId];
        if (msg.sender != bounty.worker) revert NotBountyWorker();
        if (bounty.status != BountyStatus.Open) revert InvalidBountyStatus();
        if (block.timestamp > bounty.deadline) revert BountyExpired();
        if (deliverableHash == bytes32(0)) revert InvalidDeliverableHash();

        bounty.deliverableHash = deliverableHash;
        bounty.submittedAt = block.timestamp.toUint64();
        bounty.status = BountyStatus.Submitted;

        _registerActiveAgent(msg.sender);
        emit BountyWorkSubmitted(bountyId, msg.sender, deliverableHash);
    }

    /// @notice Approve submitted work and release 100% of escrowed funds to the worker (0% fee).
    /// @dev Increments `bountiesCompleted` for both creator and worker.
    function approveBounty(uint256 bountyId) external nonReentrant {
        if (bountyId >= bountyCount) revert BountyNotFound();
        _requireHolder(msg.sender);
        Bounty storage bounty = _bounties[bountyId];
        if (msg.sender != bounty.creator) revert NotBountyCreator();
        if (bounty.status != BountyStatus.Submitted) revert InvalidBountyStatus();

        address creator = bounty.creator;
        address worker = bounty.worker;
        address token = bounty.token;
        uint256 amount = bounty.amount;

        bounty.status = BountyStatus.Completed;
        bountiesCompleted[creator] += 1;
        bountiesCompleted[worker] += 1;
        _bountyCompletedWith[creator][worker] = true;
        _bountyCompletedWith[worker][creator] = true;
        _registerActiveAgent(creator);
        _registerActiveAgent(worker);

        emit BountyApproved(bountyId, creator, worker, token, amount);
        _payout(token, worker, amount);
    }

    /// @notice Refund 100% of escrowed funds to the creator if the deadline passed without submission.
    function reclaimExpiredBounty(uint256 bountyId) external nonReentrant {
        if (bountyId >= bountyCount) revert BountyNotFound();
        _requireHolder(msg.sender);
        Bounty storage bounty = _bounties[bountyId];
        if (msg.sender != bounty.creator) revert NotBountyCreator();
        if (bounty.status != BountyStatus.Open) revert InvalidBountyStatus();
        if (block.timestamp <= bounty.deadline) revert BountyNotExpired();

        address creator = bounty.creator;
        address token = bounty.token;
        uint256 amount = bounty.amount;

        bounty.status = BountyStatus.Refunded;
        emit BountyReclaimed(bountyId, creator, token, amount);
        _payout(token, creator, amount);
    }

    /// @notice Open a 48-hour 3-juror dispute on a submitted bounty.
    /// @dev Creator may open immediately after submission; worker may open if the creator has
    ///      not approved within 24 hours after submission.
    function openDispute(uint256 bountyId) external {
        if (bountyId >= bountyCount) revert BountyNotFound();
        _requireHolder(msg.sender);
        Bounty storage bounty = _bounties[bountyId];
        if (bounty.status != BountyStatus.Submitted) revert InvalidBountyStatus();

        if (msg.sender == bounty.creator) {
            // Creator can open a dispute immediately once work is submitted.
        } else if (msg.sender == bounty.worker) {
            if (block.timestamp < uint256(bounty.submittedAt) + DISPUTE_APPROVAL_GRACE) {
                revert DisputeTooEarly();
            }
        } else {
            revert NotBountyParty();
        }

        uint64 disputeDeadline = (block.timestamp + DISPUTE_WINDOW).toUint64();
        bounty.status = BountyStatus.Disputed;
        bounty.disputeDeadline = disputeDeadline;
        _registerActiveAgent(msg.sender);
        emit DisputeOpened(bountyId, msg.sender, disputeDeadline);
    }

    /// @notice Cast a juror vote in an active bounty dispute.
    /// @dev Requires an independent verified Agent ID with `getScore(msg.sender) > 0`.
    ///      As soon as either side reaches 2 votes (3-juror majority), the dispute finalizes
    ///      immediately and releases 100% of escrowed funds to the winner.
    function voteDispute(uint256 bountyId, bool releaseToWorker) external nonReentrant {
        if (bountyId >= bountyCount) revert BountyNotFound();
        _requireHolder(msg.sender);
        Bounty storage bounty = _bounties[bountyId];
        if (bounty.status != BountyStatus.Disputed) revert InvalidBountyStatus();
        if (block.timestamp >= bounty.disputeDeadline) revert DisputeExpired();
        if (msg.sender == bounty.creator || msg.sender == bounty.worker) revert JurorNotIndependent();
        if (getScore(msg.sender) == 0) revert ScoreTooLow();
        if (_hasVotedDispute[bountyId][msg.sender]) revert AlreadyVoted();

        _hasVotedDispute[bountyId][msg.sender] = true;
        _registerActiveAgent(msg.sender);
        emit DisputeVoteCast(bountyId, msg.sender, releaseToWorker);

        if (releaseToWorker) {
            uint8 votes = bounty.votesForWorker + 1;
            bounty.votesForWorker = votes;
            if (votes >= DISPUTE_MAJORITY) {
                _finalizeDisputeForWorker(bountyId, bounty);
            }
        } else {
            uint8 votes = bounty.votesForCreator + 1;
            bounty.votesForCreator = votes;
            if (votes >= DISPUTE_MAJORITY) {
                _finalizeDisputeForCreator(bountyId, bounty);
            }
        }
    }

    /// @notice Deterministically finalize a dispute after the 48-hour window if quorum was not reached.
    /// @dev Permissionless liveness guarantee:
    ///      - If one side leads (1-0), that side receives 100% of the escrow.
    ///      - If tied (0-0 or 1-1), funds split deterministically 50/50 (`worker = amount / 2`,
    ///        `creator = amount - worker`) with zero dust trapped in the contract.
    function resolveExpiredDispute(uint256 bountyId) external nonReentrant {
        if (bountyId >= bountyCount) revert BountyNotFound();
        Bounty storage bounty = _bounties[bountyId];
        if (bounty.status != BountyStatus.Disputed) revert InvalidBountyStatus();
        if (block.timestamp < bounty.disputeDeadline) revert DisputeActive();

        if (bounty.votesForWorker > bounty.votesForCreator) {
            _finalizeDisputeForWorker(bountyId, bounty);
        } else if (bounty.votesForCreator > bounty.votesForWorker) {
            _finalizeDisputeForCreator(bountyId, bounty);
        } else {
            address creator = bounty.creator;
            address worker = bounty.worker;
            address token = bounty.token;
            uint256 amount = bounty.amount;
            uint256 workerShare = amount / 2;
            uint256 creatorShare = amount - workerShare;

            bounty.status = BountyStatus.Split;
            emit DisputeResolved(bountyId, BountyStatus.Split, workerShare, creatorShare);

            if (workerShare > 0) _payout(token, worker, workerShare);
            if (creatorShare > 0) _payout(token, creator, creatorShare);
        }
    }

    // -------------------------------------------------------------------------
    // Soulbound Reputation Passport
    // -------------------------------------------------------------------------

    /// @notice Mint the soulbound Agent Reputation Passport. Requires an Agent ID and score >= 1.
    /// @return tokenId Deterministic id `uint256(uint160(msg.sender))`.
    function claimBadge() external returns (uint256 tokenId) {
        _requireHolder(msg.sender);
        if (getScore(msg.sender) < 1) revert ScoreTooLow();
        tokenId = tokenIdOf(msg.sender);
        if (_ownerOf(tokenId) != address(0)) revert BadgeAlreadyClaimed();
        _registerActiveAgent(msg.sender);
        _mint(msg.sender, tokenId);
    }

    // -------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------

    /// @notice Total number of verified Agent IDs registered in the persistent active directory.
    function activeAgentCount() external view returns (uint256) {
        return activeAgents.length;
    }

    /// @notice Paginated read over `activeAgents` for reliable off-chain indexing and leaderboards.
    function getActiveAgents(uint256 offset, uint256 limit) external view returns (address[] memory agents) {
        uint256 total = activeAgents.length;
        if (offset >= total || limit == 0) {
            return new address[](0);
        }
        uint256 remaining = total - offset;
        uint256 size = limit < remaining ? limit : remaining;
        agents = new address[](size);
        for (uint256 i; i < size; ++i) {
            agents[i] = activeAgents[offset + i];
        }
    }

    /// @notice True if `account` has sent a verified tip to `creator` or completed a bounty with `creator`.
    function isSupporter(address creator, address account) public view returns (bool) {
        return _tipped[creator][account] || _bountyCompletedWith[creator][account];
    }

    /// @notice `5 * supporters + 3 * recipientsTipped + min(tips, 100) + votes + 2 * bestStreak + 2 * qualifiedPolls + 10 * bountiesCompleted`.
    function getScore(address user) public view returns (uint256) {
        RecipientStats storage recipient = recipientStats[user];
        SenderStats storage sender = senderStats[user];
        uint256 cappedTips = recipient.tipsReceived;
        if (cappedTips > 100) cappedTips = 100;
        return 5 * uint256(recipient.uniqueSupporters) + 3 * uint256(sender.agentIdsTipped) + cappedTips
            + uint256(sender.pollVotes) + 2 * uint256(sender.bestStreak) + 2 * uint256(qualifiedPolls[user]) + 10
            * uint256(bountiesCompleted[user]);
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

    /// @notice Full poll metadata, gating flag, vote total, options, and per-option counts.
    function getPoll(uint256 pollId)
        external
        view
        returns (
            address creator,
            uint64 endTime,
            bool open,
            bool supporterOnly,
            uint32 totalVotes,
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
        supporterOnly = poll.supporterOnly;
        totalVotes = poll.totalVotes;
        question = poll.question;
        uint256 count = poll.optionCount;
        options = new string[](count);
        votes = new uint32[](count);
        for (uint256 i; i < count; ++i) {
            options[i] = _options[pollId][i.toUint8()];
            votes[i] = poll.votes[i];
        }
    }

    function getBounty(uint256 bountyId) external view returns (Bounty memory) {
        if (bountyId >= bountyCount) revert BountyNotFound();
        return _bounties[bountyId];
    }

    function hasVotedDispute(uint256 bountyId, address juror) external view returns (bool) {
        if (bountyId >= bountyCount) revert BountyNotFound();
        return _hasVotedDispute[bountyId][juror];
    }

    /// @inheritdoc ERC721
    /// @dev Score, tier, handle, and bounty stats are read live on every call. Nothing is cached.
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        address owner = ownerOf(tokenId);
        uint256 score = getScore(owner);
        (, string memory tierName) = getTier(score);
        string memory handle = registry.handleOf(owner);
        return AgentJarMetadata.tokenURI(
            handle,
            Strings.toString(score),
            tierName,
            Strings.toString(bountiesCompleted[owner]),
            Strings.toString(recipientStats[owner].uniqueSupporters),
            Strings.toString(senderStats[owner].bestStreak)
        );
    }

    // -------------------------------------------------------------------------
    // Soulbound ERC-721 Overrides
    // -------------------------------------------------------------------------

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

    // -------------------------------------------------------------------------
    // Internal Helpers
    // -------------------------------------------------------------------------

    function _createPoll(string calldata question, string[] calldata options, uint64 duration, bool supporterOnly)
        internal
        returns (uint256 pollId)
    {
        _requireHolder(msg.sender);
        uint256 questionLen = bytes(question).length;
        if (questionLen == 0 || questionLen > MAX_QUESTION_BYTES) revert InvalidQuestion();
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
        poll.endTime = (block.timestamp + duration).toUint64();
        poll.optionCount = optionCount.toUint8();
        poll.supporterOnly = supporterOnly;
        poll.question = question;
        for (uint256 i; i < optionCount; ++i) {
            uint256 optionLen = bytes(options[i]).length;
            if (optionLen == 0 || optionLen > MAX_OPTION_BYTES) revert InvalidOptions();
            _options[pollId][i.toUint8()] = options[i];
        }

        stats.pollsToday += 1;
        stats.pollsCreated += 1;
        pollCount = pollId + 1;
        _registerActiveAgent(msg.sender);
        emit PollCreated(pollId, msg.sender, poll.endTime, supporterOnly);
    }

    function _finalizeDisputeForWorker(uint256 bountyId, Bounty storage bounty) internal {
        address creator = bounty.creator;
        address worker = bounty.worker;
        address token = bounty.token;
        uint256 amount = bounty.amount;

        bounty.status = BountyStatus.Completed;
        bountiesCompleted[worker] += 1;
        _bountyCompletedWith[creator][worker] = true;
        _bountyCompletedWith[worker][creator] = true;
        _registerActiveAgent(worker);

        emit DisputeResolved(bountyId, BountyStatus.Completed, amount, 0);
        _payout(token, worker, amount);
    }

    function _finalizeDisputeForCreator(uint256 bountyId, Bounty storage bounty) internal {
        address creator = bounty.creator;
        address token = bounty.token;
        uint256 amount = bounty.amount;

        bounty.status = BountyStatus.Refunded;
        emit DisputeResolved(bountyId, BountyStatus.Refunded, 0, amount);
        _payout(token, creator, amount);
    }

    function _payout(address token, address recipient, uint256 amount) internal {
        if (token == address(0)) {
            _sendBNB(recipient, amount);
        } else {
            IERC20(token).safeTransfer(recipient, amount);
        }
    }

    function _sendBNB(address recipient, uint256 amount) internal {
        bool ok;
        assembly {
            // Bounded gas + zero returndata copy prevents both gas-griefing and return-data bombs.
            ok := call(BNB_FORWARD_GAS, recipient, amount, 0, 0, 0, 0)
        }
        if (!ok) {
            pendingWithdrawals[recipient] += amount;
            emit PendingWithdrawalCredited(recipient, amount);
        }
    }

    function _resolveTipTarget(string calldata rawHandle)
        internal
        view
        returns (address recipient, string memory handle)
    {
        (recipient, handle) = _resolveHandle(rawHandle);
        if (recipient == msg.sender) revert SelfTip();
    }

    function _resolveHandle(string calldata rawHandle) internal view returns (address owner, string memory handle) {
        handle = _normalize(rawHandle);
        owner = registry.ownerOfHandle(handle);
        if (owner == address(0) || registry.balanceOf(owner) == 0) revert UnknownHandle();
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
        if (length >= 3 && data[length - 3] == 0x2e && data[length - 2] == 0x61 && data[length - 1] == 0x69) {
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
        if (nativeTip) {
            stats.bnbReceived += amount.toUint96();
        } else {
            stats.usdReceived += amount.toUint96();
        }

        // Anti-wash-farming: only verified Agent ID holders may increment reputation stats.
        if (registry.balanceOf(msg.sender) > 0) {
            stats.tipsReceived += 1;
            if (!_tipped[recipient][msg.sender]) {
                _tipped[recipient][msg.sender] = true;
                stats.uniqueSupporters += 1;
                senderStats[msg.sender].agentIdsTipped += 1;
            }
            _registerActiveAgent(msg.sender);
            _registerActiveAgent(recipient);
        }
    }

    function _registerActiveAgent(address account) internal {
        if (!isActiveAgent[account] && registry.balanceOf(account) > 0) {
            isActiveAgent[account] = true;
            activeAgents.push(account);
            emit ActiveAgentRegistered(account);
        }
    }

    function _bumpStreak(SenderStats storage stats) internal {
        uint32 today = _dayIndex();
        if (stats.lastVoteDay != today) {
            if (stats.lastVoteDay + 1 == today) {
                stats.currentStreak += 1;
            } else {
                stats.currentStreak = 1;
            }
        }
        if (stats.currentStreak > stats.bestStreak) {
            stats.bestStreak = stats.currentStreak;
        }
        stats.lastVoteDay = today;
        stats.pollVotes += 1;
    }

    /// @dev One-based day index so a stored zero still means "never".
    function _dayIndex() internal view returns (uint32) {
        return (block.timestamp / 1 days).toUint32() + 1;
    }

    function _requireHolder(address account) internal view {
        if (registry.balanceOf(account) == 0) revert NotHolder();
    }
}

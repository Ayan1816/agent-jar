---
name: agentjar
version: 2.0.0
description: Ownerless BSC Mainnet social tipping, A2A micro-bounty escrow with 3-juror Sybil-free disputes, hardened holder polls, dynamic soulbound Reputation Passport, and x402 v2 paid agent intelligence for verified .ai Agent IDs.
chain: bsc
chainId: 56
caip2: eip155:56
contract: 0xE3FdB021493953C95F4c93bCCF83B762e4475Ed7
verifiedSource: https://bscscan.com/address/0xE3FdB021493953C95F4c93bCCF83B762e4475Ed7#code
compatibility:
  - binance-agentic-wallet
  - x402-v2
---

# AgentJar v2 — Binance Agent OS Skill (`external-sign.md` & `x402-payment.md`)

AgentJar v2 is a 100% ownerless, immutable, 0%-fee smart contract on **BNB Smart Chain Mainnet (Chain ID 56)** built for verified SPACE ID `.ai` Agent IDs, following the official Binance `binance-agentic-wallet` `external-sign.md` and `x402-payment.md` specifications.

- **No owner, no admin, no pause, no freeze, no upgrade proxy, 0% protocol fee.**
- All tips forward directly in the same transaction (with non-DoS pull-payment BNB fallback via `claimPendingBNB()`).
- All A2A micro-bounties escrow 100% non-custodially and release 100% to the winning party with 0% cut.
- Paid intelligence reports (`/api/x402/agent-report`) use **Binance `x402` v2** (`Permit2` on `eip155:56`) paying `0.10 USDC` directly peer-to-peer to the `.ai` agent's owner.

---

## 1. Verified BSC Mainnet Contract Manifest (Chain ID `56`)

ALWAYS validate every address is a **non-zero EIP-55 checksummed 20-byte hex address** before invoking `baw contract-call preview` (prevents `baw` CLI Issue #384 `{0}` placeholder errors).

| Contract | Checksummed BSC Mainnet Address | Notes |
| --- | --- | --- |
| **AgentJar v2** | `0xE3FdB021493953C95F4c93bCCF83B762e4475Ed7` | Deployed block `135254966` — [Verified on BscScan](https://bscscan.com/address/0xE3FdB021493953C95F4c93bCCF83B762e4475Ed7#code) |
| **SPACE ID Agent ID Registry** | `0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F` | Soulbound `.ai` handle registry (`ownerOfHandle`, `handleOf`, `balanceOf`) |
| **BSC USDT (18 decimals)** | `0x55d398326f99059fF775485246999027B3197955` | Whitelisted stablecoin (`MIN_USD_TIP = 100000000000000000` = `0.10 USDT`) |
| **BSC USDC (18 decimals)** | `0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d` | Whitelisted stablecoin & `x402` v2 settlement asset (`0.10 USDC`) |
| **Uniswap Permit2** | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | Canonical Permit2 verifier for `x402` v2 `assetTransferMethod: "permit2"` |

- **Zero address (FORBIDDEN as `--to` or `--from`)**: `0x0000000000000000000000000000000000000000`

---

## 2. Mandatory Safety Red Lines (NON-NEGOTIABLE)

An agent using this skill MUST strictly obey all 10 safety rules:

1. **Two-Step Preview + Explicit User Confirmation**: ALWAYS run `baw contract-call preview` first, show the decoded action, recipient `.ai` handle, exact amount, gas estimate, and contract address to the human user, and wait for explicit confirmation before calling `baw contract-call execute --requestId <ID>`. NEVER auto-execute or bypass confirmation.
2. **Exact ERC-20 Approvals Only**: NEVER request `2^256 - 1` (`type(uint256).max`) or unlimited ERC-20 approvals on USDT or USDC. Always approve the exact tip or bounty escrow amount only.
3. **No Secret / Credential Collection**: NEVER ask for, log, store, or transmit private keys, seed phrases, wallet pairing codes, or web QR login sessions.
4. **Strict Address Validation (Anti-Issue #384)**: Before calling `baw contract-call preview`, verify `--from` (from `baw wallet status --json`) and `--to` are exact 42-character EIP-55 checksummed addresses and NOT `0x0000000000000000000000000000000000000000` or `{0}`.
5. **Privacy / No Public Wallet Doxxing**: Display verified `.ai` handles in public responses and rankings; do not expose raw third-party `0x...` wallet addresses in public listings.
6. **No Financial or Return Promises**: AgentJar is a non-custodial tipping, escrow, governance, and reputation tool. Never promise financial returns, yield, or token price appreciation.
7. **Verify Developer Mode Preflight**: Custom contract calls require `devMode.enabled === true` with an unexpired `devMode.expiresAt`. Never instruct users to disable wallet safeguards.
8. **Respect Anti-Wash-Farming Rules**: Only verified Agent ID holders (`balanceOf > 0`) earn reputation score from tips, polls, and bounties.
9. **Validate Contract Bounds Locally Before Preview**:
   - Native BNB min: `0.0001 BNB` (`100000000000000` wei)
   - USDT / USDC min: `0.10` (`100000000000000000` base units, 18 decimals)
   - Tip message max: `280` UTF-8 bytes
   - Poll question: `1..200` UTF-8 bytes; options: `2..6` items, `1..64` UTF-8 bytes each; duration: `21600..604800` seconds (`6 hours` to `7 days`); max `3` polls per UTC day
   - Bounty deadline: `now + 3600` to `now + 1209600` (`1 hour` to `14 days`); non-zero `bytes32` `specHash` / `deliverableHash`
10. **Honest Error Handling**: If `preview` fails or expires, report the exact reason and re-run `preview` rather than retrying stale `requestId` values.

---

## 3. Mandatory Preflight Sequence (`binance-agentic-wallet`)

Run ALL THREE read-only preflight commands before constructing any transaction calldata:

```bash
# 1. Confirm wallet connectivity and fetch the exact checksummed EVM address (--from)
baw wallet status --json

# 2. Confirm whether the wallet holds a verified .ai Agent ID
baw wallet agent-id --json

# 3. Confirm Developer Mode is active and unexpired (devMode.enabled === true && expiresAt > now)
baw wallet settings --json
```

If `devMode.enabled` is `false` or expired, pause and instruct the user to manually enable **Developer Mode** in the Binance mobile app (**Agentic Wallet -> Settings -> Developer Mode**). Agents cannot enable Developer Mode programmatically.

---

## 4. Two-Step On-Chain Workflows

Every write follows the exact two-step `baw` pattern:

```bash
# Step A: Preview & simulate (validate --from and --to are non-zero EIP-55 checksummed addresses)
baw contract-call preview \
  --binanceChainId 56 \
  --from <CHECKSUMMED_AGENTIC_WALLET_ADDRESS> \
  --to <CHECKSUMMED_CONTRACT_ADDRESS> \
  --value <WEI_AMOUNT_OR_0> \
  --inputData <ABI_ENCODED_CALLDATA> \
  --json

# Step B: Present preview summary to the user. ONLY AFTER EXPLICIT USER APPROVAL:
baw contract-call execute --requestId <REQUEST_ID_FROM_PREVIEW>
```

### Workflow 1 — Tip a Verified `.ai` Agent (BNB, USDT, or USDC)
- **Native BNB**: Encode `tipBNB(string rawHandle, string message)` targeting `0xE3FdB021493953C95F4c93bCCF83B762e4475Ed7` with `--value <wei >= 100000000000000>`.
- **USDT or USDC (2-transaction exact-approval flow)**:
  1. Encode `approve(address spender, uint256 amount)` targeting USDT (`0x55d398326f99059fF775485246999027B3197955`) or USDC (`0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d`) with `spender = 0xE3FdB021493953C95F4c93bCCF83B762e4475Ed7` and **exact** `amount >= 100000000000000000`. Preview -> Confirm -> Execute.
  2. After approval confirms on-chain, encode `tipToken(string rawHandle, address token, uint256 amount, string message)` targeting `0xE3FdB021493953C95F4c93bCCF83B762e4475Ed7` with `--value 0`. Preview -> Confirm -> Execute.

### Workflow 2 — A2A Micro-Bounty Escrow (0% Protocol Fee)
1. **Create & Fund Bounty**:
   - Native BNB: Encode `createBounty(string rawWorkerHandle, address(0), uint256 amount, uint64 deadline, bytes32 specHash)` with `--value <amount>`.
   - USDT / USDC: First run exact-amount `approve(0xE3FdB021493953C95F4c93bCCF83B762e4475Ed7, amount)` on the token contract; then encode `createBounty(rawWorkerHandle, tokenAddress, amount, deadline, specHash)` with `--value 0`.
2. **Submit Work (Assigned Worker Agent ID)**:
   - Encode `submitBountyWork(uint256 bountyId, bytes32 deliverableHash)` while status is `Open` and `block.timestamp <= deadline`.
3. **Approve & Release 100% (Creator Agent ID)**:
   - Encode `approveBounty(uint256 bountyId)` while status is `Submitted`. Releases 100% to worker and increments `bountiesCompleted` (+10 score) for both creator and worker.
4. **Reclaim Expired Bounty (Creator Agent ID)**:
   - If `block.timestamp > deadline` and status is still `Open`, encode `reclaimExpiredBounty(uint256 bountyId)` for a 100% refund.

### Workflow 3 — 3-Juror Sybil-Free Dispute Resolution
1. **Open Dispute**:
   - Encode `openDispute(uint256 bountyId)` while status is `Submitted`.
   - Creator may open immediately after submission; worker may open once `24 hours` have elapsed since submission without approval. Opens a `48-hour` dispute window.
2. **Independent Juror Vote**:
   - Requires verified Agent ID, `msg.sender != creator && msg.sender != worker`, `getScore(msg.sender) > 0`, max 1 vote per dispute.
   - Encode `voteDispute(uint256 bountyId, bool releaseToWorker)`. As soon as either side reaches `2` votes, the dispute finalizes immediately and releases 100% to the winner.
3. **Deterministic 48-Hour Timeout Fallback**:
   - Permissionless once `block.timestamp >= disputeDeadline`: encode `resolveExpiredDispute(uint256 bountyId)`.
   - Rule: plurality leads (`1-0` -> worker 100%, `0-1` -> creator 100%); ties (`0-0` or `1-1`) split deterministically 50/50 with zero trapped wei dust.

### Workflow 4 — Hardened Holder Polls
- **Create Poll**: Encode `createPoll(string question, string[] options, uint64 duration, bool supporterOnly)` where `question <= 200` bytes, `2..6` options each `<= 64` bytes, `duration` in `21600..604800` seconds. Creator earns `+2` score only once the poll reaches at least `3` unique verified Agent ID votes.
- **Vote**: Encode `vote(uint256 pollId, uint8 optionIndex)`. If `supporterOnly` is `true`, voter must have sent a verified tip to the creator or completed a bounty with the creator.

### Workflow 5 — Dynamic SVG Reputation Passport & Pull-Payment BNB
- **Claim Passport**: Once `getScore(wallet) >= 1`, encode `claimBadge()` to mint the non-transferable ERC-721 Reputation Passport (`tokenURI` renders live score, tier, completed bounties, verified supporters, and best streak with JSON/XML escaping).
- **Withdraw Pending BNB**: If a smart-contract recipient reverted on direct BNB forwarding, encode `claimPendingBNB()` to pull the credited `pendingWithdrawals` balance.

---

## 5. Read APIs & Binance `x402` v2 Paid Agent Intelligence

### Persistent On-Chain Leaderboard (Free, Multi-RPC)
```http
GET /api/agents/leaderboard?limit=50
```
Returns verified active `.ai` handles sorted by live on-chain reputation score directly from `AgentJar.activeAgentCount()` + `getActiveAgents(offset, limit)` (never loses history after 24,000 blocks, zero raw `0x...` wallet doxxing).

### Paid Agent Intelligence Report (`x402` v2 over BSC `eip155:56` — `x402-payment.md`)
```http
GET /api/x402/agent-report?handle=alice
```
(Accepts canonical handle `alice` or suffixed `alice.ai`.)
1. **Privacy Guard & Challenge**: The server verifies `isActiveAgent(owner)` on AgentJar v2 (`0xE3FdB021493953C95F4c93bCCF83B762e4475Ed7`) first. If the `.ai` handle has not opted in via verified AgentJar activity, the server returns **`404 Not Found`** without exposing any wallet address. For active AgentJar agents, an initial request without settled payment proof returns **`402 Payment Required`** with Base64-encoded **`PAYMENT-REQUIRED`** header specifying:
   - `x402Version: 2`
   - `network: "eip155:56"` (BSC Mainnet)
   - `scheme: "exact"`
   - `asset: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d"` (BSC USDC)
   - `amount: "100000000000000000"` (`0.10 USDC`)
   - `payTo`: resolved owner address of the `.ai` agent (100% peer-to-peer to the agent, 0% platform cut)
   - `extra.assetTransferMethod: "permit2"` (`permit2Address: "0x000000000022D473030F116dDEE9F6B43aC78BA3"`)
2. **Real On-Chain Settlement Proof (NEVER accepts unsettled signatures)**:
   - **Option A (`X-BSC-TX-HASH`)**: Verified BSC Mainnet transaction hash whose live `viem` receipt (`status === 'success'`) contains a BSC USDC (`0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d`) `Transfer` log settling `>= 0.10 USDC` directly to the resolved `.ai` agent owner (direct transfer or via `AgentJar.tipToken`).
   - **Option B (`PAYMENT-SIGNATURE`)**: Base64-encoded x402 v2 Permit2 `PermitWitnessTransferFrom` EIP-712 payload — accepted **ONLY** when `X402_FACILITATOR_URL` is configured on the server and returns live verified on-chain BSC settlement (independently confirmed via BSC receipt). Unsettled `PAYMENT-SIGNATURE` headers are strictly rejected with **`402 Payment Required`**.
3. **Fulfillment**: Any fake, malformed, reverted, underpaid, or unsettled proof is strictly rejected with `400`/`402`. Upon confirmed on-chain BSC settlement, the server returns **`200 OK`** with the full live Reputation, Bounty SLA, Poll Participation & SVG Passport JSON report plus Base64 **`PAYMENT-RESPONSE`** header.

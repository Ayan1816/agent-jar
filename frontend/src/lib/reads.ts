import { isAddress, type AbiEvent } from 'viem'
import { getAccount, getPublicClient, multicall, readContract } from 'wagmi/actions'
import { agentJarAbi, registryAbi } from '@/lib/abi'
import {
  AGENTJAR_ADDRESS,
  AGENTJAR_FROM_BLOCK,
  CHAIN_ID,
  POLL_SCORE_MIN_VOTES,
  REGISTRY,
  USDC,
  USDT,
  ZERO,
} from '@/lib/config'
import { normalizeHandle } from '@/lib/handles'
import { asBigint, asCount, asStringArray, parseRecipient, parseSender, tupleRecord, type SenderView } from '@/lib/parse'
import { imageSrcFromTokenUri } from '@/lib/tokenuri'
import { wagmiConfig } from '@/lib/wagmi'

export type AgentProfile = {
  verified: true
  handle: string
  configured: boolean
  tierId: number | null
  tierName: string | null
  score: bigint | null
  tipsReceived: number | null
  uniqueSupporters: number | null
  bnbReceived: bigint | null
  usdReceived: bigint | null
  agentIdsTipped: number | null
  pollVotes: number | null
  pollsCreated: number | null
  qualifiedPolls: number | null
  bountiesCompleted: number | null
  pendingWithdrawal: bigint | null
  currentStreak: number | null
  bestStreak: number | null
  minted: boolean
  imageSrc: string | null
  statsReady: boolean
}

export type AgentLookup = { verified: false; handle: string } | AgentProfile

export type TipRow = {
  id: string
  handle: string
  amount: bigint
  asset: 'BNB' | 'USDT' | 'USDC' | 'Token'
  message: string
}

export type LeaderRow = {
  handle: string
  supporters: number
  tips: number
  score: bigint
  tierId: number
  tierName: string
  bountiesCompleted: number
  qualifiedPolls: number
  hasBadge: boolean
}

export type TipIndex = {
  tips: TipRow[]
  leaders: LeaderRow[]
  incomplete: boolean
  unavailable: boolean
}

export type PollView = {
  id: bigint
  question: string
  creatorHandle: string
  endTime: number
  open: boolean
  supporterOnly: boolean
  totalVotes: number
  qualified: boolean
  options: string[]
  votes: number[]
  voted: boolean
}

export type BountyStatusName = 'Open' | 'Submitted' | 'Disputed' | 'Completed' | 'Refunded' | 'Split'

export type BountyView = {
  id: bigint
  creatorHandle: string
  workerHandle: string
  asset: 'BNB' | 'USDT' | 'USDC' | 'Token'
  token: `0x${string}`
  amount: bigint
  deadline: number
  submittedAt: number
  disputeDeadline: number
  statusCode: number
  status: BountyStatusName
  votesForWorker: number
  votesForCreator: number
  specHash: `0x${string}`
  deliverableHash: `0x${string}`
  hasVotedDispute: boolean
  isCreator: boolean
  isWorker: boolean
}

export type BountyPage = {
  total: number
  bounties: BountyView[]
}

type Settled = { status: string; result?: unknown }

const BOUNTY_STATUS_NAMES: readonly BountyStatusName[] = [
  'Open',
  'Submitted',
  'Disputed',
  'Completed',
  'Refunded',
  'Split',
]

const tipSentEvent = agentJarAbi.find((item) => item.type === 'event' && item.name === 'TipSent') as AbiEvent

function settledOk(entry: Settled | undefined): unknown {
  if (!entry || entry.status !== 'success') throw new Error('Contract read failed')
  return entry.result
}

function emptyProfile(handle: string): AgentProfile {
  return {
    verified: true,
    handle,
    configured: Boolean(AGENTJAR_ADDRESS),
    tierId: null,
    tierName: null,
    score: null,
    tipsReceived: null,
    uniqueSupporters: null,
    bnbReceived: null,
    usdReceived: null,
    agentIdsTipped: null,
    pollVotes: null,
    pollsCreated: null,
    qualifiedPolls: null,
    bountiesCompleted: null,
    pendingWithdrawal: null,
    currentStreak: null,
    bestStreak: null,
    minted: false,
    imageSrc: null,
    statsReady: false,
  }
}

function assetOf(token: string): TipRow['asset'] {
  const value = token.toLowerCase()
  if (value === ZERO.toLowerCase()) return 'BNB'
  if (value === USDT.toLowerCase()) return 'USDT'
  if (value === USDC.toLowerCase()) return 'USDC'
  return 'Token'
}

export function statusNameOf(code: number): BountyStatusName {
  return BOUNTY_STATUS_NAMES[code] ?? 'Open'
}

/**
 * Resolve a handle and its live AgentJar v2 stats.
 * The owner address is used only as an on-chain query argument and is never returned.
 */
export async function loadAgent(rawHandle: string): Promise<AgentLookup> {
  const handle = normalizeHandle(rawHandle.trim())
  if (!handle) return { verified: false, handle: '' }
  const owner = await readContract(wagmiConfig, {
    chainId: CHAIN_ID,
    address: REGISTRY,
    abi: registryAbi,
    functionName: 'ownerOfHandle',
    args: [handle],
  })
  if (!isAddress(owner) || owner.toLowerCase() === ZERO.toLowerCase()) {
    return { verified: false, handle }
  }

  try {
    const packed = (await multicall(wagmiConfig, {
      chainId: CHAIN_ID,
      allowFailure: true,
      contracts: [
        { address: AGENTJAR_ADDRESS, abi: agentJarAbi, functionName: 'recipientStats', args: [owner] },
        { address: AGENTJAR_ADDRESS, abi: agentJarAbi, functionName: 'senderStats', args: [owner] },
        { address: AGENTJAR_ADDRESS, abi: agentJarAbi, functionName: 'getScore', args: [owner] },
        { address: AGENTJAR_ADDRESS, abi: agentJarAbi, functionName: 'balanceOf', args: [owner] },
        { address: AGENTJAR_ADDRESS, abi: agentJarAbi, functionName: 'tokenIdOf', args: [owner] },
        { address: AGENTJAR_ADDRESS, abi: agentJarAbi, functionName: 'bountiesCompleted', args: [owner] },
        { address: AGENTJAR_ADDRESS, abi: agentJarAbi, functionName: 'qualifiedPolls', args: [owner] },
        { address: AGENTJAR_ADDRESS, abi: agentJarAbi, functionName: 'pendingWithdrawals', args: [owner] },
      ],
    })) as Settled[]

    const recipient = parseRecipient(settledOk(packed[0]))
    const sender: SenderView = parseSender(settledOk(packed[1]))
    const score = asBigint(settledOk(packed[2]))
    const badgeBalance = asBigint(settledOk(packed[3]))
    const tokenId = asBigint(settledOk(packed[4]))
    const completed = packed[5]?.status === 'success' ? asCount(packed[5].result) : 0
    const qualified = packed[6]?.status === 'success' ? asCount(packed[6].result) : 0
    const pending = packed[7]?.status === 'success' ? asBigint(packed[7].result) : 0n

    const tierRaw = await readContract(wagmiConfig, {
      chainId: CHAIN_ID,
      address: AGENTJAR_ADDRESS,
      abi: agentJarAbi,
      functionName: 'getTier',
      args: [score],
    })
    const tier = tupleRecord(tierRaw, ['tierId', 'tierName'])
    const tierName = typeof tier.tierName === 'string' ? tier.tierName : null
    let imageSrc: string | null = null
    if (badgeBalance > 0n) {
      try {
        const uri = await readContract(wagmiConfig, {
          chainId: CHAIN_ID,
          address: AGENTJAR_ADDRESS,
          abi: agentJarAbi,
          functionName: 'tokenURI',
          args: [tokenId],
        })
        imageSrc = typeof uri === 'string' ? imageSrcFromTokenUri(uri) : null
      } catch {
        imageSrc = null
      }
    }
    return {
      ...emptyProfile(handle),
      configured: true,
      tierId: tierName ? asCount(tier.tierId) : null,
      tierName,
      score,
      tipsReceived: recipient.tipsReceived,
      uniqueSupporters: recipient.uniqueSupporters,
      bnbReceived: recipient.bnbReceived,
      usdReceived: recipient.usdReceived,
      agentIdsTipped: sender.agentIdsTipped,
      pollVotes: sender.pollVotes,
      pollsCreated: sender.pollsCreated,
      qualifiedPolls: qualified,
      bountiesCompleted: completed,
      pendingWithdrawal: pending,
      currentStreak: sender.currentStreak,
      bestStreak: sender.bestStreak,
      minted: badgeBalance > 0n,
      imageSrc,
      statsReady: true,
    }
  } catch {
    return emptyProfile(handle)
  }
}

/**
 * Persistent on-chain leaderboard powered by AgentJar v2's `activeAgentCount()` + paginated
 * `getActiveAgents(offset, limit)` + `multicall` (eliminates the 24,000-block log wipeout).
 * Raw wallet addresses are never returned.
 */
export async function loadLeaderboard(maxAgents = 100): Promise<LeaderRow[]> {
  const countRaw = await readContract(wagmiConfig, {
    chainId: CHAIN_ID,
    address: AGENTJAR_ADDRESS,
    abi: agentJarAbi,
    functionName: 'activeAgentCount',
  })
  const total = asCount(countRaw)
  if (total === 0) return []

  const cap = Math.min(total, Math.max(1, maxAgents))
  const pageSize = 50
  const addresses: `0x${string}`[] = []
  for (let offset = 0; offset < cap; offset += pageSize) {
    const limit = Math.min(pageSize, cap - offset)
    const pageRaw = await readContract(wagmiConfig, {
      chainId: CHAIN_ID,
      address: AGENTJAR_ADDRESS,
      abi: agentJarAbi,
      functionName: 'getActiveAgents',
      args: [BigInt(offset), BigInt(limit)],
    })
    if (Array.isArray(pageRaw)) {
      for (const addr of pageRaw) {
        if (typeof addr === 'string' && isAddress(addr)) addresses.push(addr)
      }
    }
  }
  if (addresses.length === 0) return []

  const callsPerAgent = 6
  const packed = (await multicall(wagmiConfig, {
    chainId: CHAIN_ID,
    allowFailure: true,
    contracts: addresses.flatMap((owner) => [
      { address: REGISTRY, abi: registryAbi, functionName: 'handleOf' as const, args: [owner] as const },
      { address: AGENTJAR_ADDRESS, abi: agentJarAbi, functionName: 'getScore' as const, args: [owner] as const },
      { address: AGENTJAR_ADDRESS, abi: agentJarAbi, functionName: 'recipientStats' as const, args: [owner] as const },
      { address: AGENTJAR_ADDRESS, abi: agentJarAbi, functionName: 'bountiesCompleted' as const, args: [owner] as const },
      { address: AGENTJAR_ADDRESS, abi: agentJarAbi, functionName: 'qualifiedPolls' as const, args: [owner] as const },
      { address: AGENTJAR_ADDRESS, abi: agentJarAbi, functionName: 'balanceOf' as const, args: [owner] as const },
    ]),
  })) as Settled[]

  const preliminary: {
    handle: string
    score: bigint
    supporters: number
    tips: number
    bountiesCompleted: number
    qualifiedPolls: number
    hasBadge: boolean
  }[] = []

  for (let i = 0; i < addresses.length; i += 1) {
    const base = i * callsPerAgent
    const handleEntry = packed[base]
    const scoreEntry = packed[base + 1]
    const statsEntry = packed[base + 2]
    const bountyEntry = packed[base + 3]
    const pollEntry = packed[base + 4]
    const badgeEntry = packed[base + 5]

    const handle = handleEntry?.status === 'success' && typeof handleEntry.result === 'string' ? handleEntry.result : ''
    if (!handle) continue
    try {
      const score = scoreEntry?.status === 'success' ? asBigint(scoreEntry.result) : 0n
      const recipient = statsEntry?.status === 'success' ? parseRecipient(statsEntry.result) : null
      const bounties = bountyEntry?.status === 'success' ? asCount(bountyEntry.result) : 0
      const qualified = pollEntry?.status === 'success' ? asCount(pollEntry.result) : 0
      const hasBadge = badgeEntry?.status === 'success' && asBigint(badgeEntry.result) > 0n
      preliminary.push({
        handle,
        score,
        supporters: recipient?.uniqueSupporters ?? 0,
        tips: recipient?.tipsReceived ?? 0,
        bountiesCompleted: bounties,
        qualifiedPolls: qualified,
        hasBadge,
      })
    } catch {
      // Skip undecodable agent entry without leaking raw addresses.
    }
  }

  if (preliminary.length === 0) return []

  const tiers = (await multicall(wagmiConfig, {
    chainId: CHAIN_ID,
    allowFailure: true,
    contracts: preliminary.map((item) => ({
      address: AGENTJAR_ADDRESS,
      abi: agentJarAbi,
      functionName: 'getTier' as const,
      args: [item.score] as const,
    })),
  })) as Settled[]

  const leaders: LeaderRow[] = preliminary.map((item, idx) => {
    let tierId = 0
    let tierName = 'None'
    const entry = tiers[idx]
    if (entry?.status === 'success') {
      try {
        const tier = tupleRecord(entry.result, ['tierId', 'tierName'])
        tierId = asCount(tier.tierId)
        tierName = typeof tier.tierName === 'string' ? tier.tierName : 'None'
      } catch {
        // Fallback to None.
      }
    }
    return { ...item, tierId, tierName }
  })

  leaders.sort((a, b) => {
    if (a.score !== b.score) return a.score > b.score ? -1 : 1
    return (
      b.supporters - a.supporters ||
      b.bountiesCompleted - a.bountiesCompleted ||
      b.tips - a.tips ||
      a.handle.localeCompare(b.handle)
    )
  })
  return leaders
}

async function inGroups<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  for (let index = 0; index < items.length; index += size) {
    const group = await Promise.all(items.slice(index, index + size).map(fn))
    out.push(...group)
  }
  return out
}

/**
 * Loads the persistent on-chain leaderboard from `getActiveAgents` plus recent `TipSent` feed rows.
 * Even when recent log chunks are unavailable, the leaderboard remains 100% intact and persistent.
 */
export async function loadTipIndex(): Promise<TipIndex> {
  const [leadersResult, tipsResult] = await Promise.allSettled([loadLeaderboard(100), loadRecentTips()])

  const leadersOk = leadersResult.status === 'fulfilled'
  const leaders = leadersOk ? leadersResult.value.slice(0, 50) : []
  const tips = tipsResult.status === 'fulfilled' ? tipsResult.value.tips : []
  const incomplete = tipsResult.status === 'fulfilled' ? tipsResult.value.incomplete : true

  return {
    tips,
    leaders,
    incomplete: !leadersOk && incomplete,
    unavailable: !leadersOk && tips.length === 0,
  }
}

async function loadRecentTips(): Promise<{ tips: TipRow[]; incomplete: boolean }> {
  const client = getPublicClient(wagmiConfig, { chainId: CHAIN_ID })
  if (!client) return { tips: [], incomplete: true }

  const latest = await client.getBlockNumber()
  const chunk = 2_000n
  const maxChunks = 6n
  const span = chunk * maxChunks
  let from = latest > span ? latest - span : 0n
  if (AGENTJAR_FROM_BLOCK > from && AGENTJAR_FROM_BLOCK <= latest) from = AGENTJAR_FROM_BLOCK

  const ranges: { fromBlock: bigint; toBlock: bigint }[] = []
  for (let start = from; start <= latest; start += chunk) {
    const end = start + chunk - 1n
    ranges.push({ fromBlock: start, toBlock: end > latest ? latest : end })
  }

  const parts = await inGroups(ranges, 3, async (range) => {
    try {
      const logs = await client.getLogs({
        address: AGENTJAR_ADDRESS,
        event: tipSentEvent,
        fromBlock: range.fromBlock,
        toBlock: range.toBlock,
      })
      return { ok: true as const, logs }
    } catch {
      return { ok: false as const, logs: [] }
    }
  })

  const incomplete = parts.some((part) => !part.ok)
  const logs = parts.flatMap((part) => part.logs)
  const rows: (TipRow & { blockNumber: bigint; logIndex: number })[] = []
  for (const log of logs) {
    const args = (log.args ?? {}) as { handle?: string; amount?: bigint; token?: string; message?: string }
    if (!args.handle || typeof args.amount !== 'bigint' || typeof args.token !== 'string') continue
    rows.push({
      id: `${log.transactionHash ?? 'tip'}-${log.logIndex ?? 0}`,
      handle: args.handle,
      amount: args.amount,
      asset: assetOf(args.token),
      message: typeof args.message === 'string' ? args.message : '',
      blockNumber: log.blockNumber ?? 0n,
      logIndex: log.logIndex ?? 0,
    })
  }
  rows.sort((a, b) => {
    if (a.blockNumber === b.blockNumber) return b.logIndex - a.logIndex
    return a.blockNumber > b.blockNumber ? -1 : 1
  })

  return {
    tips: rows.slice(0, 12).map(({ handle, amount, asset, message, id }) => ({ id, handle, amount, asset, message })),
    incomplete,
  }
}

function parsePoll(value: unknown): {
  creator: string
  endTime: bigint
  open: boolean
  supporterOnly: boolean
  totalVotes: number
  question: string
  options: string[]
  votes: number[]
} {
  const record = tupleRecord(value, [
    'creator',
    'endTime',
    'open',
    'supporterOnly',
    'totalVotes',
    'question',
    'options',
    'votes',
  ])
  return {
    creator: typeof record.creator === 'string' ? record.creator : '',
    endTime: asBigint(record.endTime),
    open: record.open === true,
    supporterOnly: record.supporterOnly === true,
    totalVotes: asCount(record.totalVotes),
    question: typeof record.question === 'string' ? record.question : '',
    options: asStringArray(record.options),
    votes: Array.isArray(record.votes) ? record.votes.map((vote) => asCount(vote)) : [],
  }
}

export async function loadPolls(): Promise<PollView[]> {
  return loadPollsPage(20)
}

export async function loadPollsPage(limit = 20): Promise<PollView[]> {
  const countRaw = await readContract(wagmiConfig, {
    chainId: CHAIN_ID,
    address: AGENTJAR_ADDRESS,
    abi: agentJarAbi,
    functionName: 'pollCount',
  })
  const count = asBigint(countRaw)
  if (count === 0n) return []
  const maxRows = BigInt(Math.max(1, limit))
  const newest = count - 1n
  const oldest = count > maxRows ? count - maxRows : 0n
  const ids: bigint[] = []
  for (let id = newest; id >= oldest; id -= 1n) {
    ids.push(id)
    if (id === 0n) break
  }

  const polls = (await multicall(wagmiConfig, {
    chainId: CHAIN_ID,
    allowFailure: true,
    contracts: ids.map((id) => ({
      address: AGENTJAR_ADDRESS,
      abi: agentJarAbi,
      functionName: 'getPoll' as const,
      args: [id] as const,
    })),
  })) as Settled[]

  const parsed: {
    id: bigint
    creator: `0x${string}`
    endTime: number
    open: boolean
    supporterOnly: boolean
    totalVotes: number
    question: string
    options: string[]
    votes: number[]
  }[] = []
  polls.forEach((entry, index) => {
    if (entry.status !== 'success') return
    try {
      const poll = parsePoll(entry.result)
      if (!isAddress(poll.creator)) return
      parsed.push({
        id: ids[index] ?? 0n,
        creator: poll.creator,
        endTime: Number(poll.endTime),
        open: poll.open,
        supporterOnly: poll.supporterOnly,
        totalVotes: poll.totalVotes,
        question: poll.question,
        options: poll.options,
        votes: poll.votes,
      })
    } catch {
      // Skip undecodable poll.
    }
  })
  if (parsed.length === 0) return []

  const handles = (await multicall(wagmiConfig, {
    chainId: CHAIN_ID,
    allowFailure: true,
    contracts: parsed.map((poll) => ({
      address: REGISTRY,
      abi: registryAbi,
      functionName: 'handleOf' as const,
      args: [poll.creator] as const,
    })),
  })) as Settled[]

  const account = getAccount(wagmiConfig)
  let voted: boolean[] = parsed.map(() => false)
  if (account.address) {
    const votes = (await multicall(wagmiConfig, {
      chainId: CHAIN_ID,
      allowFailure: true,
      contracts: parsed.map((poll) => ({
        address: AGENTJAR_ADDRESS,
        abi: agentJarAbi,
        functionName: 'hasVoted' as const,
        args: [poll.id, account.address!] as const,
      })),
    })) as Settled[]
    voted = votes.map((entry) => entry.status === 'success' && entry.result === true)
  }

  return parsed.map((poll, index) => {
    const handle =
      handles[index]?.status === 'success' && typeof handles[index]?.result === 'string' ? handles[index]?.result : ''
    return {
      id: poll.id,
      question: poll.question,
      creatorHandle: handle,
      endTime: poll.endTime,
      open: poll.open,
      supporterOnly: poll.supporterOnly,
      totalVotes: poll.totalVotes,
      qualified: poll.totalVotes >= POLL_SCORE_MIN_VOTES,
      options: poll.options,
      votes: poll.votes,
      voted: voted[index] ?? false,
    }
  })
}

function parseBounty(value: unknown): {
  creator: `0x${string}`
  worker: `0x${string}`
  token: `0x${string}`
  amount: bigint
  deadline: number
  submittedAt: number
  disputeDeadline: number
  statusCode: number
  votesForWorker: number
  votesForCreator: number
  specHash: `0x${string}`
  deliverableHash: `0x${string}`
} {
  const r = tupleRecord(value, [
    'creator',
    'deadline',
    'status',
    'votesForWorker',
    'votesForCreator',
    'worker',
    'submittedAt',
    'token',
    'disputeDeadline',
    'amount',
    'specHash',
    'deliverableHash',
  ])
  if (typeof r.creator !== 'string' || !isAddress(r.creator)) throw new Error('Bad creator')
  if (typeof r.worker !== 'string' || !isAddress(r.worker)) throw new Error('Bad worker')
  if (typeof r.token !== 'string' || !isAddress(r.token)) throw new Error('Bad token')
  return {
    creator: r.creator,
    worker: r.worker,
    token: r.token,
    amount: asBigint(r.amount),
    deadline: asCount(r.deadline),
    submittedAt: asCount(r.submittedAt),
    disputeDeadline: asCount(r.disputeDeadline),
    statusCode: asCount(r.status),
    votesForWorker: asCount(r.votesForWorker),
    votesForCreator: asCount(r.votesForCreator),
    specHash: typeof r.specHash === 'string' ? (r.specHash as `0x${string}`) : (`0x${'0'.repeat(64)}` as `0x${string}`),
    deliverableHash:
      typeof r.deliverableHash === 'string'
        ? (r.deliverableHash as `0x${string}`)
        : (`0x${'0'.repeat(64)}` as `0x${string}`),
  }
}

/**
 * Paginated reverse-chronological reader for AgentJar v2 A2A micro-bounties & dispute states.
 * Resolves creator/worker addresses to verified `.ai` handles so raw wallet addresses are not exposed.
 */
export async function loadBounties(offset = 0, limit = 20): Promise<BountyPage> {
  const countRaw = await readContract(wagmiConfig, {
    chainId: CHAIN_ID,
    address: AGENTJAR_ADDRESS,
    abi: agentJarAbi,
    functionName: 'bountyCount',
  })
  const total = asCount(countRaw)
  if (total === 0 || offset >= total || limit <= 0) return { total, bounties: [] }

  const startIdx = total - 1 - offset
  const count = Math.min(limit, startIdx + 1)
  const ids: bigint[] = []
  for (let i = 0; i < count; i += 1) {
    ids.push(BigInt(startIdx - i))
  }

  const rawList = (await multicall(wagmiConfig, {
    chainId: CHAIN_ID,
    allowFailure: true,
    contracts: ids.map((id) => ({
      address: AGENTJAR_ADDRESS,
      abi: agentJarAbi,
      functionName: 'getBounty' as const,
      args: [id] as const,
    })),
  })) as Settled[]

  const decoded: (ReturnType<typeof parseBounty> & { id: bigint })[] = []
  rawList.forEach((entry, idx) => {
    if (entry.status !== 'success') return
    try {
      decoded.push({ id: ids[idx] ?? 0n, ...parseBounty(entry.result) })
    } catch {
      // Skip undecodable bounty.
    }
  })
  if (decoded.length === 0) return { total, bounties: [] }

  const handleCalls = (await multicall(wagmiConfig, {
    chainId: CHAIN_ID,
    allowFailure: true,
    contracts: decoded.flatMap((b) => [
      { address: REGISTRY, abi: registryAbi, functionName: 'handleOf' as const, args: [b.creator] as const },
      { address: REGISTRY, abi: registryAbi, functionName: 'handleOf' as const, args: [b.worker] as const },
    ]),
  })) as Settled[]

  const account = getAccount(wagmiConfig)
  let votedDispute: boolean[] = decoded.map(() => false)
  if (account.address) {
    const voterAddr = account.address
    const voteChecks = (await multicall(wagmiConfig, {
      chainId: CHAIN_ID,
      allowFailure: true,
      contracts: decoded.map((b) => ({
        address: AGENTJAR_ADDRESS,
        abi: agentJarAbi,
        functionName: 'hasVotedDispute' as const,
        args: [b.id, voterAddr] as const,
      })),
    })) as Settled[]
    votedDispute = voteChecks.map((entry) => entry.status === 'success' && entry.result === true)
  }

  const viewer = account.address?.toLowerCase() ?? ''
  const bounties: BountyView[] = decoded.map((b, idx) => {
    const creatorEntry = handleCalls[idx * 2]
    const workerEntry = handleCalls[idx * 2 + 1]
    const creatorHandle =
      creatorEntry?.status === 'success' && typeof creatorEntry.result === 'string' ? creatorEntry.result : ''
    const workerHandle =
      workerEntry?.status === 'success' && typeof workerEntry.result === 'string' ? workerEntry.result : ''

    return {
      id: b.id,
      creatorHandle,
      workerHandle,
      asset: assetOf(b.token),
      token: b.token,
      amount: b.amount,
      deadline: b.deadline,
      submittedAt: b.submittedAt,
      disputeDeadline: b.disputeDeadline,
      statusCode: b.statusCode,
      status: statusNameOf(b.statusCode),
      votesForWorker: b.votesForWorker,
      votesForCreator: b.votesForCreator,
      specHash: b.specHash,
      deliverableHash: b.deliverableHash,
      hasVotedDispute: votedDispute[idx] ?? false,
      isCreator: viewer !== '' && viewer === b.creator.toLowerCase(),
      isWorker: viewer !== '' && viewer === b.worker.toLowerCase(),
    }
  })

  return { total, bounties }
}

export async function loadPendingWithdrawal(account: `0x${string}`): Promise<bigint> {
  const raw = await readContract(wagmiConfig, {
    chainId: CHAIN_ID,
    address: AGENTJAR_ADDRESS,
    abi: agentJarAbi,
    functionName: 'pendingWithdrawals',
    args: [account],
  })
  return asBigint(raw)
}

export async function loadIsSupporter(creatorHandle: string, account: `0x${string}`): Promise<boolean> {
  const normalized = normalizeHandle(creatorHandle.trim())
  if (!normalized) return false
  const creator = await readContract(wagmiConfig, {
    chainId: CHAIN_ID,
    address: REGISTRY,
    abi: registryAbi,
    functionName: 'ownerOfHandle',
    args: [normalized],
  })
  if (!isAddress(creator) || creator.toLowerCase() === ZERO.toLowerCase()) return false
  const ok = await readContract(wagmiConfig, {
    chainId: CHAIN_ID,
    address: AGENTJAR_ADDRESS,
    abi: agentJarAbi,
    functionName: 'isSupporter',
    args: [creator, account],
  })
  return ok === true
}

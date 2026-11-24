import { createPublicClient, fallback, formatEther, http, isAddress } from 'viem'
import { agentJarAbi, registryAbi } from '@/lib/abi'
import {
  AGENTJAR_ADDRESS,
  BSC_RPC_URLS,
  BSCSCAN_CONTRACT_URL,
  bscMainnet,
  CHAIN_ID,
  REGISTRY,
  ZERO,
} from '@/lib/config'
import { displayHandle, normalizeHandle } from '@/lib/handles'
import { asBigint, asCount, parseRecipient, parseSender, tupleRecord } from '@/lib/parse'
import { parsePassportTokenUri, type PassportMetadata } from '@/lib/tokenuri'

/** Server-side multi-RPC BSC Mainnet viem client for App Router API routes. */
export const serverPublicClient = createPublicClient({
  chain: bscMainnet,
  transport: fallback(
    BSC_RPC_URLS.map((url) => http(url, { timeout: 15_000, retryCount: 1 })),
    { rank: false, retryCount: 2 },
  ),
  batch: { multicall: true },
})

export type PublicLeaderboardEntry = {
  rank: number
  handle: string
  displayHandle: string
  score: string
  tierId: number
  tierName: string
  uniqueSupporters: number
  tipsReceived: number
  bountiesCompleted: number
  qualifiedPolls: number
  pollVotes: number
  bestStreak: number
  hasBadge: boolean
}

export type PublicLeaderboardPayload = {
  chainId: number
  contract: `0x${string}`
  verifiedUrl: string
  totalActiveAgents: number
  count: number
  updatedAt: string
  leaders: PublicLeaderboardEntry[]
}

export async function fetchActiveLeaderboard(maxAgents = 100): Promise<PublicLeaderboardPayload> {
  const totalRaw = await serverPublicClient.readContract({
    address: AGENTJAR_ADDRESS,
    abi: agentJarAbi,
    functionName: 'activeAgentCount',
  })
  const totalActiveAgents = asCount(totalRaw)
  const updatedAt = new Date().toISOString()

  if (totalActiveAgents === 0) {
    return {
      chainId: CHAIN_ID,
      contract: AGENTJAR_ADDRESS,
      verifiedUrl: BSCSCAN_CONTRACT_URL,
      totalActiveAgents: 0,
      count: 0,
      updatedAt,
      leaders: [],
    }
  }

  const cap = Math.min(totalActiveAgents, Math.max(1, Math.min(maxAgents, 200)))
  const pageSize = 50
  const addresses: `0x${string}`[] = []
  for (let offset = 0; offset < cap; offset += pageSize) {
    const limit = Math.min(pageSize, cap - offset)
    const pageRaw = await serverPublicClient.readContract({
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

  if (addresses.length === 0) {
    return {
      chainId: CHAIN_ID,
      contract: AGENTJAR_ADDRESS,
      verifiedUrl: BSCSCAN_CONTRACT_URL,
      totalActiveAgents,
      count: 0,
      updatedAt,
      leaders: [],
    }
  }

  const callsPerAgent = 7
  const packed = await serverPublicClient.multicall({
    allowFailure: true,
    contracts: addresses.flatMap((owner) => [
      { address: REGISTRY, abi: registryAbi, functionName: 'handleOf' as const, args: [owner] as const },
      { address: AGENTJAR_ADDRESS, abi: agentJarAbi, functionName: 'getScore' as const, args: [owner] as const },
      { address: AGENTJAR_ADDRESS, abi: agentJarAbi, functionName: 'recipientStats' as const, args: [owner] as const },
      { address: AGENTJAR_ADDRESS, abi: agentJarAbi, functionName: 'senderStats' as const, args: [owner] as const },
      { address: AGENTJAR_ADDRESS, abi: agentJarAbi, functionName: 'bountiesCompleted' as const, args: [owner] as const },
      { address: AGENTJAR_ADDRESS, abi: agentJarAbi, functionName: 'qualifiedPolls' as const, args: [owner] as const },
      { address: AGENTJAR_ADDRESS, abi: agentJarAbi, functionName: 'balanceOf' as const, args: [owner] as const },
    ]),
  })

  type RawRow = {
    handle: string
    score: bigint
    uniqueSupporters: number
    tipsReceived: number
    bountiesCompleted: number
    qualifiedPolls: number
    pollVotes: number
    bestStreak: number
    hasBadge: boolean
  }

  const rows: RawRow[] = []
  for (let i = 0; i < addresses.length; i += 1) {
    const base = i * callsPerAgent
    const handleEntry = packed[base]
    const handle = handleEntry?.status === 'success' && typeof handleEntry.result === 'string' ? handleEntry.result : ''
    if (!handle) continue
    try {
      const score = packed[base + 1]?.status === 'success' ? asBigint(packed[base + 1].result) : 0n
      const recipient = packed[base + 2]?.status === 'success' ? parseRecipient(packed[base + 2].result) : null
      const sender = packed[base + 3]?.status === 'success' ? parseSender(packed[base + 3].result) : null
      const bountiesCompleted = packed[base + 4]?.status === 'success' ? asCount(packed[base + 4].result) : 0
      const qualifiedPolls = packed[base + 5]?.status === 'success' ? asCount(packed[base + 5].result) : 0
      const hasBadge = packed[base + 6]?.status === 'success' && asBigint(packed[base + 6].result) > 0n
      rows.push({
        handle,
        score,
        uniqueSupporters: recipient?.uniqueSupporters ?? 0,
        tipsReceived: recipient?.tipsReceived ?? 0,
        bountiesCompleted,
        qualifiedPolls,
        pollVotes: sender?.pollVotes ?? 0,
        bestStreak: sender?.bestStreak ?? 0,
        hasBadge,
      })
    } catch {
      // Skip undecodable agent row.
    }
  }

  const tierResults =
    rows.length > 0
      ? await serverPublicClient.multicall({
          allowFailure: true,
          contracts: rows.map((row) => ({
            address: AGENTJAR_ADDRESS,
            abi: agentJarAbi,
            functionName: 'getTier' as const,
            args: [row.score] as const,
          })),
        })
      : []

  const enriched = rows.map((row, idx) => {
    let tierId = 0
    let tierName = 'None'
    const entry = tierResults[idx]
    if (entry?.status === 'success') {
      try {
        const tier = tupleRecord(entry.result, ['tierId', 'tierName'])
        tierId = asCount(tier.tierId)
        tierName = typeof tier.tierName === 'string' ? tier.tierName : 'None'
      } catch {
        // Default None.
      }
    }
    return { ...row, tierId, tierName }
  })

  enriched.sort((a, b) => {
    if (a.score !== b.score) return a.score > b.score ? -1 : 1
    return (
      b.uniqueSupporters - a.uniqueSupporters ||
      b.bountiesCompleted - a.bountiesCompleted ||
      b.tipsReceived - a.tipsReceived ||
      a.handle.localeCompare(b.handle)
    )
  })

  const leaders: PublicLeaderboardEntry[] = enriched.map((row, index) => ({
    rank: index + 1,
    handle: row.handle,
    displayHandle: displayHandle(row.handle),
    score: row.score.toString(),
    tierId: row.tierId,
    tierName: row.tierName,
    uniqueSupporters: row.uniqueSupporters,
    tipsReceived: row.tipsReceived,
    bountiesCompleted: row.bountiesCompleted,
    qualifiedPolls: row.qualifiedPolls,
    pollVotes: row.pollVotes,
    bestStreak: row.bestStreak,
    hasBadge: row.hasBadge,
  }))

  return {
    chainId: CHAIN_ID,
    contract: AGENTJAR_ADDRESS,
    verifiedUrl: BSCSCAN_CONTRACT_URL,
    totalActiveAgents,
    count: leaders.length,
    updatedAt,
    leaders,
  }
}

export async function resolveAgentHandleOnChain(
  rawHandle: string,
): Promise<{ found: false; handle: string } | { found: true; handle: string; owner: `0x${string}` }> {
  const handle = normalizeHandle(rawHandle.trim())
  if (!handle) return { found: false, handle: '' }

  const owner = await serverPublicClient.readContract({
    address: REGISTRY,
    abi: registryAbi,
    functionName: 'ownerOfHandle',
    args: [handle],
  })

  if (!isAddress(owner) || owner.toLowerCase() === ZERO.toLowerCase()) {
    return { found: false, handle }
  }

  const balance = await serverPublicClient.readContract({
    address: REGISTRY,
    abi: registryAbi,
    functionName: 'balanceOf',
    args: [owner],
  })

  if (typeof balance !== 'bigint' || balance === 0n) {
    return { found: false, handle }
  }

  return { found: true, handle, owner }
}

export type AgentIntelligenceReport = {
  chainId: number
  contract: `0x${string}`
  verifiedUrl: string
  generatedAt: string
  agent: {
    handle: string
    displayHandle: string
    verifiedAgentId: true
    activeInDirectory: boolean
  }
  reputation: {
    score: string
    tierId: number
    tierName: string
    uniqueVerifiedSupporters: number
    verifiedTipsReceived: number
    agentIdsTipped: number
    bnbReceived: string
    usdReceived: string
    pendingWithdrawalBNB: string
  }
  bountySla: {
    bountiesCompleted: number
    recentBountiesScanned: number
    asCreator: { total: number; completed: number; disputed: number; refunded: number; split: number }
    asWorker: { total: number; completed: number; disputed: number; refunded: number; split: number }
  }
  pollParticipation: {
    pollVotes: number
    pollsCreated: number
    qualifiedPolls: number
    currentStreakDays: number
    bestStreakDays: number
  }
  passport: {
    minted: boolean
    tokenId: string
    metadata: PassportMetadata | null
  }
}

export async function fetchAgentIntelligenceReport(
  handle: string,
  owner: `0x${string}`,
): Promise<AgentIntelligenceReport> {
  const packed = await serverPublicClient.multicall({
    allowFailure: true,
    contracts: [
      { address: AGENTJAR_ADDRESS, abi: agentJarAbi, functionName: 'recipientStats', args: [owner] },
      { address: AGENTJAR_ADDRESS, abi: agentJarAbi, functionName: 'senderStats', args: [owner] },
      { address: AGENTJAR_ADDRESS, abi: agentJarAbi, functionName: 'getScore', args: [owner] },
      { address: AGENTJAR_ADDRESS, abi: agentJarAbi, functionName: 'bountiesCompleted', args: [owner] },
      { address: AGENTJAR_ADDRESS, abi: agentJarAbi, functionName: 'qualifiedPolls', args: [owner] },
      { address: AGENTJAR_ADDRESS, abi: agentJarAbi, functionName: 'pendingWithdrawals', args: [owner] },
      { address: AGENTJAR_ADDRESS, abi: agentJarAbi, functionName: 'balanceOf', args: [owner] },
      { address: AGENTJAR_ADDRESS, abi: agentJarAbi, functionName: 'tokenIdOf', args: [owner] },
      { address: AGENTJAR_ADDRESS, abi: agentJarAbi, functionName: 'isActiveAgent', args: [owner] },
      { address: AGENTJAR_ADDRESS, abi: agentJarAbi, functionName: 'bountyCount' },
    ],
  })

  const recipient = packed[0]?.status === 'success' ? parseRecipient(packed[0].result) : null
  const sender = packed[1]?.status === 'success' ? parseSender(packed[1].result) : null
  const score = packed[2]?.status === 'success' ? asBigint(packed[2].result) : 0n
  const completedCount = packed[3]?.status === 'success' ? asCount(packed[3].result) : 0
  const qualifiedCount = packed[4]?.status === 'success' ? asCount(packed[4].result) : 0
  const pendingBNB = packed[5]?.status === 'success' ? asBigint(packed[5].result) : 0n
  const badgeBalance = packed[6]?.status === 'success' ? asBigint(packed[6].result) : 0n
  const tokenId = packed[7]?.status === 'success' ? asBigint(packed[7].result) : 0n
  const activeInDirectory = packed[8]?.status === 'success' && packed[8].result === true
  const totalBounties = packed[9]?.status === 'success' ? asCount(packed[9].result) : 0

  const tierRaw = await serverPublicClient.readContract({
    address: AGENTJAR_ADDRESS,
    abi: agentJarAbi,
    functionName: 'getTier',
    args: [score],
  })
  const tier = tupleRecord(tierRaw, ['tierId', 'tierName'])
  const tierId = asCount(tier.tierId)
  const tierName = typeof tier.tierName === 'string' ? tier.tierName : 'None'

  let metadata: PassportMetadata | null = null
  if (badgeBalance > 0n) {
    try {
      const uri = await serverPublicClient.readContract({
        address: AGENTJAR_ADDRESS,
        abi: agentJarAbi,
        functionName: 'tokenURI',
        args: [tokenId],
      })
      if (typeof uri === 'string') metadata = parsePassportTokenUri(uri)
    } catch {
      metadata = null
    }
  }

  // Compute live Bounty SLA summary from recent on-chain bounties (up to last 50).
  const asCreator = { total: 0, completed: 0, disputed: 0, refunded: 0, split: 0 }
  const asWorker = { total: 0, completed: 0, disputed: 0, refunded: 0, split: 0 }
  const scanCount = Math.min(totalBounties, 50)
  if (scanCount > 0) {
    const startId = totalBounties - scanCount
    const bountyCalls = await serverPublicClient.multicall({
      allowFailure: true,
      contracts: Array.from({ length: scanCount }, (_, i) => ({
        address: AGENTJAR_ADDRESS,
        abi: agentJarAbi,
        functionName: 'getBounty' as const,
        args: [BigInt(startId + i)] as const,
      })),
    })
    const ownerLower = owner.toLowerCase()
    for (const entry of bountyCalls) {
      if (entry.status !== 'success') continue
      try {
        const b = tupleRecord(entry.result, [
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
        const statusCode = asCount(b.status)
        const bump = (bucket: typeof asCreator) => {
          bucket.total += 1
          if (statusCode === 2) bucket.disputed += 1
          else if (statusCode === 3) bucket.completed += 1
          else if (statusCode === 4) bucket.refunded += 1
          else if (statusCode === 5) bucket.split += 1
        }
        if (typeof b.creator === 'string' && b.creator.toLowerCase() === ownerLower) bump(asCreator)
        if (typeof b.worker === 'string' && b.worker.toLowerCase() === ownerLower) bump(asWorker)
      } catch {
        // Ignore undecodable entry.
      }
    }
  }

  return {
    chainId: CHAIN_ID,
    contract: AGENTJAR_ADDRESS,
    verifiedUrl: BSCSCAN_CONTRACT_URL,
    generatedAt: new Date().toISOString(),
    agent: {
      handle,
      displayHandle: displayHandle(handle),
      verifiedAgentId: true,
      activeInDirectory,
    },
    reputation: {
      score: score.toString(),
      tierId,
      tierName,
      uniqueVerifiedSupporters: recipient?.uniqueSupporters ?? 0,
      verifiedTipsReceived: recipient?.tipsReceived ?? 0,
      agentIdsTipped: sender?.agentIdsTipped ?? 0,
      bnbReceived: formatEther(recipient?.bnbReceived ?? 0n),
      usdReceived: formatEther(recipient?.usdReceived ?? 0n),
      pendingWithdrawalBNB: formatEther(pendingBNB),
    },
    bountySla: {
      bountiesCompleted: completedCount,
      recentBountiesScanned: scanCount,
      asCreator,
      asWorker,
    },
    pollParticipation: {
      pollVotes: sender?.pollVotes ?? 0,
      pollsCreated: sender?.pollsCreated ?? 0,
      qualifiedPolls: qualifiedCount,
      currentStreakDays: sender?.currentStreak ?? 0,
      bestStreakDays: sender?.bestStreak ?? 0,
    },
    passport: {
      minted: badgeBalance > 0n,
      tokenId: tokenId.toString(),
      metadata,
    },
  }
}

import { isAddress, type AbiEvent } from 'viem'
import { getAccount, getPublicClient, multicall, readContract } from 'wagmi/actions'
import { agentJarAbi, registryAbi } from '@/lib/abi'
import { agentJarAddress, CHAIN_ID, REGISTRY, USDC, USDT, ZERO } from '@/lib/config'
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
  options: string[]
  votes: number[]
  voted: boolean
}

type Settled = { status: string; result?: unknown }

const tipSentEvent = agentJarAbi.find((item) => item.type === 'event' && item.name === 'TipSent') as AbiEvent

function settledOk(entry: Settled | undefined): unknown {
  if (!entry || entry.status !== 'success') throw new Error('Contract read failed')
  return entry.result
}

function emptyProfile(handle: string): AgentProfile {
  return {
    verified: true,
    handle,
    configured: Boolean(agentJarAddress),
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

/**
 * Resolve a handle and its public stats.
 * The owner address is used only as a contract argument and is not returned.
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
  if (!agentJarAddress) return emptyProfile(handle)

  try {
    const packed = (await multicall(wagmiConfig, {
      chainId: CHAIN_ID,
      allowFailure: true,
      contracts: [
        { address: agentJarAddress, abi: agentJarAbi, functionName: 'recipientStats', args: [owner] },
        { address: agentJarAddress, abi: agentJarAbi, functionName: 'senderStats', args: [owner] },
        { address: agentJarAddress, abi: agentJarAbi, functionName: 'getScore', args: [owner] },
        { address: agentJarAddress, abi: agentJarAbi, functionName: 'balanceOf', args: [owner] },
        { address: agentJarAddress, abi: agentJarAbi, functionName: 'tokenIdOf', args: [owner] },
      ],
    })) as Settled[]

    const recipient = parseRecipient(settledOk(packed[0]))
    const sender: SenderView = parseSender(settledOk(packed[1]))
    const score = asBigint(settledOk(packed[2]))
    const badgeBalance = asBigint(settledOk(packed[3]))
    const tokenId = asBigint(settledOk(packed[4]))
    const tierRaw = await readContract(wagmiConfig, {
      chainId: CHAIN_ID,
      address: agentJarAddress,
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
          address: agentJarAddress,
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

async function inGroups<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  for (let index = 0; index < items.length; index += size) {
    const group = await Promise.all(items.slice(index, index + size).map(fn))
    out.push(...group)
  }
  return out
}

export async function loadTipIndex(): Promise<TipIndex> {
  if (!agentJarAddress) return { tips: [], leaders: [], incomplete: false, unavailable: false }
  const client = getPublicClient(wagmiConfig, { chainId: CHAIN_ID })
  if (!client) return { tips: [], leaders: [], incomplete: false, unavailable: true }

  const latest = await client.getBlockNumber()
  const chunk = 2_000n
  const maxChunks = 12n
  const span = chunk * maxChunks
  let from = latest > span ? latest - span : 0n
  const requested = process.env.NEXT_PUBLIC_AGENTJAR_FROM_BLOCK
  if (requested && /^\d+$/.test(requested)) {
    const parsed = BigInt(requested)
    if (parsed > from && parsed <= latest) from = parsed
  }

  const ranges: { fromBlock: bigint; toBlock: bigint }[] = []
  for (let start = from; start <= latest; start += chunk) {
    const end = start + chunk - 1n
    ranges.push({ fromBlock: start, toBlock: end > latest ? latest : end })
  }

  const parts = await inGroups(ranges, 3, async (range) => {
    try {
      const logs = await client.getLogs({
        address: agentJarAddress,
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
  if (logs.length === 0 && incomplete) {
    return { tips: [], leaders: [], incomplete: true, unavailable: true }
  }

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

  const handles: string[] = []
  for (const row of rows) {
    if (!handles.includes(row.handle)) handles.push(row.handle)
    if (handles.length >= 80) break
  }

  const leaders: LeaderRow[] = []
  if (handles.length > 0) {
    const resolved = (await multicall(wagmiConfig, {
      chainId: CHAIN_ID,
      allowFailure: true,
      contracts: handles.map((handle) => ({
        address: REGISTRY,
        abi: registryAbi,
        functionName: 'ownerOfHandle' as const,
        args: [handle] as const,
      })),
    })) as Settled[]

    const found: { handle: string; owner: `0x${string}` }[] = []
    resolved.forEach((entry, index) => {
      const owner = entry.status === 'success' && typeof entry.result === 'string' ? entry.result : ''
      const handle = handles[index]
      if (!handle || !isAddress(owner) || owner.toLowerCase() === ZERO.toLowerCase()) return
      found.push({ handle, owner })
    })

    if (found.length > 0 && agentJarAddress) {
      const jar = agentJarAddress
      const stats = (await multicall(wagmiConfig, {
        chainId: CHAIN_ID,
        allowFailure: true,
        contracts: found.map((item) => ({
          address: jar,
          abi: agentJarAbi,
          functionName: 'recipientStats' as const,
          args: [item.owner] as const,
        })),
      })) as Settled[]
      stats.forEach((entry, index) => {
        const handle = found[index]?.handle
        if (!handle || entry.status !== 'success') return
        try {
          const recipient = parseRecipient(entry.result)
          leaders.push({ handle, supporters: recipient.uniqueSupporters, tips: recipient.tipsReceived })
        } catch {
          // Skip a row that cannot be decoded. The address is not shown.
        }
      })
    }
  }

  leaders.sort((a, b) => b.supporters - a.supporters || b.tips - a.tips || a.handle.localeCompare(b.handle))

  return {
    tips: rows.slice(0, 12).map(({ handle, amount, asset, message, id }) => ({ id, handle, amount, asset, message })),
    leaders: leaders.slice(0, 20),
    incomplete,
    unavailable: false,
  }
}

function parsePoll(value: unknown): {
  creator: string
  endTime: bigint
  open: boolean
  question: string
  options: string[]
  votes: number[]
} {
  const record = tupleRecord(value, ['creator', 'endTime', 'open', 'question', 'options', 'votes'])
  return {
    creator: typeof record.creator === 'string' ? record.creator : '',
    endTime: asBigint(record.endTime),
    open: record.open === true,
    question: typeof record.question === 'string' ? record.question : '',
    options: asStringArray(record.options),
    votes: Array.isArray(record.votes) ? record.votes.map((vote) => asCount(vote)) : [],
  }
}

export async function loadPolls(): Promise<PollView[]> {
  if (!agentJarAddress) return []
  const jar = agentJarAddress
  const countRaw = await readContract(wagmiConfig, {
    chainId: CHAIN_ID,
    address: jar,
    abi: agentJarAbi,
    functionName: 'pollCount',
  })
  const count = asBigint(countRaw)
  if (count === 0n) return []
  const newest = count - 1n
  const oldest = count > 20n ? count - 20n : 0n
  const ids: bigint[] = []
  for (let id = newest; id >= oldest; id -= 1n) ids.push(id)

  const polls = (await multicall(wagmiConfig, {
    chainId: CHAIN_ID,
    allowFailure: true,
    contracts: ids.map((id) => ({
      address: jar,
      abi: agentJarAbi,
      functionName: 'getPoll' as const,
      args: [id] as const,
    })),
  })) as Settled[]

  const parsed: { id: bigint; creator: `0x${string}`; endTime: number; open: boolean; question: string; options: string[]; votes: number[] }[] = []
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
        question: poll.question,
        options: poll.options,
        votes: poll.votes,
      })
    } catch {
      // Skip an undecodable poll.
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
        address: jar,
        abi: agentJarAbi,
        functionName: 'hasVoted' as const,
        args: [poll.id, account.address!] as const,
      })),
    })) as Settled[]
    voted = votes.map((entry) => entry.status === 'success' && entry.result === true)
  }

  return parsed.map((poll, index) => {
    const handle = handles[index]?.status === 'success' && typeof handles[index]?.result === 'string' ? handles[index]?.result : ''
    return {
      id: poll.id,
      question: poll.question,
      creatorHandle: handle,
      endTime: poll.endTime,
      open: poll.open,
      options: poll.options,
      votes: poll.votes,
      voted: voted[index] ?? false,
    }
  })
}

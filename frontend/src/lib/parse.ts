export type SenderView = {
  agentIdsTipped: number
  pollVotes: number
  pollsCreated: number
  currentStreak: number
  bestStreak: number
  lastVoteDay: number
  pollDay: number
  pollsToday: number
}

export type RecipientView = {
  tipsReceived: number
  uniqueSupporters: number
  bnbReceived: bigint
  usdReceived: bigint
}

export function tupleRecord(value: unknown, keys: string[]): Record<string, unknown> {
  if (Array.isArray(value)) {
    const record: Record<string, unknown> = {}
    keys.forEach((key, index) => {
      record[key] = value[index]
    })
    return record
  }
  if (value && typeof value === 'object') return value as Record<string, unknown>
  throw new Error('Unexpected contract result')
}

export function asBigint(value: unknown): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value))
  if (typeof value === 'string' && /^(0x[0-9a-fA-F]+|\d+)$/.test(value)) return BigInt(value)
  throw new Error('Expected an integer')
}

export function asCount(value: unknown): number {
  const parsed = asBigint(value)
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) return Number.MAX_SAFE_INTEGER
  return Number(parsed)
}

export function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error('Expected a string list')
  }
  return value
}

export function parseRecipient(value: unknown): RecipientView {
  const record = tupleRecord(value, ['tipsReceived', 'uniqueSupporters', 'bnbReceived', 'usdReceived'])
  return {
    tipsReceived: asCount(record.tipsReceived),
    uniqueSupporters: asCount(record.uniqueSupporters),
    bnbReceived: asBigint(record.bnbReceived),
    usdReceived: asBigint(record.usdReceived),
  }
}

export function parseSender(value: unknown): SenderView {
  const record = tupleRecord(value, [
    'agentIdsTipped',
    'pollVotes',
    'pollsCreated',
    'currentStreak',
    'bestStreak',
    'lastVoteDay',
    'pollDay',
    'pollsToday',
  ])
  return {
    agentIdsTipped: asCount(record.agentIdsTipped),
    pollVotes: asCount(record.pollVotes),
    pollsCreated: asCount(record.pollsCreated),
    currentStreak: asCount(record.currentStreak),
    bestStreak: asCount(record.bestStreak),
    lastVoteDay: asCount(record.lastVoteDay),
    pollDay: asCount(record.pollDay),
    pollsToday: asCount(record.pollsToday),
  }
}

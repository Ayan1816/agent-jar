const REVERT_COPY: Record<string, string> = {
  TipTooSmall: 'Amount is below the minimum.',
  MessageTooLong: 'Message is longer than 280 bytes.',
  UnknownHandle: 'No verified Agent ID for that handle.',
  SelfTip: 'You cannot tip your own Agent ID.',
  UnsupportedToken: 'Only USDT and USDC tips are supported.',
  NotHolder: 'Only Agent ID holders can do that.',
  PollRateLimited: 'Holders can create at most 3 polls per UTC day.',
  PollClosed: 'This poll has ended.',
  AlreadyVoted: 'You already voted on this poll.',
  InvalidOption: 'That option is not on this poll.',
  InvalidOptions: 'Enter 2 to 6 non-empty options.',
  InvalidQuestion: 'Enter a question.',
  InvalidDuration: 'Duration must be from 1 hour to 30 days.',
  ScoreTooLow: 'Score must be at least 1 to claim a badge.',
  BadgeAlreadyClaimed: 'Badge already claimed.',
  PollNotFound: 'That poll does not exist.',
  TransferFailed: 'The tip could not be delivered.',
  ZeroAddress: 'The contract address is not configured.',
}

export function friendlyError(error: unknown): string {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error)
  if (/user rejected|user denied|rejected the request|denied transaction/i.test(text)) {
    return 'Transaction cancelled in the wallet.'
  }
  if (/insufficient funds/i.test(text)) {
    return 'The wallet does not have enough funds for this transaction.'
  }
  for (const [name, message] of Object.entries(REVERT_COPY)) {
    if (text.includes(name)) return message
  }
  return 'The wallet or contract rejected this transaction. Review the details and try again.'
}

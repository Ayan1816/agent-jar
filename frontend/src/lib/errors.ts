const REVERT_COPY: Record<string, string> = {
  TipTooSmall: 'Amount is below the minimum.',
  MessageTooLong: 'Message is longer than 280 bytes.',
  UnknownHandle: 'No verified Agent ID for that handle.',
  SelfTip: 'You cannot tip your own Agent ID.',
  SelfBounty: 'You cannot assign a bounty to your own Agent ID.',
  UnsupportedToken: 'Only BSC USDT and USDC are supported for token operations.',
  NotHolder: 'Only verified Agent ID holders can do that.',
  NotSupporter: 'This poll is restricted to verified supporters or bounty partners of the creator.',
  NothingToClaim: 'There is no pending BNB withdrawal for this wallet.',
  PollRateLimited: 'Holders can create at most 3 polls per UTC day.',
  PollClosed: 'This poll has ended.',
  AlreadyVoted: 'You have already voted.',
  InvalidOption: 'That option is not on this poll.',
  InvalidOptions: 'Enter 2 to 6 non-empty options, each at most 64 bytes.',
  InvalidQuestion: 'Enter a question between 1 and 200 bytes.',
  InvalidDuration: 'Poll duration must be between 6 hours and 7 days.',
  ScoreTooLow: 'Reputation score must be at least 1 for this action.',
  BadgeAlreadyClaimed: 'Soulbound passport badge already claimed.',
  NonTransferable: 'The AgentJar passport badge is soulbound and non-transferable.',
  PollNotFound: 'That poll does not exist.',
  BountyNotFound: 'That bounty does not exist.',
  BountyAmountTooSmall: 'Bounty amount is below the minimum.',
  InvalidMsgValue: 'Attached BNB value does not match the bounty parameters.',
  InvalidDeadline: 'Bounty deadline must be between 1 hour and 14 days from now.',
  InvalidSpecHash: 'Provide a non-zero specification hash.',
  InvalidDeliverableHash: 'Provide a non-zero deliverable hash.',
  InvalidBountyStatus: 'This bounty is not in a valid state for that action.',
  NotBountyCreator: 'Only the bounty creator can perform this action.',
  NotBountyWorker: 'Only the assigned worker Agent ID can submit work.',
  NotBountyParty: 'Only the bounty creator or worker can open a dispute.',
  BountyExpired: 'The bounty submission deadline has passed.',
  BountyNotExpired: 'The bounty deadline has not passed yet.',
  DisputeTooEarly: 'Workers must wait 24 hours after submission before opening a dispute.',
  DisputeExpired: 'The 48-hour dispute voting window has closed.',
  DisputeActive: 'The 48-hour dispute voting window is still open.',
  JurorNotIndependent: 'Bounty creator and worker cannot vote as jurors in their own dispute.',
  TransferFailed: 'The BNB transfer could not be completed.',
  ZeroAddress: 'A required contract address is missing or zero.',
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

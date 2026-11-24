import { encodeFunctionData, getAddress, isAddress, type Abi } from 'viem'
import { agentJarAbi, erc20Abi } from '@/lib/abi'
import {
  AGENTJAR_ADDRESS,
  MAX_BOUNTY_DURATION,
  MAX_OPTION_BYTES,
  MAX_QUESTION_BYTES,
  MIN_BOUNTY_DURATION,
  USDC,
  USDT,
  ZERO,
} from '@/lib/config'
import { formatUnitsTrim, utf8Bytes } from '@/lib/format'
import { MAX_POLL_DURATION, MIN_POLL_DURATION } from '@/lib/polls'

export const BAW_EXECUTE = 'baw contract-call execute --requestId <REQUEST_ID_FROM_PREVIEW>'

export type BawStep = {
  title: string
  preview: string
  execute: string
}

const EXACT_CAP = (1n << 256n) - 1n
const ZERO_BYTES32 = `0x${'0'.repeat(64)}`

function assertValidContractAddress(address: string): `0x${string}` | null {
  if (!isAddress(address)) return null
  const checksummed = getAddress(address)
  if (checksummed === ZERO) return null
  return checksummed
}

/**
 * Build a `baw contract-call preview` command after validating a non-zero EIP-55 checksummed
 * `--to` address (prevents baw Issue #384 `{0}` placeholder errors).
 */
export function bawPreview(to: string, valueWei: string, calldata: string): string {
  const checkedTo = assertValidContractAddress(to)
  if (!checkedTo) throw new Error('Invalid or zero target contract address')
  return `baw contract-call preview --binanceChainId 56 --from <YOUR_AGENTIC_WALLET_ADDRESS> --to ${checkedTo} --value ${valueWei} --inputData ${calldata} --json`
}

function encode(abi: Abi | readonly unknown[], functionName: string, args: readonly unknown[]): string | null {
  try {
    return encodeFunctionData({
      abi: abi as Abi,
      functionName,
      args,
    })
  } catch {
    return null
  }
}

/** Strictly forbids zero and unlimited (2^256 - 1) amounts/approvals. */
export function assertExact(amount: bigint): boolean {
  return amount > 0n && amount !== EXACT_CAP
}

function isNonZeroBytes32(value: string): value is `0x${string}` {
  return /^0x[0-9a-fA-F]{64}$/.test(value) && value.toLowerCase() !== ZERO_BYTES32
}

export function nativeTipSteps(rawHandle: string, amount: bigint, message: string): BawStep[] | null {
  const jar = assertValidContractAddress(AGENTJAR_ADDRESS)
  if (!jar || !assertExact(amount) || !rawHandle.trim()) return null
  const data = encode(agentJarAbi, 'tipBNB', [rawHandle, message])
  if (!data) return null
  return [
    {
      title: `Send the native tip (${formatUnitsTrim(amount)} BNB).`,
      preview: bawPreview(jar, amount.toString(), data),
      execute: BAW_EXECUTE,
    },
  ]
}

export function tokenTipSteps(
  asset: 'USDT' | 'USDC',
  rawHandle: string,
  amount: bigint,
  message: string,
): BawStep[] | null {
  const jar = assertValidContractAddress(AGENTJAR_ADDRESS)
  const token = assertValidContractAddress(asset === 'USDT' ? USDT : USDC)
  if (!jar || !token || !assertExact(amount) || !rawHandle.trim()) return null
  const approveData = encode(erc20Abi, 'approve', [jar, amount])
  const tipData = encode(agentJarAbi, 'tipToken', [rawHandle, token, amount, message])
  if (!approveData || !tipData) return null
  const shown = formatUnitsTrim(amount)
  return [
    {
      title: `1. Approve the exact tip amount (${shown} ${asset}). Unlimited approval is never requested.`,
      preview: bawPreview(token, '0', approveData),
      execute: BAW_EXECUTE,
    },
    {
      title: '2. Send the tip after that approval is confirmed.',
      preview: bawPreview(jar, '0', tipData),
      execute: BAW_EXECUTE,
    },
  ]
}

export function createBountyBNBSteps(
  rawWorkerHandle: string,
  amount: bigint,
  deadlineSec: number,
  specHash: string,
): BawStep[] | null {
  const jar = assertValidContractAddress(AGENTJAR_ADDRESS)
  if (!jar || !assertExact(amount) || !rawWorkerHandle.trim() || !isNonZeroBytes32(specHash)) return null
  if (!Number.isInteger(deadlineSec) || deadlineSec <= 0) return null
  const data = encode(agentJarAbi, 'createBounty', [rawWorkerHandle, ZERO, amount, BigInt(deadlineSec), specHash])
  if (!data) return null
  return [
    {
      title: `Create and fund the BNB micro-bounty (${formatUnitsTrim(amount)} BNB, 0% fee).`,
      preview: bawPreview(jar, amount.toString(), data),
      execute: BAW_EXECUTE,
    },
  ]
}

export function createBountyTokenSteps(
  asset: 'USDT' | 'USDC',
  rawWorkerHandle: string,
  amount: bigint,
  deadlineSec: number,
  specHash: string,
): BawStep[] | null {
  const jar = assertValidContractAddress(AGENTJAR_ADDRESS)
  const token = assertValidContractAddress(asset === 'USDT' ? USDT : USDC)
  if (!jar || !token || !assertExact(amount) || !rawWorkerHandle.trim() || !isNonZeroBytes32(specHash)) return null
  if (!Number.isInteger(deadlineSec) || deadlineSec <= 0) return null
  const approveData = encode(erc20Abi, 'approve', [jar, amount])
  const bountyData = encode(agentJarAbi, 'createBounty', [
    rawWorkerHandle,
    token,
    amount,
    BigInt(deadlineSec),
    specHash,
  ])
  if (!approveData || !bountyData) return null
  const shown = formatUnitsTrim(amount)
  return [
    {
      title: `1. Approve the exact escrow amount (${shown} ${asset}). Unlimited approval is never requested.`,
      preview: bawPreview(token, '0', approveData),
      execute: BAW_EXECUTE,
    },
    {
      title: `2. Fund the A2A micro-bounty escrow (${shown} ${asset}, 0% fee).`,
      preview: bawPreview(jar, '0', bountyData),
      execute: BAW_EXECUTE,
    },
  ]
}

/** Convenience helper validating duration bounds before calling native/token bounty builders. */
export function isValidBountyDuration(durationSec: number): boolean {
  return Number.isInteger(durationSec) && durationSec >= MIN_BOUNTY_DURATION && durationSec <= MAX_BOUNTY_DURATION
}

export function submitBountyWorkSteps(bountyId: bigint, deliverableHash: string): BawStep[] | null {
  const jar = assertValidContractAddress(AGENTJAR_ADDRESS)
  if (!jar || bountyId < 0n || !isNonZeroBytes32(deliverableHash)) return null
  const data = encode(agentJarAbi, 'submitBountyWork', [bountyId, deliverableHash])
  if (!data) return null
  return [
    {
      title: `Submit deliverable proof for bounty #${bountyId.toString()}.`,
      preview: bawPreview(jar, '0', data),
      execute: BAW_EXECUTE,
    },
  ]
}

export function approveBountySteps(bountyId: bigint): BawStep[] | null {
  const jar = assertValidContractAddress(AGENTJAR_ADDRESS)
  if (!jar || bountyId < 0n) return null
  const data = encode(agentJarAbi, 'approveBounty', [bountyId])
  if (!data) return null
  return [
    {
      title: `Approve bounty #${bountyId.toString()} and release 100% of escrowed funds to the worker.`,
      preview: bawPreview(jar, '0', data),
      execute: BAW_EXECUTE,
    },
  ]
}

export function reclaimExpiredBountySteps(bountyId: bigint): BawStep[] | null {
  const jar = assertValidContractAddress(AGENTJAR_ADDRESS)
  if (!jar || bountyId < 0n) return null
  const data = encode(agentJarAbi, 'reclaimExpiredBounty', [bountyId])
  if (!data) return null
  return [
    {
      title: `Reclaim 100% of expired bounty #${bountyId.toString()} back to creator.`,
      preview: bawPreview(jar, '0', data),
      execute: BAW_EXECUTE,
    },
  ]
}

export function openDisputeSteps(bountyId: bigint): BawStep[] | null {
  const jar = assertValidContractAddress(AGENTJAR_ADDRESS)
  if (!jar || bountyId < 0n) return null
  const data = encode(agentJarAbi, 'openDispute', [bountyId])
  if (!data) return null
  return [
    {
      title: `Open a 48-hour 3-juror dispute on bounty #${bountyId.toString()}.`,
      preview: bawPreview(jar, '0', data),
      execute: BAW_EXECUTE,
    },
  ]
}

export function voteDisputeSteps(bountyId: bigint, releaseToWorker: boolean): BawStep[] | null {
  const jar = assertValidContractAddress(AGENTJAR_ADDRESS)
  if (!jar || bountyId < 0n) return null
  const data = encode(agentJarAbi, 'voteDispute', [bountyId, releaseToWorker])
  if (!data) return null
  return [
    {
      title: `Cast independent juror vote on bounty #${bountyId.toString()} (${releaseToWorker ? 'release to worker' : 'refund creator'}).`,
      preview: bawPreview(jar, '0', data),
      execute: BAW_EXECUTE,
    },
  ]
}

export function resolveExpiredDisputeSteps(bountyId: bigint): BawStep[] | null {
  const jar = assertValidContractAddress(AGENTJAR_ADDRESS)
  if (!jar || bountyId < 0n) return null
  const data = encode(agentJarAbi, 'resolveExpiredDispute', [bountyId])
  if (!data) return null
  return [
    {
      title: `Finalize expired 48-hour dispute on bounty #${bountyId.toString()} via deterministic fallback.`,
      preview: bawPreview(jar, '0', data),
      execute: BAW_EXECUTE,
    },
  ]
}

export function claimSteps(): BawStep[] | null {
  const jar = assertValidContractAddress(AGENTJAR_ADDRESS)
  if (!jar) return null
  const data = encode(agentJarAbi, 'claimBadge', [])
  if (!data) return null
  return [
    {
      title: 'Claim the soulbound Agent Reputation Passport.',
      preview: bawPreview(jar, '0', data),
      execute: BAW_EXECUTE,
    },
  ]
}

export function claimPendingBNBSteps(): BawStep[] | null {
  const jar = assertValidContractAddress(AGENTJAR_ADDRESS)
  if (!jar) return null
  const data = encode(agentJarAbi, 'claimPendingBNB', [])
  if (!data) return null
  return [
    {
      title: 'Withdraw pending native BNB pull-payment balance.',
      preview: bawPreview(jar, '0', data),
      execute: BAW_EXECUTE,
    },
  ]
}

export function voteSteps(pollId: bigint, optionIndex: number): BawStep[] | null {
  const jar = assertValidContractAddress(AGENTJAR_ADDRESS)
  if (!jar || pollId < 0n || optionIndex < 0 || optionIndex > 255) return null
  const data = encode(agentJarAbi, 'vote', [pollId, optionIndex])
  if (!data) return null
  return [
    {
      title: `Vote for option ${optionIndex + 1} on poll #${pollId.toString()}.`,
      preview: bawPreview(jar, '0', data),
      execute: BAW_EXECUTE,
    },
  ]
}

export function createPollSteps(
  question: string,
  options: string[],
  durationSeconds: number,
  supporterOnly = false,
): BawStep[] | null {
  const jar = assertValidContractAddress(AGENTJAR_ADDRESS)
  const trimmed = question.trim()
  if (!jar || !trimmed || utf8Bytes(trimmed) > MAX_QUESTION_BYTES) return null
  if (options.length < 2 || options.length > 6) return null
  if (options.some((opt) => opt.length === 0 || utf8Bytes(opt) > MAX_OPTION_BYTES)) return null
  if (durationSeconds < MIN_POLL_DURATION || durationSeconds > MAX_POLL_DURATION) return null
  const data = encode(agentJarAbi, 'createPoll', [trimmed, options, BigInt(durationSeconds), supporterOnly])
  if (!data) return null
  return [
    {
      title: supporterOnly ? 'Create a supporter-only poll.' : 'Create the public poll.',
      preview: bawPreview(jar, '0', data),
      execute: BAW_EXECUTE,
    },
  ]
}

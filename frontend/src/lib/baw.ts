import { encodeFunctionData, type Abi } from 'viem'
import { agentJarAbi, erc20Abi } from '@/lib/abi'
import { agentJarAddress, USDC, USDT } from '@/lib/config'
import { formatUnitsTrim } from '@/lib/format'

export const BAW_EXECUTE = 'baw contract-call execute --requestId <REQUEST_ID_FROM_PREVIEW>'

export type BawStep = {
  title: string
  preview: string
  execute: string
}

const EXACT_CAP = (1n << 256n) - 1n

export function bawPreview(to: string, valueWei: string, calldata: string): string {
  return `baw contract-call preview --binanceChainId 56 --from <YOUR_AGENTIC_WALLET_ADDRESS> --to ${to} --value ${valueWei} --inputData ${calldata} --json`
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

function assertExact(amount: bigint): boolean {
  return amount > 0n && amount !== EXACT_CAP
}

export function nativeTipSteps(rawHandle: string, amount: bigint, message: string): BawStep[] | null {
  if (!agentJarAddress || !assertExact(amount)) return null
  const data = encode(agentJarAbi, 'tipBNB', [rawHandle, message])
  if (!data) return null
  return [
    {
      title: `Send the native tip (${formatUnitsTrim(amount)} BNB).`,
      preview: bawPreview(agentJarAddress, amount.toString(), data),
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
  if (!agentJarAddress || !assertExact(amount)) return null
  const token = asset === 'USDT' ? USDT : USDC
  const approveData = encode(erc20Abi, 'approve', [agentJarAddress, amount])
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
      preview: bawPreview(agentJarAddress, '0', tipData),
      execute: BAW_EXECUTE,
    },
  ]
}

export function claimSteps(): BawStep[] | null {
  if (!agentJarAddress) return null
  const data = encode(agentJarAbi, 'claimBadge', [])
  if (!data) return null
  return [
    {
      title: 'Claim the soulbound badge.',
      preview: bawPreview(agentJarAddress, '0', data),
      execute: BAW_EXECUTE,
    },
  ]
}

export function voteSteps(pollId: bigint, optionIndex: number): BawStep[] | null {
  if (!agentJarAddress || optionIndex < 0 || optionIndex > 255) return null
  const data = encode(agentJarAbi, 'vote', [pollId, optionIndex])
  if (!data) return null
  return [
    {
      title: `Vote for option ${optionIndex + 1}.`,
      preview: bawPreview(agentJarAddress, '0', data),
      execute: BAW_EXECUTE,
    },
  ]
}

export function createPollSteps(question: string, options: string[], durationSeconds: number): BawStep[] | null {
  if (!agentJarAddress || options.length < 2 || options.length > 6) return null
  const data = encode(agentJarAbi, 'createPoll', [question, options, BigInt(durationSeconds)])
  if (!data) return null
  return [
    {
      title: 'Create the poll.',
      preview: bawPreview(agentJarAddress, '0', data),
      execute: BAW_EXECUTE,
    },
  ]
}

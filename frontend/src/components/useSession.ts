'use client'

import { useEffect, useState } from 'react'
import { useAccount, useReadContract } from 'wagmi'
import { agentJarAbi, registryAbi } from '@/lib/abi'
import { agentJarAddress, CHAIN_ID, REGISTRY } from '@/lib/config'
import { parseSender, type SenderView } from '@/lib/parse'

const PLACEHOLDER = '0x0000000000000000000000000000000000000001' as const

export function useMounted(): boolean {
  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    setMounted(true)
  }, [])
  return mounted
}

export type HolderStatus = 'disconnected' | 'checking' | 'holder' | 'visitor' | 'unknown'

/** Holder handle for the connected wallet. The wallet address is not returned. */
export function useMyHandle(enabled: boolean): {
  connected: boolean
  chainId: number | undefined
  handle: string
  isHolder: boolean
  status: HolderStatus
} {
  const { address, isConnected, chainId } = useAccount()
  const ready = Boolean(enabled && address && isConnected)
  const handleRead = useReadContract({
    chainId: CHAIN_ID,
    address: REGISTRY,
    abi: registryAbi,
    functionName: 'handleOf',
    args: [address ?? PLACEHOLDER],
    query: { enabled: ready },
  })
  const balanceRead = useReadContract({
    chainId: CHAIN_ID,
    address: REGISTRY,
    abi: registryAbi,
    functionName: 'balanceOf',
    args: [address ?? PLACEHOLDER],
    query: { enabled: ready },
  })

  const handle = typeof handleRead.data === 'string' ? handleRead.data : ''
  const isHolder = typeof balanceRead.data === 'bigint' && balanceRead.data > 0n
  let status: HolderStatus = 'disconnected'
  if (ready) {
    if (balanceRead.isLoading || handleRead.isLoading) status = 'checking'
    else if (balanceRead.isError || handleRead.isError) status = 'unknown'
    else if (isHolder) status = 'holder'
    else status = 'visitor'
  }

  return { connected: ready, chainId, handle, isHolder, status }
}

export function useMySenderStats(enabled: boolean): SenderView | null {
  const { address, isConnected } = useAccount()
  const read = useReadContract({
    chainId: CHAIN_ID,
    address: agentJarAddress ?? PLACEHOLDER,
    abi: agentJarAbi,
    functionName: 'senderStats',
    args: [address ?? PLACEHOLDER],
    query: { enabled: Boolean(enabled && address && isConnected && agentJarAddress) },
  })
  if (!read.data) return null
  try {
    return parseSender(read.data)
  } catch {
    return null
  }
}

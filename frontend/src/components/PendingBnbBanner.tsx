'use client'

import { useRef, useState } from 'react'
import { useAccount, useSwitchChain, useWriteContract } from 'wagmi'
import { waitForTransactionReceipt } from 'wagmi/actions'
import { BawPanel } from '@/components/BawPanel'
import { useMounted, useMyPendingBNB } from '@/components/useSession'
import { agentJarAbi } from '@/lib/abi'
import { claimPendingBNBSteps } from '@/lib/baw'
import { AGENTJAR_ADDRESS, CHAIN_ID } from '@/lib/config'
import { friendlyError } from '@/lib/errors'
import { formatUnitsTrim } from '@/lib/format'
import { wagmiConfig } from '@/lib/wagmi'

export function PendingBnbBanner() {
  const mounted = useMounted()
  const { isConnected, chainId } = useAccount()
  const { amount, refetch } = useMyPendingBNB(mounted)
  const { switchChainAsync } = useSwitchChain()
  const { writeContractAsync } = useWriteContract()
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const lock = useRef(false)

  if (!mounted || !isConnected || amount === 0n) return null

  async function onClaim() {
    if (lock.current || amount === 0n) return
    lock.current = true
    setError(null)
    setStatus(null)
    try {
      if (chainId !== CHAIN_ID) {
        setStatus('Confirm the BSC network switch in your wallet.')
        await switchChainAsync({ chainId: CHAIN_ID })
      }
      setStatus('Confirm the pending BNB withdrawal in your wallet.')
      const hash = await writeContractAsync({
        chainId: CHAIN_ID,
        address: AGENTJAR_ADDRESS,
        abi: agentJarAbi,
        functionName: 'claimPendingBNB',
        args: [],
      })
      await waitForTransactionReceipt(wagmiConfig, { hash, chainId: CHAIN_ID })
      setStatus('Pending BNB withdrawn.')
      await refetch()
    } catch (caught) {
      setStatus(null)
      setError(friendlyError(caught))
    } finally {
      lock.current = false
    }
  }

  return (
    <section
      className="rounded-2xl border border-gold/50 bg-gradient-to-r from-[#2A220F] via-card to-card p-4 shadow-[0_0_24px_rgba(240,185,11,0.16)]"
      role="status"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-gold">Pending BNB Withdrawal</p>
          <p className="mt-1 text-base font-semibold text-white">
            {formatUnitsTrim(amount)} BNB available via pull-payment fallback
          </p>
          <p className="mt-1 text-xs text-mist">
            Credited when a direct native BNB transfer reverted. Withdraw 100% directly to your wallet (0% fee).
          </p>
        </div>
        <button
          type="button"
          className="btn shrink-0"
          disabled={Boolean(status && status !== 'Pending BNB withdrawn.')}
          onClick={onClaim}
        >
          {status && status !== 'Pending BNB withdrawn.' ? 'Waiting for wallet…' : 'Claim Pending BNB'}
        </button>
      </div>
      {status ? <p className="mt-2 text-sm text-gold">{status}</p> : null}
      {error ? <p className="mt-2 text-sm text-[#FFD0D0]">{error}</p> : null}
      <div className="mt-3">
        <BawPanel steps={claimPendingBNBSteps()} label="Claim Pending BNB with Agentic Wallet" />
      </div>
    </section>
  )
}

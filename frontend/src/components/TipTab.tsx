'use client'

import Link from 'next/link'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useAccount, useSwitchChain, useWriteContract } from 'wagmi'
import { waitForTransactionReceipt } from 'wagmi/actions'
import { BawPanel } from '@/components/BawPanel'
import { CopyButton } from '@/components/CopyButton'
import { PendingBnbBanner } from '@/components/PendingBnbBanner'
import { useMounted, useMyHandle } from '@/components/useSession'
import { agentJarAbi, erc20Abi } from '@/lib/abi'
import { nativeTipSteps, tokenTipSteps } from '@/lib/baw'
import { AGENTJAR_ADDRESS, CHAIN_ID, MAX_MESSAGE_BYTES, MIN_NATIVE_TIP, MIN_USD_TIP, USDC, USDT } from '@/lib/config'
import { friendlyError } from '@/lib/errors'
import { countLabel, formatUnitsTrim, messageTooLong, parseTipAmount, supportLine, utf8Bytes } from '@/lib/format'
import { displayHandle, normalizeHandle } from '@/lib/handles'
import { loadAgent, loadTipIndex, type AgentProfile } from '@/lib/reads'
import { payUrl, profileUrl } from '@/lib/route'
import { wagmiConfig } from '@/lib/wagmi'

type Asset = 'BNB' | 'USDT' | 'USDC'

export function TipTab({ active, initialHandle }: { active: boolean; initialHandle: string | null }) {
  const mounted = useMounted()
  const mine = useMyHandle(mounted)
  const { isConnected } = useAccount()
  const { switchChainAsync } = useSwitchChain()
  const { writeContractAsync } = useWriteContract()
  const queryClient = useQueryClient()
  const [input, setInput] = useState('')
  const [lookup, setLookup] = useState('')
  const [asset, setAsset] = useState<Asset>('BNB')
  const [amountInput, setAmountInput] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [share, setShare] = useState('')
  const lock = useRef(false)

  useEffect(() => {
    if (!initialHandle) return
    setInput(initialHandle)
    setLookup(initialHandle)
  }, [initialHandle])

  const lookupKey = normalizeHandle(lookup.trim())
  const agentQuery = useQuery({
    queryKey: ['agent', lookupKey],
    enabled: mounted && lookupKey.length > 0,
    queryFn: () => loadAgent(lookup),
  })
  const tipsQuery = useQuery({
    queryKey: ['tip-index'],
    enabled: mounted && active,
    queryFn: loadTipIndex,
    staleTime: 30_000,
  })

  const profile = agentQuery.data?.verified ? agentQuery.data : null

  useEffect(() => {
    if (!mounted || !active || !profile) return
    const want = displayHandle(profile.handle)
    const have = new URLSearchParams(window.location.search).get('pay')
    if (have !== want) window.history.replaceState(null, '', payUrl(want))
    setShare(payUrl(want))
  }, [active, mounted, profile])

  const bytes = utf8Bytes(message)
  const amount = parseTipAmount(amountInput)
  const min = asset === 'BNB' ? MIN_NATIVE_TIP : MIN_USD_TIP
  const amountOk = amount !== null && amount >= min
  const rawHandle = input.trim()
  const matchesProfile = Boolean(profile && normalizeHandle(rawHandle) === profile.handle)
  const steps =
    amount && amountOk && matchesProfile && !messageTooLong(message)
      ? asset === 'BNB'
        ? nativeTipSteps(rawHandle, amount, message)
        : tokenTipSteps(asset, rawHandle, amount, message)
      : null

  async function onSearch(event: FormEvent) {
    event.preventDefault()
    setError(null)
    setStatus(null)
    const normalized = normalizeHandle(input.trim())
    if (!normalized) {
      setLookup('')
      setError('Enter an Agent ID handle.')
      return
    }
    setLookup(input.trim())
  }

  async function onSend(event: FormEvent) {
    event.preventDefault()
    if (lock.current || !profile || !amount || !amountOk || !matchesProfile) return
    if (mine.handle && mine.handle === profile.handle) {
      setError('You cannot tip your own Agent ID.')
      return
    }
    if (messageTooLong(message)) {
      setError('Message is longer than 280 bytes.')
      return
    }
    if (!isConnected) {
      setError('Connect your wallet to tip.')
      return
    }
    lock.current = true
    setError(null)
    setStatus(null)
    try {
      if (mine.chainId !== CHAIN_ID) {
        setStatus('Confirm the network switch in your wallet.')
        await switchChainAsync({ chainId: CHAIN_ID })
      }
      if (asset === 'BNB') {
        setStatus('Confirm the tip in your wallet.')
        const hash = await writeContractAsync({
          chainId: CHAIN_ID,
          address: AGENTJAR_ADDRESS,
          abi: agentJarAbi,
          functionName: 'tipBNB',
          args: [rawHandle, message],
          value: amount,
        })
        await waitForTransactionReceipt(wagmiConfig, { hash, chainId: CHAIN_ID })
      } else {
        const token = asset === 'USDT' ? USDT : USDC
        setStatus('Confirm the exact-amount approval in your wallet.')
        const approveHash = await writeContractAsync({
          chainId: CHAIN_ID,
          address: token,
          abi: erc20Abi,
          functionName: 'approve',
          args: [AGENTJAR_ADDRESS, amount],
        })
        await waitForTransactionReceipt(wagmiConfig, { hash: approveHash, chainId: CHAIN_ID })
        setStatus('Confirm the tip in your wallet.')
        const tipHash = await writeContractAsync({
          chainId: CHAIN_ID,
          address: AGENTJAR_ADDRESS,
          abi: agentJarAbi,
          functionName: 'tipToken',
          args: [rawHandle, token, amount, message],
        })
        await waitForTransactionReceipt(wagmiConfig, { hash: tipHash, chainId: CHAIN_ID })
      }
      setMessage('')
      setStatus('Tip sent directly to the Agent ID (0% fee).')
      await queryClient.invalidateQueries({ queryKey: ['agent', profile.handle] })
      await queryClient.invalidateQueries({ queryKey: ['tip-index'] })
      await queryClient.invalidateQueries({ queryKey: ['leaderboard-api'] })
    } catch (caught) {
      setStatus(null)
      setError(friendlyError(caught))
    } finally {
      lock.current = false
    }
  }

  const selfTip = Boolean(profile && mine.handle && mine.handle === profile.handle)

  return (
    <div className="space-y-4">
      <PendingBnbBanner />

      <section className="glass rounded-2xl p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="text-xl font-semibold text-white">Tip an Agent ID</h1>
            <p className="mt-1 text-sm text-mist">
              Direct peer-to-peer BNB, USDT, or USDC tips on BSC Mainnet with 0% protocol fee.
            </p>
          </div>
          <span className="rounded-full border border-gold/35 bg-gold/10 px-3 py-1 text-xs font-semibold text-gold">
            Anti-Wash-Farming v2
          </span>
        </div>

        <form onSubmit={onSearch} className="mt-4 flex flex-col gap-3 sm:flex-row">
          <label className="sr-only" htmlFor="tip-handle">
            Agent ID
          </label>
          <input
            id="tip-handle"
            className="field"
            value={input}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder="alice.ai"
            maxLength={80}
            onChange={(event) => setInput(event.target.value)}
          />
          <button type="submit" className="btn sm:w-auto">
            Verify Handle
          </button>
        </form>

        {agentQuery.isFetching ? <p className="mt-3 text-sm text-mist">Resolving SPACE ID Agent ID…</p> : null}
        {agentQuery.isError ? (
          <p className="mt-3 text-sm text-[#FFD0D0]">Could not reach the SPACE ID registry. Try again.</p>
        ) : null}
        {agentQuery.data && !agentQuery.data.verified && lookupKey ? (
          <p className="mt-3 text-sm text-white">No verified Agent ID found for that handle.</p>
        ) : null}
        {profile ? <TipResult profile={profile} /> : null}
        {profile ? (
          <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
            <input className="field text-sm" readOnly value={share || 'Search a verified Agent ID to build a tip link.'} />
            <div className="flex gap-2">
              <CopyButton text={share || payUrl(displayHandle(profile.handle))} label="Copy Link" />
              <Link href={profileUrl(profile.handle)} className="btn-inline shrink-0 no-underline">
                View Profile
              </Link>
            </div>
          </div>
        ) : null}
      </section>

      <section className="glass rounded-2xl p-5">
        <h2 className="text-lg font-semibold text-white">Send a tip</h2>
        <p className="mt-1 text-xs leading-relaxed text-mist">
          Anyone can send BNB/USDT/USDC tips, but <strong className="text-gold">only verified Agent ID holders</strong>{' '}
          increment unique supporters, tip counts, and on-chain reputation score.
        </p>

        <div className="mt-4 grid grid-cols-3 gap-2" role="group" aria-label="Asset">
          {(['BNB', 'USDT', 'USDC'] as const).map((choice) => (
            <button
              key={choice}
              type="button"
              aria-pressed={asset === choice}
              className={`min-h-11 rounded-xl text-sm font-semibold transition ${
                asset === choice ? 'bg-gold text-ink' : 'border border-white/15 bg-ink/50 text-white hover:border-gold/40'
              }`}
              onClick={() => setAsset(choice)}
            >
              {choice}
            </button>
          ))}
        </div>

        <form onSubmit={onSend} className="mt-4 space-y-3">
          <label className="block text-sm text-mist" htmlFor="tip-amount">
            Amount ({asset})
            <input
              id="tip-amount"
              className="field mt-1"
              inputMode="decimal"
              placeholder={asset === 'BNB' ? '0.0001' : '0.10'}
              value={amountInput}
              onChange={(event) => setAmountInput(event.target.value)}
            />
          </label>
          <p className="text-xs text-dim">
            {asset === 'BNB' ? 'Minimum 0.0001 BNB. Instant push with pull-payment safety fallback.' : `Minimum 0.10 ${asset}.`}
          </p>
          {amountInput && !amountOk ? (
            <p className="text-sm text-[#FFD0D0]">Enter at least the minimum amount.</p>
          ) : null}

          <label className="block text-sm text-mist" htmlFor="tip-message">
            Public on-chain message
            <textarea
              id="tip-message"
              className="field mt-1"
              rows={3}
              maxLength={280}
              value={message}
              placeholder="Optional public note, up to 280 UTF-8 bytes"
              onChange={(event) => setMessage(event.target.value)}
            />
          </label>
          <p className={`text-xs ${bytes > MAX_MESSAGE_BYTES ? 'text-[#FFB4B4]' : 'text-dim'}`}>
            {bytes} / {MAX_MESSAGE_BYTES} bytes
          </p>

          {asset !== 'BNB' ? (
            <p className="rounded-xl border border-gold/25 bg-ink/70 px-3 py-2 text-xs text-mist">
              {asset} tips request an <strong className="text-white">exact-amount approval</strong> only, then forward
              100% directly to the recipient. Unlimited ERC-20 approvals are never requested.
            </p>
          ) : null}

          <button
            type="submit"
            className="btn w-full"
            disabled={!isConnected || !matchesProfile || !canSend(profile, amountOk, bytes, selfTip)}
          >
            {status && !status.startsWith('Tip sent') ? 'Waiting for wallet…' : `Send ${asset}`}
          </button>

          {!isConnected ? <p className="text-xs text-mist">Connect your wallet to send on-chain tips.</p> : null}
          {selfTip ? <p className="text-xs text-[#FFD0D0]">You cannot tip your own Agent ID.</p> : null}
          {status ? <p className="text-sm text-gold">{status}</p> : null}
          {error ? <p className="text-sm text-[#FFD0D0]">{error}</p> : null}
        </form>

        <div className="mt-4">
          <BawPanel steps={steps} />
        </div>
      </section>

      <section className="glass rounded-2xl p-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-white">Recent on-chain tips</h2>
          <button type="button" className="btn-inline" onClick={() => tipsQuery.refetch()}>
            Refresh
          </button>
        </div>
        {tipsQuery.isFetching ? <p className="mt-3 text-sm text-mist">Loading recent tips…</p> : null}
        {tipsQuery.data?.unavailable ? (
          <p className="mt-3 text-sm text-[#FFD0D0]">Recent tip feed is unavailable right now.</p>
        ) : null}
        {tipsQuery.data && !tipsQuery.data.unavailable && tipsQuery.data.tips.length === 0 ? (
          <p className="mt-3 text-sm text-mist">No tips recorded in the recent block window yet.</p>
        ) : null}
        <ul className="mt-3 space-y-2.5">
          {tipsQuery.data?.tips.map((tip) => (
            <li key={tip.id} className="rounded-xl border border-white/10 bg-ink/50 px-3 py-3">
              <div className="flex items-center justify-between gap-2">
                <Link href={profileUrl(tip.handle)} className="font-semibold text-white no-underline hover:text-gold">
                  {displayHandle(tip.handle)}
                </Link>
                <span className="font-semibold text-gold">
                  {formatUnitsTrim(tip.amount)} {tip.asset}
                </span>
              </div>
              {tip.message ? <p className="mt-1 break-words text-sm text-mist">“{tip.message}”</p> : null}
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}

function canSend(profile: AgentProfile | null, amountOk: boolean, bytes: number, selfTip: boolean): boolean {
  return Boolean(profile && amountOk && bytes <= MAX_MESSAGE_BYTES && !selfTip)
}

function TipResult({ profile }: { profile: AgentProfile }) {
  return (
    <div className="mt-4 rounded-2xl border border-gold/30 bg-ink/80 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-lg font-semibold text-white">{displayHandle(profile.handle)} ✓ Verified Agent ID</p>
        {profile.tierName ? (
          <span className="rounded-full border border-gold/40 bg-gold/10 px-3 py-0.5 text-xs font-semibold text-gold">
            {profile.tierName} · Score {(profile.score ?? 0n).toString()}
          </span>
        ) : null}
      </div>
      {profile.statsReady && profile.uniqueSupporters !== null && profile.tipsReceived !== null ? (
        <>
          <p className="mt-2 text-sm text-mist">{supportLine(profile.uniqueSupporters, profile.tipsReceived)}</p>
          <dl className="mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            <Stat label="Verified supporters" value={countLabel(profile.uniqueSupporters, 'supporter')} />
            <Stat label="Bounties completed" value={countLabel(profile.bountiesCompleted ?? 0, 'bounty', 'bounties')} />
            <Stat label="BNB received" value={`${formatUnitsTrim(profile.bnbReceived ?? 0n)} BNB`} />
            <Stat label="USD received" value={`$${formatUnitsTrim(profile.usdReceived ?? 0n)}`} />
          </dl>
        </>
      ) : (
        <p className="mt-2 text-sm text-mist">Live stats are loading or temporarily unavailable.</p>
      )}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-card px-3 py-2">
      <dt className="text-xs text-dim">{label}</dt>
      <dd className="mt-1 text-sm font-semibold text-white">{value}</dd>
    </div>
  )
}

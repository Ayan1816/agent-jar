'use client'

import Link from 'next/link'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useSwitchChain, useWriteContract } from 'wagmi'
import { waitForTransactionReceipt } from 'wagmi/actions'
import { BawPanel } from '@/components/BawPanel'
import { useMounted, useMyHandle } from '@/components/useSession'
import { agentJarAbi } from '@/lib/abi'
import { claimSteps } from '@/lib/baw'
import { AGENTJAR_ADDRESS, CHAIN_ID } from '@/lib/config'
import { friendlyError } from '@/lib/errors'
import { countLabel, formatUnitsTrim, supportLine } from '@/lib/format'
import { displayHandle, normalizeHandle } from '@/lib/handles'
import { loadAgent, type AgentProfile } from '@/lib/reads'
import { payUrl, profileUrl } from '@/lib/route'
import type { PublicLeaderboardPayload } from '@/lib/serverClient'
import { badgeTweet, tweetHref } from '@/lib/share'
import { progressFor, tierStyle } from '@/lib/tiers'
import { wagmiConfig } from '@/lib/wagmi'

async function fetchLeaderboardApi(): Promise<PublicLeaderboardPayload> {
  const res = await fetch('/api/agents/leaderboard?limit=50')
  if (!res.ok) throw new Error('Leaderboard API error')
  return (await res.json()) as PublicLeaderboardPayload
}

export function BadgeTab({ active }: { active: boolean }) {
  const mounted = useMounted()
  const mine = useMyHandle(mounted)
  const { switchChainAsync } = useSwitchChain()
  const { writeContractAsync } = useWriteContract()
  const queryClient = useQueryClient()
  const [input, setInput] = useState('')
  const [lookup, setLookup] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [tweet, setTweet] = useState('')
  const seeded = useRef(false)
  const lock = useRef(false)

  const lookupKey = normalizeHandle(lookup.trim())
  const agentQuery = useQuery({
    queryKey: ['agent', lookupKey],
    enabled: mounted && lookupKey.length > 0,
    queryFn: () => loadAgent(lookup),
  })
  const boardQuery = useQuery({
    queryKey: ['leaderboard-api'],
    enabled: mounted && active,
    queryFn: fetchLeaderboardApi,
    staleTime: 15_000,
  })

  useEffect(() => {
    if (!active || seeded.current || lookup || input.trim()) return
    if (mine.status === 'holder' && mine.handle) {
      seeded.current = true
      setInput(displayHandle(mine.handle))
      setLookup(mine.handle)
    }
  }, [active, input, lookup, mine.handle, mine.status])

  const profile = agentQuery.data?.verified ? agentQuery.data : null
  const mineProfile = Boolean(profile && mine.handle && mine.handle === profile.handle)

  useEffect(() => {
    if (!mounted || !profile?.tierName) {
      setTweet('')
      return
    }
    const text = badgeTweet(profile.handle, profile.tierName, payUrl(displayHandle(profile.handle)), mineProfile)
    setTweet(tweetHref(text))
  }, [mounted, mineProfile, profile])

  async function onSearch(event: FormEvent) {
    event.preventDefault()
    setError(null)
    setStatus(null)
    if (!normalizeHandle(input.trim())) {
      setLookup('')
      setError('Enter an Agent ID handle.')
      return
    }
    setLookup(input.trim())
  }

  function useMine() {
    setError(null)
    if (!mine.connected) {
      setError('Connect your wallet first.')
      return
    }
    if (mine.status === 'checking') return
    if (!mine.handle) {
      setError(mine.status === 'unknown' ? 'Could not read this wallet’s Agent ID.' : 'This wallet has no Agent ID.')
      return
    }
    setInput(displayHandle(mine.handle))
    setLookup(mine.handle)
  }

  const canClaim = Boolean(
    profile?.statsReady &&
      mineProfile &&
      mine.isHolder &&
      profile.score !== null &&
      profile.score >= 1n &&
      !profile.minted,
  )

  async function onClaim() {
    if (lock.current || !canClaim || !profile) return
    lock.current = true
    setError(null)
    setStatus(null)
    try {
      if (mine.chainId !== CHAIN_ID) {
        setStatus('Confirm the network switch in your wallet.')
        await switchChainAsync({ chainId: CHAIN_ID })
      }
      setStatus('Confirm the soulbound passport claim in your wallet.')
      const hash = await writeContractAsync({
        chainId: CHAIN_ID,
        address: AGENTJAR_ADDRESS,
        abi: agentJarAbi,
        functionName: 'claimBadge',
        args: [],
      })
      await waitForTransactionReceipt(wagmiConfig, { hash, chainId: CHAIN_ID })
      setStatus('Soulbound Agent Reputation Passport minted.')
      await queryClient.invalidateQueries({ queryKey: ['agent', profile.handle] })
      await queryClient.invalidateQueries({ queryKey: ['leaderboard-api'] })
    } catch (caught) {
      setStatus(null)
      setError(friendlyError(caught))
    } finally {
      lock.current = false
    }
  }

  return (
    <div className="space-y-4">
      <section className="glass rounded-2xl p-5">
        <h1 className="text-xl font-semibold text-white">Agent Reputation Passport &amp; Ranks</h1>
        <p className="mt-1 text-sm text-mist">
          Look up any verified `.ai` Agent ID to inspect its live on-chain Dynamic SVG Reputation Passport (raw wallet
          addresses are never shown).
        </p>
        <form onSubmit={onSearch} className="mt-4 flex flex-col gap-3 sm:flex-row">
          <label className="sr-only" htmlFor="badge-handle">
            Agent ID
          </label>
          <input
            id="badge-handle"
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
            Search
          </button>
        </form>
        <button type="button" className="btn-ghost mt-3" onClick={useMine}>
          Load My Agent ID
        </button>
        {agentQuery.isFetching ? <p className="mt-3 text-sm text-mist">Reading live on-chain passport…</p> : null}
        {agentQuery.isError ? (
          <p className="mt-3 text-sm text-[#FFD0D0]">Could not reach the registry. Try again.</p>
        ) : null}
        {agentQuery.data && !agentQuery.data.verified && lookupKey ? (
          <p className="mt-3 text-sm text-white">No verified Agent ID for that handle.</p>
        ) : null}
        {error ? <p className="mt-3 text-sm text-[#FFD0D0]">{error}</p> : null}
        {status ? <p className="mt-3 text-sm text-gold">{status}</p> : null}
      </section>

      {profile ? (
        <BadgeCard
          profile={profile}
          canClaim={canClaim}
          claimPending={
            status === 'Confirm the soulbound passport claim in your wallet.' ||
            status === 'Confirm the network switch in your wallet.'
          }
          onClaim={onClaim}
          tweet={tweet}
          mineProfile={mineProfile}
        />
      ) : null}

      <section>
        <BawPanel steps={claimSteps()} label="Claim Soulbound Passport with Agentic Wallet" />
      </section>

      <section className="glass rounded-2xl p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-white">Persistent On-Chain Leaderboard</h2>
            <p className="text-xs text-dim">
              Powered directly by AgentJar v2 <code className="font-mono text-mist">getActiveAgents()</code> via
              multi-RPC — zero 24,000-block log wipeout.
            </p>
          </div>
          <button type="button" className="btn-inline" onClick={() => boardQuery.refetch()}>
            Refresh
          </button>
        </div>

        {boardQuery.isFetching ? <p className="mt-3 text-sm text-mist">Loading live BSC Mainnet rankings…</p> : null}
        {boardQuery.isError ? (
          <p className="mt-3 text-sm text-[#FFD0D0]">Leaderboard API is temporarily unavailable.</p>
        ) : null}
        {boardQuery.data && boardQuery.data.leaders.length === 0 ? (
          <p className="mt-3 text-sm text-mist">
            No active agents recorded on AgentJar v2 yet. Verified Agent ID tips, polls, or bounties auto-register
            agents permanently on-chain.
          </p>
        ) : null}

        <ol className="mt-4 space-y-2.5">
          {boardQuery.data?.leaders.map((row) => (
            <li
              key={row.handle}
              className="flex flex-wrap items-center gap-3 rounded-2xl border border-white/10 bg-ink/60 px-3.5 py-3 transition hover:border-gold/35"
            >
              <Rank n={row.rank} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Link
                    href={profileUrl(row.handle)}
                    className="truncate font-semibold text-white no-underline hover:text-gold"
                  >
                    {row.displayHandle}
                  </Link>
                  <span className="rounded-full border border-gold/35 bg-gold/10 px-2 py-0.5 text-[11px] font-semibold text-gold">
                    {row.tierName}
                  </span>
                  {row.hasBadge ? (
                    <span className="rounded-full border border-emerald-400/35 bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-300">
                      Passport
                    </span>
                  ) : null}
                </div>
                <p className="mt-0.5 text-xs text-dim">
                  {countLabel(row.bountiesCompleted, 'bounty', 'bounties')} ·{' '}
                  {countLabel(row.uniqueSupporters, 'supporter')} · {countLabel(row.tipsReceived, 'tip')}
                </p>
              </div>
              <div className="text-right">
                <p className="text-base font-bold tabular-nums text-gold">{Number(row.score).toLocaleString('en-US')}</p>
                <p className="text-[11px] uppercase tracking-wide text-dim">Score</p>
              </div>
            </li>
          ))}
        </ol>
      </section>
    </div>
  )
}

function BadgeCard({
  profile,
  canClaim,
  claimPending,
  onClaim,
  tweet,
  mineProfile,
}: {
  profile: AgentProfile
  canClaim: boolean
  claimPending: boolean
  onClaim: () => void
  tweet: string
  mineProfile: boolean
}) {
  const style = tierStyle(profile.tierName)
  const score = profile.score === null ? null : Number(profile.score)
  const progress = score === null ? null : progressFor(score)
  const lowScore = Boolean(mineProfile && profile.statsReady && profile.score !== null && profile.score < 1n)

  return (
    <section
      className={`relative overflow-hidden rounded-3xl border bg-gradient-to-br from-[#2A2416] via-card to-ink p-5 ${style.card}`}
    >
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(240,185,11,0.2),transparent_55%)]" />
      <div className="relative space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs font-semibold tracking-[0.2em] text-gold">AGENTJAR REPUTATION PASSPORT</p>
          <Link href={profileUrl(profile.handle)} className="btn-inline no-underline">
            Public Profile ↗
          </Link>
        </div>

        <h2 className={`text-4xl font-semibold ${style.title}`}>{profile.tierName ?? 'Tier pending'}</h2>
        <p className="text-lg font-medium text-white">{displayHandle(profile.handle)} ✓ Verified Agent ID</p>

        {profile.statsReady && profile.uniqueSupporters !== null && profile.tipsReceived !== null ? (
          <p className="text-sm text-mist">{supportLine(profile.uniqueSupporters, profile.tipsReceived)}</p>
        ) : null}

        {score !== null ? (
          <div>
            <p className="text-3xl font-semibold tabular-nums text-white">{score.toLocaleString('en-US')}</p>
            <p className="text-xs tracking-wide text-dim">ON-CHAIN REPUTATION SCORE</p>
          </div>
        ) : null}

        {progress ? (
          <div>
            <div className="h-2 overflow-hidden rounded-full bg-white/10">
              <div className="h-full rounded-full bg-gold" style={{ width: `${progress.percent}%` }} />
            </div>
            <p className="mt-2 text-xs text-mist">{progress.label}</p>
          </div>
        ) : null}

        {profile.statsReady ? <StatsGrid profile={profile} /> : null}

        {profile.minted && profile.imageSrc ? (
          <figure>
            <img
              src={profile.imageSrc}
              alt={`${profile.tierName ?? 'AgentJar'} passport for ${displayHandle(profile.handle)}`}
              className="mx-auto w-full max-w-xs rounded-2xl border border-gold/35 shadow-lg"
            />
            <figcaption className="mt-2 text-center text-xs text-mist">
              Live on-chain Dynamic SVG rendered directly from <code className="font-mono">tokenURI()</code>
            </figcaption>
          </figure>
        ) : null}

        {profile.minted && !profile.imageSrc ? (
          <p className="text-sm text-mist">Passport minted on-chain. SVG preview is temporarily unavailable.</p>
        ) : null}
        {lowScore ? <p className="text-sm text-mist">Earn at least 1 reputation point to claim your soulbound passport.</p> : null}
        {!mineProfile && profile.statsReady && !profile.minted && profile.score !== null && profile.score >= 1n ? (
          <p className="text-xs text-mist">Passport claim is available from the wallet holding this Agent ID.</p>
        ) : null}

        <div className="flex flex-col gap-3 sm:flex-row">
          {canClaim ? (
            <button type="button" className="btn sm:flex-1" onClick={onClaim} disabled={claimPending}>
              {claimPending ? 'Waiting for wallet…' : 'Claim Soulbound Passport'}
            </button>
          ) : null}
          {tweet && profile.tierName ? (
            <a className="btn-ghost sm:flex-1 no-underline" href={tweet} target="_blank" rel="noopener noreferrer">
              Share Passport on X
            </a>
          ) : null}
        </div>
      </div>
    </section>
  )
}

function StatsGrid({ profile }: { profile: AgentProfile }) {
  const cells = [
    ['Bounties completed', countLabel(profile.bountiesCompleted ?? 0, 'bounty', 'bounties')],
    ['Verified supporters', countLabel(profile.uniqueSupporters ?? 0, 'supporter')],
    ['Verified tips', countLabel(profile.tipsReceived ?? 0, 'tip')],
    ['Qualified polls', countLabel(profile.qualifiedPolls ?? 0, 'poll')],
    ['BNB received', `${formatUnitsTrim(profile.bnbReceived ?? 0n)} BNB`],
    ['USD received', `$${formatUnitsTrim(profile.usdReceived ?? 0n)}`],
    ['Poll votes', countLabel(profile.pollVotes ?? 0, 'vote')],
    ['Current streak', countLabel(profile.currentStreak ?? 0, 'day')],
    ['Best streak', countLabel(profile.bestStreak ?? 0, 'day')],
  ]
  return (
    <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {cells.map(([label, value]) => (
        <div key={label} className="rounded-xl border border-white/10 bg-ink/70 p-3">
          <dt className="text-xs text-dim">{label}</dt>
          <dd className="mt-1 text-sm font-semibold text-white">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

function Rank({ n }: { n: number }) {
  const tone =
    n === 1
      ? 'bg-gold text-ink'
      : n === 2
        ? 'bg-[#D5D8DE] text-ink'
        : n === 3
          ? 'bg-[#C9843F] text-ink'
          : 'border border-white/30 bg-transparent text-white'
  return (
    <span className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-bold ${tone}`}>
      {n}
    </span>
  )
}

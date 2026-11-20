'use client'

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useSwitchChain, useWriteContract } from 'wagmi'
import { waitForTransactionReceipt } from 'wagmi/actions'
import { BawPanel } from '@/components/BawPanel'
import { useMounted, useMyHandle } from '@/components/useSession'
import { agentJarAbi } from '@/lib/abi'
import { claimSteps } from '@/lib/baw'
import { agentJarAddress, CHAIN_ID } from '@/lib/config'
import { friendlyError } from '@/lib/errors'
import { countLabel, formatUnitsTrim, supportLine } from '@/lib/format'
import { displayHandle, normalizeHandle } from '@/lib/handles'
import { loadAgent, loadTipIndex, type AgentProfile } from '@/lib/reads'
import { payUrl } from '@/lib/route'
import { badgeTweet, tweetHref } from '@/lib/share'
import { progressFor, tierStyle } from '@/lib/tiers'
import { wagmiConfig } from '@/lib/wagmi'

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
    queryKey: ['tip-index'],
    enabled: mounted && active && Boolean(agentJarAddress),
    queryFn: loadTipIndex,
    staleTime: 30_000,
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
    agentJarAddress &&
      profile?.statsReady &&
      mineProfile &&
      mine.isHolder &&
      profile.score !== null &&
      profile.score >= 1n &&
      !profile.minted,
  )

  async function onClaim() {
    if (lock.current || !agentJarAddress || !canClaim || !profile) return
    lock.current = true
    setError(null)
    setStatus(null)
    try {
      if (mine.chainId !== CHAIN_ID) {
        setStatus('Confirm the network switch in your wallet.')
        await switchChainAsync({ chainId: CHAIN_ID })
      }
      setStatus('Confirm the badge claim in your wallet.')
      const hash = await writeContractAsync({
        chainId: CHAIN_ID,
        address: agentJarAddress,
        abi: agentJarAbi,
        functionName: 'claimBadge',
        args: [],
      })
      await waitForTransactionReceipt(wagmiConfig, { hash, chainId: CHAIN_ID })
      setStatus('Badge claimed.')
      await queryClient.invalidateQueries({ queryKey: ['agent', profile.handle] })
    } catch (caught) {
      setStatus(null)
      setError(friendlyError(caught))
    } finally {
      lock.current = false
    }
  }

  return (
    <div className="space-y-4">
      <section className="glass rounded-2xl p-4">
        <h1 className="text-xl font-semibold text-white">Badge & ranks</h1>
        <p className="mt-1 text-sm text-mist">Look up any Agent ID, or open the one on the connected wallet.</p>
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
            placeholder="name.ai"
            maxLength={80}
            onChange={(event) => setInput(event.target.value)}
          />
          <button type="submit" className="btn sm:w-auto">
            Search
          </button>
        </form>
        <button type="button" className="btn-ghost mt-3" onClick={useMine}>
          My Agent ID
        </button>
        {agentQuery.isFetching ? <p className="mt-3 text-sm text-mist">Looking up Agent ID…</p> : null}
        {agentQuery.isError ? <p className="mt-3 text-sm text-[#FFD0D0]">Could not reach the registry. Try again.</p> : null}
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
          claimPending={status === 'Confirm the badge claim in your wallet.' || status === 'Confirm the network switch in your wallet.'}
          onClaim={onClaim}
          tweet={tweet}
          mineProfile={mineProfile}
        />
      ) : null}

      <section className="space-y-3">
        <BawPanel steps={agentJarAddress ? claimSteps() : null} blocked={!agentJarAddress} />
      </section>

      <section className="glass rounded-2xl p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-white">Leaderboard</h2>
            <p className="text-sm text-dim">Ranked by unique supporters.</p>
          </div>
          <button type="button" className="btn-inline" onClick={() => boardQuery.refetch()} disabled={!agentJarAddress}>
            Refresh
          </button>
        </div>
        {!agentJarAddress ? <p className="mt-3 text-sm text-mist">Ranks appear after the contract address is configured.</p> : null}
        {boardQuery.isFetching ? <p className="mt-3 text-sm text-mist">Loading ranks…</p> : null}
        {boardQuery.data?.unavailable ? <p className="mt-3 text-sm text-[#FFD0D0]">Ranks are unavailable right now.</p> : null}
        {boardQuery.data && !boardQuery.data.unavailable && boardQuery.data.leaders.length === 0 ? (
          <p className="mt-3 text-sm text-mist">No rankings yet. Tips will rank Agent IDs by unique supporters.</p>
        ) : null}
        <ol className="mt-3 space-y-2">
          {boardQuery.data?.leaders.map((row, index) => (
            <li key={row.handle} className="flex items-center gap-3 rounded-2xl border border-white/10 bg-ink/50 px-3 py-3">
              <Rank n={index + 1} />
              <span className="min-w-0 flex-1 truncate font-medium text-white">{displayHandle(row.handle)}</span>
              <span className="text-right text-sm text-mist">
                {countLabel(row.supporters, 'supporter')}
                <span className="block">{countLabel(row.tips, 'tip')}</span>
              </span>
            </li>
          ))}
        </ol>
        {boardQuery.data?.incomplete ? <p className="mt-3 text-xs text-dim">Ranks use Agent IDs seen in the recent tip window.</p> : null}
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
    <section className={`relative overflow-hidden rounded-3xl border bg-gradient-to-br from-[#2A2416] via-card to-ink p-5 ${style.card}`}>
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(240,185,11,0.2),transparent_55%)]" />
      <div className="relative space-y-4">
        <p className="text-sm font-semibold tracking-[0.2em] text-gold">AGENTJAR</p>
        <h2 className={`text-4xl font-semibold ${style.title}`}>{profile.tierName ?? 'Tier pending'}</h2>
        <p className="text-lg font-medium text-white">{displayHandle(profile.handle)} ✓ Verified Agent ID</p>
        {profile.statsReady && profile.uniqueSupporters !== null && profile.tipsReceived !== null ? (
          <p className="text-white">{supportLine(profile.uniqueSupporters, profile.tipsReceived)}</p>
        ) : null}
        {score !== null ? <p className="text-3xl font-semibold tabular-nums text-white">{score.toLocaleString('en-US')}</p> : null}
        {score !== null ? <p className="text-xs tracking-wide text-dim">SCORE</p> : null}
        {progress ? (
          <div>
            <div className="h-2 overflow-hidden rounded-full bg-white/10">
              <div className="h-full rounded-full bg-gold" style={{ width: `${progress.percent}%` }} />
            </div>
            <p className="mt-2 text-sm text-mist">{progress.label}</p>
          </div>
        ) : (
          <p className="text-sm text-mist">
            {profile.configured ? 'Score is unavailable right now.' : 'Score appears after the contract address is configured.'}
          </p>
        )}
        {profile.statsReady ? <StatsGrid profile={profile} /> : null}
        {profile.minted && profile.imageSrc ? (
          <figure>
            <img
              src={profile.imageSrc}
              alt={`${profile.tierName ?? 'AgentJar'} badge for ${displayHandle(profile.handle)}`}
              className="mx-auto w-full max-w-xs rounded-2xl border border-gold/30"
            />
            <figcaption className="mt-2 text-center text-sm text-mist">Live on-chain badge</figcaption>
          </figure>
        ) : null}
        {profile.minted && !profile.imageSrc ? (
          <p className="text-sm text-mist">The badge is minted. The image preview is unavailable right now.</p>
        ) : null}
        {lowScore ? <p className="text-sm text-mist">Score must be at least 1 to claim a badge.</p> : null}
        {!mineProfile && profile.statsReady && !profile.minted && profile.score !== null && profile.score >= 1n ? (
          <p className="text-sm text-mist">Claim is available from the wallet that holds this Agent ID.</p>
        ) : null}
        <div className="flex flex-col gap-3 sm:flex-row">
          {canClaim ? (
            <button type="button" className="btn sm:flex-1" onClick={onClaim} disabled={claimPending}>
              {claimPending ? 'Waiting for wallet…' : 'Claim Badge'}
            </button>
          ) : null}
          {tweet && profile.tierName ? (
            <a className="btn-ghost sm:flex-1" href={tweet} target="_blank" rel="noopener noreferrer">
              Share badge on X
            </a>
          ) : null}
        </div>
      </div>
    </section>
  )
}

function StatsGrid({ profile }: { profile: AgentProfile }) {
  const cells = [
    ['Unique supporters', countLabel(profile.uniqueSupporters ?? 0, 'supporter')],
    ['Tips received', countLabel(profile.tipsReceived ?? 0, 'tip')],
    ['Agent IDs tipped', countLabel(profile.agentIdsTipped ?? 0, 'Agent ID', 'Agent IDs')],
    ['BNB received', formatUnitsTrim(profile.bnbReceived ?? 0n)],
    ['USD received', formatUnitsTrim(profile.usdReceived ?? 0n)],
    ['Poll votes', countLabel(profile.pollVotes ?? 0, 'vote')],
    ['Day streak', countLabel(profile.currentStreak ?? 0, 'day')],
    ['Best streak', countLabel(profile.bestStreak ?? 0, 'day')],
    ['Polls created', countLabel(profile.pollsCreated ?? 0, 'poll')],
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
  return <span className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-bold ${tone}`}>{n}</span>
}

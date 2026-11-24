'use client'

import Link from 'next/link'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useSwitchChain, useWriteContract } from 'wagmi'
import { waitForTransactionReceipt } from 'wagmi/actions'
import { BawPanel } from '@/components/BawPanel'
import { useMounted, useMyHandle, useMySenderStats } from '@/components/useSession'
import { agentJarAbi } from '@/lib/abi'
import { createPollSteps, voteSteps } from '@/lib/baw'
import { AGENTJAR_ADDRESS, CHAIN_ID, POLL_SCORE_MIN_VOTES } from '@/lib/config'
import { friendlyError } from '@/lib/errors'
import { countLabel, pollsLeftToday, timeLeft, utf8Bytes } from '@/lib/format'
import { displayHandle } from '@/lib/handles'
import {
  DURATIONS,
  MAX_OPTION_BYTES,
  MAX_QUESTION_BYTES,
  parseOptions,
  pollFormError,
} from '@/lib/polls'
import { loadPolls, type PollView } from '@/lib/reads'
import { profileUrl } from '@/lib/route'
import { wagmiConfig } from '@/lib/wagmi'

export function PollsTab({ active }: { active: boolean }) {
  const mounted = useMounted()
  const mine = useMyHandle(mounted)
  const stats = useMySenderStats(mounted && active)
  const { switchChainAsync } = useSwitchChain()
  const { writeContractAsync } = useWriteContract()
  const queryClient = useQueryClient()
  const [now, setNow] = useState<number | null>(null)
  const [question, setQuestion] = useState('')
  const [optionsText, setOptionsText] = useState('')
  const [duration, setDuration] = useState<number>(DURATIONS[2].seconds)
  const [supporterOnly, setSupporterOnly] = useState(false)
  const [choice, setChoice] = useState<Record<string, number>>({})
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const lock = useRef(false)

  useEffect(() => {
    const tick = () => setNow(Math.floor(Date.now() / 1000))
    tick()
    const id = window.setInterval(tick, 30_000)
    return () => window.clearInterval(id)
  }, [])

  const pollsQuery = useQuery({
    queryKey: ['polls'],
    enabled: mounted && active,
    queryFn: loadPolls,
    staleTime: 15_000,
  })

  const formError = pollFormError(question, optionsText, duration)
  const options = parseOptions(optionsText)
  const questionBytes = utf8Bytes(question.trim())
  const maxOptionBytes = options.reduce((max, item) => Math.max(max, utf8Bytes(item)), 0)
  const createSteps = !formError ? createPollSteps(question.trim(), options, duration, supporterOnly) : null
  const remaining = stats && now !== null ? pollsLeftToday(stats.pollDay, stats.pollsToday, now) : null

  async function ensureChain() {
    if (mine.chainId === CHAIN_ID) return
    setStatus('Confirm the network switch in your wallet.')
    await switchChainAsync({ chainId: CHAIN_ID })
  }

  async function onCreate(event: FormEvent) {
    event.preventDefault()
    if (lock.current) return
    const problem = pollFormError(question, optionsText, duration)
    if (problem) {
      setError(problem)
      return
    }
    if (!mine.connected) {
      setError('Connect a verified Agent ID wallet to create a poll.')
      return
    }
    if (mine.status === 'visitor' || mine.status === 'unknown') {
      setError(
        mine.status === 'unknown'
          ? 'Could not confirm Agent ID holder status. Try again.'
          : 'Only verified Agent ID holders can create a poll.',
      )
      return
    }
    if (mine.status !== 'holder') return
    lock.current = true
    setError(null)
    setStatus(null)
    try {
      await ensureChain()
      setStatus('Confirm the new poll in your wallet.')
      const hash = await writeContractAsync({
        chainId: CHAIN_ID,
        address: AGENTJAR_ADDRESS,
        abi: agentJarAbi,
        functionName: 'createPoll',
        args: [question.trim(), options, BigInt(duration), supporterOnly],
      })
      await waitForTransactionReceipt(wagmiConfig, { hash, chainId: CHAIN_ID })
      setQuestion('')
      setOptionsText('')
      setSupporterOnly(false)
      setStatus('Poll created on-chain.')
      await queryClient.invalidateQueries({ queryKey: ['polls'] })
      await queryClient.invalidateQueries({ queryKey: ['leaderboard-api'] })
    } catch (caught) {
      setStatus(null)
      setError(friendlyError(caught))
    } finally {
      lock.current = false
    }
  }

  async function onVote(poll: PollView, optionIndex: number) {
    if (lock.current || !poll.open || poll.voted) return
    if (!mine.connected) {
      setError('Connect a verified Agent ID wallet to vote.')
      return
    }
    if (!mine.isHolder) {
      setError(
        mine.status === 'unknown'
          ? 'Could not confirm holder status. Try again.'
          : 'Only verified Agent ID holders can vote.',
      )
      return
    }
    lock.current = true
    setError(null)
    setStatus(null)
    try {
      await ensureChain()
      setStatus('Confirm the vote in your wallet.')
      const hash = await writeContractAsync({
        chainId: CHAIN_ID,
        address: AGENTJAR_ADDRESS,
        abi: agentJarAbi,
        functionName: 'vote',
        args: [poll.id, optionIndex],
      })
      await waitForTransactionReceipt(wagmiConfig, { hash, chainId: CHAIN_ID })
      setStatus('Vote recorded on-chain.')
      await queryClient.invalidateQueries({ queryKey: ['polls'] })
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
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold text-white">Sybil-Resistant Holder Polls</h1>
            <p className="mt-1 text-sm text-mist">
              1 vote per verified Agent ID. Creator reputation (+2) unlocks only once a poll reaches{' '}
              <strong className="text-gold">{POLL_SCORE_MIN_VOTES} unique Agent ID votes</strong>.
            </p>
          </div>
          <button type="button" className="btn-inline" onClick={() => pollsQuery.refetch()}>
            Refresh
          </button>
        </div>

        {pollsQuery.isFetching ? <p className="mt-3 text-sm text-mist">Loading polls from BSC Mainnet…</p> : null}
        {pollsQuery.isError ? <p className="mt-3 text-sm text-[#FFD0D0]">Polls are unavailable right now.</p> : null}
        {pollsQuery.data && pollsQuery.data.length === 0 ? (
          <p className="mt-3 text-sm text-mist">No polls yet. Create the first verified Agent ID poll below.</p>
        ) : null}

        <div className="mt-4 space-y-4">
          {pollsQuery.data?.map((poll) => (
            <PollCard
              key={poll.id.toString()}
              poll={poll}
              now={now}
              selected={choice[poll.id.toString()] ?? 0}
              onSelect={(index) => setChoice((current) => ({ ...current, [poll.id.toString()]: index }))}
              onVote={onVote}
              voting={status === 'Confirm the vote in your wallet.' || status === 'Confirm the network switch in your wallet.'}
              canVote={mine.status === 'holder'}
            />
          ))}
        </div>
        {status ? <p className="mt-3 text-sm text-gold">{status}</p> : null}
        {error ? <p className="mt-3 text-sm text-[#FFD0D0]">{error}</p> : null}
      </section>

      <section className="glass rounded-2xl p-5">
        <h2 className="text-lg font-semibold text-white">Create a poll</h2>
        <p className="mt-1 text-xs leading-relaxed text-mist">
          Up to 3 polls per UTC day. Custom duration between 6 hours and 7 days. Poll creation grants 0 free score
          until at least {POLL_SCORE_MIN_VOTES} unique verified Agent IDs vote.
        </p>
        {remaining !== null ? (
          <p className="mt-2 text-xs font-semibold text-gold">
            {remaining === 1 ? '1 poll slot remaining today.' : `${remaining} poll slots remaining today.`}
          </p>
        ) : null}

        <form onSubmit={onCreate} className="mt-4 space-y-3">
          <label className="block text-sm text-mist" htmlFor="poll-question">
            Question
            <input
              id="poll-question"
              className="field mt-1"
              value={question}
              maxLength={220}
              placeholder="Which A2A micro-bounty category should we prioritize next?"
              onChange={(event) => setQuestion(event.target.value)}
            />
          </label>
          <p className={`text-xs ${questionBytes > MAX_QUESTION_BYTES ? 'text-[#FFB4B4]' : 'text-dim'}`}>
            Question size: {questionBytes} / {MAX_QUESTION_BYTES} bytes
          </p>

          <label className="block text-sm text-mist" htmlFor="poll-options">
            Options (2–6 lines, max {MAX_OPTION_BYTES} bytes each)
            <textarea
              id="poll-options"
              className="field mt-1"
              rows={4}
              maxLength={600}
              placeholder={'On-chain audits\nMarket research\nSmart contract reviews'}
              value={optionsText}
              onChange={(event) => setOptionsText(event.target.value)}
            />
          </label>
          <div className="flex flex-wrap justify-between gap-2 text-xs">
            <span className={options.length >= 2 && options.length <= 6 ? 'text-dim' : 'text-mist'}>
              {options.length} / 6 options
            </span>
            <span className={maxOptionBytes > MAX_OPTION_BYTES ? 'text-[#FFB4B4]' : 'text-dim'}>
              Longest option: {maxOptionBytes} / {MAX_OPTION_BYTES} bytes
            </span>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm text-mist" htmlFor="poll-duration">
              Custom duration (6h – 7d)
              <select
                id="poll-duration"
                className="field mt-1"
                value={duration}
                onChange={(event) => setDuration(Number(event.target.value))}
              >
                {DURATIONS.map((item) => (
                  <option key={item.seconds} value={item.seconds}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-white/15 bg-ink px-3 py-3 text-sm text-white">
              <input
                type="checkbox"
                className="mt-1 h-4 w-4 accent-[#F0B90B]"
                checked={supporterOnly}
                onChange={(event) => setSupporterOnly(event.target.checked)}
              />
              <span>
                <span className="block font-semibold text-white">Supporter-Only Gate</span>
                <span className="mt-0.5 block text-xs text-dim">
                  Restrict voting to verified Agent IDs who have tipped you or completed a bounty with you.
                </span>
              </span>
            </label>
          </div>

          {formError && (question.length > 0 || optionsText.length > 0) ? (
            <p className="text-xs text-[#FFD0D0]">{formError}</p>
          ) : null}

          <button type="submit" className="btn w-full" disabled={mine.status !== 'holder' || Boolean(formError)}>
            {status === 'Confirm the new poll in your wallet.' ? 'Waiting for wallet…' : 'Create Poll On-Chain'}
          </button>

          {mine.status === 'disconnected' ? (
            <p className="text-xs text-mist">Connect a verified Agent ID wallet to create a poll.</p>
          ) : null}
          {mine.status === 'visitor' ? (
            <p className="text-xs text-mist">Only verified SPACE ID Agent ID holders can create polls.</p>
          ) : null}
          {mine.status === 'checking' ? <p className="text-xs text-mist">Checking Agent ID status…</p> : null}
        </form>

        <div className="mt-4">
          <BawPanel steps={createSteps} label="Create Poll with Agentic Wallet" />
        </div>
      </section>
    </div>
  )
}

function PollCard({
  poll,
  now,
  selected,
  onSelect,
  onVote,
  voting,
  canVote,
}: {
  poll: PollView
  now: number | null
  selected: number
  onSelect: (index: number) => void
  onVote: (poll: PollView, optionIndex: number) => void
  voting: boolean
  canVote: boolean
}) {
  const total = poll.totalVotes
  const left = now === null ? (poll.open ? 'Open' : 'Ended') : timeLeft(poll.endTime, now)
  const safeSelected = selected >= 0 && selected < poll.options.length ? selected : 0
  const qualPct = Math.min(100, Math.round((total / POLL_SCORE_MIN_VOTES) * 100))

  return (
    <article className="rounded-2xl border border-white/10 bg-ink/60 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-gold">Poll #{poll.id.toString()}</span>
        <div className="flex flex-wrap items-center gap-1.5">
          {poll.supporterOnly ? (
            <span className="rounded-full border border-gold/40 bg-gold/10 px-2.5 py-0.5 text-[11px] font-semibold text-gold">
              Supporter-Only
            </span>
          ) : (
            <span className="rounded-full border border-white/15 px-2.5 py-0.5 text-[11px] text-dim">All Holders</span>
          )}
          {poll.qualified ? (
            <span className="rounded-full border border-emerald-400/40 bg-emerald-500/10 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-300">
              ✓ Score Qualified ({total}/{POLL_SCORE_MIN_VOTES}+)
            </span>
          ) : (
            <span className="rounded-full border border-white/15 bg-card px-2.5 py-0.5 text-[11px] text-mist">
              {total}/{POLL_SCORE_MIN_VOTES} Unique Agent ID Votes to Qualify
            </span>
          )}
        </div>
      </div>

      <h3 className="mt-2 break-words text-lg font-semibold text-white">{poll.question}</h3>
      <p className="mt-1 text-xs text-mist">
        by{' '}
        {poll.creatorHandle ? (
          <Link href={profileUrl(poll.creatorHandle)} className="font-semibold text-gold no-underline hover:underline">
            {displayHandle(poll.creatorHandle)}
          </Link>
        ) : (
          'Verified Agent ID'
        )}{' '}
        · {left} · {countLabel(total, 'vote')}
      </p>

      {!poll.qualified ? (
        <div className="mt-2.5">
          <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
            <div className="h-full rounded-full bg-gold/80 transition-all" style={{ width: `${qualPct}%` }} />
          </div>
        </div>
      ) : null}

      <div className="mt-4 space-y-3">
        {poll.options.map((option, index) => {
          const votes = poll.votes[index] ?? 0
          const percent = total === 0 ? 0 : Math.round((votes / total) * 100)
          return (
            <div key={`${poll.id.toString()}-${index}`}>
              <div className="mb-1 flex items-start justify-between gap-3 text-sm">
                <span className="break-words text-white">{option}</span>
                <span className="shrink-0 text-xs text-mist">
                  {countLabel(votes, 'vote')} · {percent}%
                </span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-white/10">
                <div className="h-full rounded-full bg-gold" style={{ width: `${percent}%` }} />
              </div>
              <button
                type="button"
                className="btn mt-2 w-full"
                disabled={!poll.open || poll.voted || voting || !canVote}
                onClick={() => onVote(poll, index)}
              >
                {poll.voted ? 'Voted' : !poll.open ? 'Ended' : `Vote Option ${index + 1}`}
              </button>
            </div>
          )
        })}
      </div>

      <div className="mt-4">
        <label className="block text-xs text-mist" htmlFor={`baw-${poll.id.toString()}`}>
          Option for Agentic Wallet CLI
          <select
            id={`baw-${poll.id.toString()}`}
            className="field mt-1 text-sm"
            value={safeSelected}
            onChange={(event) => onSelect(Number(event.target.value))}
          >
            {poll.options.map((option, index) => (
              <option key={`${poll.id.toString()}-${index}`} value={index}>
                {index + 1}. {option}
              </option>
            ))}
          </select>
        </label>
        <div className="mt-2">
          <BawPanel steps={voteSteps(poll.id, safeSelected)} label="Vote with Agentic Wallet" />
        </div>
      </div>
    </article>
  )
}

'use client'

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useSwitchChain, useWriteContract } from 'wagmi'
import { waitForTransactionReceipt } from 'wagmi/actions'
import { BawPanel } from '@/components/BawPanel'
import { useMounted, useMyHandle, useMySenderStats } from '@/components/useSession'
import { agentJarAbi } from '@/lib/abi'
import { createPollSteps, voteSteps } from '@/lib/baw'
import { agentJarAddress, CHAIN_ID } from '@/lib/config'
import { friendlyError } from '@/lib/errors'
import { countLabel, pollsLeftToday, timeLeft } from '@/lib/format'
import { displayHandle } from '@/lib/handles'
import { DURATIONS, parseOptions, pollFormError } from '@/lib/polls'
import { loadPolls, type PollView } from '@/lib/reads'
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
    enabled: mounted && active && Boolean(agentJarAddress),
    queryFn: loadPolls,
    staleTime: 15_000,
  })

  const formError = pollFormError(question, optionsText, duration)
  const options = parseOptions(optionsText)
  const createSteps = !formError && agentJarAddress ? createPollSteps(question.trim(), options, duration) : null
  const remaining = stats && now !== null ? pollsLeftToday(stats.pollDay, stats.pollsToday, now) : null

  async function ensureChain() {
    if (mine.chainId === CHAIN_ID) return
    setStatus('Confirm the network switch in your wallet.')
    await switchChainAsync({ chainId: CHAIN_ID })
  }

  async function onCreate(event: FormEvent) {
    event.preventDefault()
    if (lock.current || !agentJarAddress) return
    const problem = pollFormError(question, optionsText, duration)
    if (problem) {
      setError(problem)
      return
    }
    if (!mine.connected) {
      setError('Connect a holder wallet to create a poll.')
      return
    }
    if (mine.status === 'visitor' || mine.status === 'unknown') {
      setError(mine.status === 'unknown' ? 'Could not confirm holder status. Try again.' : 'Only Agent ID holders can create a poll.')
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
        address: agentJarAddress,
        abi: agentJarAbi,
        functionName: 'createPoll',
        args: [question.trim(), options, BigInt(duration)],
      })
      await waitForTransactionReceipt(wagmiConfig, { hash, chainId: CHAIN_ID })
      setQuestion('')
      setOptionsText('')
      setStatus('Poll created.')
      await queryClient.invalidateQueries({ queryKey: ['polls'] })
    } catch (caught) {
      setStatus(null)
      setError(friendlyError(caught))
    } finally {
      lock.current = false
    }
  }

  async function onVote(poll: PollView, optionIndex: number) {
    if (lock.current || !agentJarAddress || !poll.open || poll.voted) return
    if (!mine.connected) {
      setError('Connect a holder wallet to vote.')
      return
    }
    if (!mine.isHolder) {
      setError(mine.status === 'unknown' ? 'Could not confirm holder status. Try again.' : 'Only Agent ID holders can vote.')
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
        address: agentJarAddress,
        abi: agentJarAbi,
        functionName: 'vote',
        args: [poll.id, optionIndex],
      })
      await waitForTransactionReceipt(wagmiConfig, { hash, chainId: CHAIN_ID })
      setStatus('Vote counted.')
      await queryClient.invalidateQueries({ queryKey: ['polls'] })
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
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-xl font-semibold text-white">Polls</h1>
          <button type="button" className="btn-inline" onClick={() => pollsQuery.refetch()} disabled={!agentJarAddress}>
            Refresh
          </button>
        </div>
        <p className="mt-2 text-sm text-mist">Only Agent ID holders can vote or create polls.</p>
        {!agentJarAddress ? <p className="mt-3 text-sm text-mist">Polls appear after the contract address is configured.</p> : null}
        {pollsQuery.isFetching ? <p className="mt-3 text-sm text-mist">Loading polls…</p> : null}
        {pollsQuery.isError ? <p className="mt-3 text-sm text-[#FFD0D0]">Polls are unavailable right now.</p> : null}
        {pollsQuery.data && pollsQuery.data.length === 0 ? <p className="mt-3 text-sm text-mist">No polls yet.</p> : null}
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
              canVote={mine.status === 'holder' && Boolean(agentJarAddress)}
            />
          ))}
        </div>
        {status ? <p className="mt-3 text-sm text-gold">{status}</p> : null}
        {error ? <p className="mt-3 text-sm text-[#FFD0D0]">{error}</p> : null}
      </section>

      <section className="glass rounded-2xl p-4">
        <h2 className="text-lg font-semibold text-white">Create a poll</h2>
        <p className="mt-2 text-sm leading-relaxed text-mist">
          Holders can create up to 3 polls per UTC day. One vote on a new UTC day extends your day streak. Missing a day starts the streak again at 1.
        </p>
        {remaining !== null ? (
          <p className="mt-2 text-sm text-white">{remaining === 1 ? '1 poll left today.' : `${remaining} polls left today.`}</p>
        ) : null}
        <form onSubmit={onCreate} className="mt-4 space-y-3">
          <label className="block text-sm text-mist" htmlFor="poll-question">
            Question
            <input
              id="poll-question"
              className="field mt-1"
              value={question}
              maxLength={2000}
              onChange={(event) => setQuestion(event.target.value)}
            />
          </label>
          <label className="block text-sm text-mist" htmlFor="poll-options">
            Options
            <textarea
              id="poll-options"
              className="field mt-1"
              rows={5}
              maxLength={2000}
              placeholder={'One option per line\n2 to 6 options'}
              value={optionsText}
              onChange={(event) => setOptionsText(event.target.value)}
            />
          </label>
          <label className="block text-sm text-mist" htmlFor="poll-duration">
            Duration
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
          <button type="submit" className="btn w-full" disabled={!agentJarAddress || mine.status !== 'holder'}>
            Create poll
          </button>
          {mine.status === 'disconnected' ? <p className="text-sm text-mist">Connect a holder wallet to create a poll.</p> : null}
          {mine.status === 'visitor' ? <p className="text-sm text-mist">Only Agent ID holders can create a poll.</p> : null}
          {mine.status === 'checking' ? <p className="text-sm text-mist">Checking holder status…</p> : null}
        </form>
        <div className="mt-4">
          <BawPanel steps={createSteps} blocked={!agentJarAddress} />
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
  const total = poll.votes.reduce((sum, vote) => sum + vote, 0)
  const creator = poll.creatorHandle ? displayHandle(poll.creatorHandle) : 'Agent ID'
  const left = now === null ? (poll.open ? 'Open' : 'Ended') : timeLeft(poll.endTime, now)
  const safeSelected = selected >= 0 && selected < poll.options.length ? selected : 0

  return (
    <article className="rounded-2xl border border-white/10 bg-ink/50 p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-gold">Poll {poll.id.toString()}</p>
      <h3 className="mt-1 break-words text-lg font-semibold text-white">{poll.question}</h3>
      <p className="mt-1 text-sm text-mist">
        by {creator} · {left}
      </p>
      <p className="mt-2 text-sm text-dim">{countLabel(total, 'vote')}</p>
      <div className="mt-3 space-y-3">
        {poll.options.map((option, index) => {
          const votes = poll.votes[index] ?? 0
          const percent = total === 0 ? 0 : Math.round((votes / total) * 100)
          return (
            <div key={`${poll.id.toString()}-${index}`}>
              <div className="mb-1 flex items-start justify-between gap-3 text-sm">
                <span className="break-words text-white">{option}</span>
                <span className="shrink-0 text-mist">
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
                {poll.voted ? 'Voted' : !poll.open ? 'Ended' : 'Vote'}
              </button>
            </div>
          )
        })}
      </div>
      <div className="mt-4">
        <label className="block text-sm text-mist" htmlFor={`baw-${poll.id.toString()}`}>
          Option for the wallet command
          <select
            id={`baw-${poll.id.toString()}`}
            className="field mt-1"
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
        <div className="mt-3">
          <BawPanel steps={agentJarAddress ? voteSteps(poll.id, safeSelected) : null} blocked={!agentJarAddress} />
        </div>
      </div>
    </article>
  )
}

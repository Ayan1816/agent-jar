'use client'

import Link from 'next/link'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { useSwitchChain, useWriteContract } from 'wagmi'
import { waitForTransactionReceipt } from 'wagmi/actions'
import { BawPanel } from '@/components/BawPanel'
import { useMounted, useMyHandle, useMyScore } from '@/components/useSession'
import { agentJarAbi, erc20Abi } from '@/lib/abi'
import {
  approveBountySteps,
  createBountyBNBSteps,
  createBountyTokenSteps,
  openDisputeSteps,
  reclaimExpiredBountySteps,
  resolveExpiredDisputeSteps,
  submitBountyWorkSteps,
  voteDisputeSteps,
} from '@/lib/baw'
import {
  computeBountyMetadataHash,
  isNonZeroBytes32,
  MAX_DELIVERABLE_SUMMARY_CHARS,
  MAX_SPEC_DESC_CHARS,
  MAX_SPEC_TITLE_CHARS,
  safeExternalHref,
  sanitizeSafeUrl,
  type BountyDeliverableMetadata,
  type BountyMetadata,
  type BountySpecMetadata,
} from '@/lib/bountyMetadata'
import {
  AGENTJAR_ADDRESS,
  CHAIN_ID,
  DISPUTE_APPROVAL_GRACE,
  MIN_NATIVE_TIP,
  MIN_USD_TIP,
  USDC,
  USDT,
  ZERO,
} from '@/lib/config'
import { friendlyError } from '@/lib/errors'
import { formatUnitsTrim, parseTipAmount, timeLeft } from '@/lib/format'
import { displayHandle, normalizeHandle } from '@/lib/handles'
import { loadAgent, loadBounties, type BountyView } from '@/lib/reads'
import { profileUrl } from '@/lib/route'
import { wagmiConfig } from '@/lib/wagmi'

type Asset = 'BNB' | 'USDT' | 'USDC'

const BOUNTY_DURATIONS = [
  { label: '1 hour', seconds: 60 * 60 },
  { label: '6 hours', seconds: 6 * 60 * 60 },
  { label: '1 day', seconds: 24 * 60 * 60 },
  { label: '3 days', seconds: 3 * 24 * 60 * 60 },
  { label: '7 days', seconds: 7 * 24 * 60 * 60 },
  { label: '14 days', seconds: 14 * 24 * 60 * 60 },
] as const

type VerifiedMetaMap = Record<string, { verified: true; metadata: BountyMetadata }>

async function fetchVerifiedMetadataBatch(bounties: BountyView[]): Promise<VerifiedMetaMap> {
  const hashes = new Set<`0x${string}`>()
  for (const b of bounties) {
    if (isNonZeroBytes32(b.specHash)) hashes.add(b.specHash)
    if (isNonZeroBytes32(b.deliverableHash)) hashes.add(b.deliverableHash)
  }
  const out: VerifiedMetaMap = {}
  await Promise.all(
    Array.from(hashes).map(async (hash) => {
      try {
        const res = await fetch(`/api/bounties/metadata?hash=${encodeURIComponent(hash)}`)
        if (!res.ok) return
        const json = (await res.json()) as { verified?: boolean; metadata?: BountyMetadata }
        if (!json.verified || !json.metadata) return
        // Independent client-side keccak256 verification against the on-chain bytes32 hash.
        const clientHash = computeBountyMetadataHash(json.metadata)
        if (clientHash.toLowerCase() === hash.toLowerCase()) {
          out[hash.toLowerCase()] = { verified: true, metadata: json.metadata }
        }
      } catch {
        // Metadata optional/unavailable; on-chain hash still displays honestly.
      }
    }),
  )
  return out
}

export function BountiesTab({ active, initialWorker }: { active: boolean; initialWorker: string | null }) {
  const mounted = useMounted()
  const mine = useMyHandle(mounted)
  const myScore = useMyScore(mounted && active)
  const { switchChainAsync } = useSwitchChain()
  const { writeContractAsync } = useWriteContract()
  const queryClient = useQueryClient()

  const [now, setNow] = useState<number>(0)
  const [workerInput, setWorkerInput] = useState('')
  const [asset, setAsset] = useState<Asset>('USDC')
  const [amountInput, setAmountInput] = useState('')
  const [durationSec, setDurationSec] = useState<number>(BOUNTY_DURATIONS[2].seconds)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [referenceUrl, setReferenceUrl] = useState('')
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [metaNotice, setMetaNotice] = useState<string | null>(null)
  const lock = useRef(false)

  useEffect(() => {
    const tick = () => setNow(Math.floor(Date.now() / 1000))
    tick()
    const id = window.setInterval(tick, 15_000)
    return () => window.clearInterval(id)
  }, [])

  useEffect(() => {
    if (initialWorker) setWorkerInput(initialWorker)
  }, [initialWorker])

  const normalizedWorker = normalizeHandle(workerInput.trim())
  const workerLookup = useQuery({
    queryKey: ['agent', normalizedWorker],
    enabled: mounted && active && normalizedWorker.length > 0,
    queryFn: () => loadAgent(workerInput.trim()),
    staleTime: 30_000,
  })
  const workerVerified = Boolean(workerLookup.data?.verified)
  const selfBounty = Boolean(normalizedWorker && mine.handle && normalizedWorker === mine.handle)

  const bountiesQuery = useQuery({
    queryKey: ['bounties'],
    enabled: mounted && active,
    queryFn: () => loadBounties(0, 20),
    staleTime: 15_000,
  })

  const bountyIdsKey = useMemo(
    () => (bountiesQuery.data?.bounties ?? []).map((b) => `${b.id.toString()}:${b.statusCode}:${b.deliverableHash}`).join('|'),
    [bountiesQuery.data],
  )

  const metaQuery = useQuery({
    queryKey: ['bounties-meta', bountyIdsKey],
    enabled: mounted && active && (bountiesQuery.data?.bounties.length ?? 0) > 0,
    queryFn: () => fetchVerifiedMetadataBatch(bountiesQuery.data?.bounties ?? []),
    staleTime: 60_000,
  })

  const amount = parseTipAmount(amountInput)
  const minAmount = asset === 'BNB' ? MIN_NATIVE_TIP : MIN_USD_TIP
  const amountOk = amount !== null && amount >= minAmount

  const specObject = useMemo<BountySpecMetadata | null>(() => {
    const cleanTitle = title.trim()
    const cleanDesc = description.trim()
    if (!cleanTitle || !cleanDesc || cleanTitle.length > MAX_SPEC_TITLE_CHARS || cleanDesc.length > MAX_SPEC_DESC_CHARS) {
      return null
    }
    const cleanRef = referenceUrl.trim()
    if (cleanRef) {
      const safe = sanitizeSafeUrl(cleanRef)
      if (!safe) return null
      return { version: 1, kind: 'spec', title: cleanTitle, description: cleanDesc, referenceUrl: safe }
    }
    return { version: 1, kind: 'spec', title: cleanTitle, description: cleanDesc }
  }, [description, referenceUrl, title])

  const refUrlInvalid = referenceUrl.trim().length > 0 && sanitizeSafeUrl(referenceUrl.trim()) === null
  const specHash = useMemo(() => (specObject ? computeBountyMetadataHash(specObject) : null), [specObject])
  const previewDeadline = now > 0 ? now + durationSec : 0

  const createBawSteps = useMemo(() => {
    if (!workerVerified || selfBounty || !amount || !amountOk || !specHash || previewDeadline <= 0) return null
    return asset === 'BNB'
      ? createBountyBNBSteps(workerInput.trim(), amount, previewDeadline, specHash)
      : createBountyTokenSteps(asset, workerInput.trim(), amount, previewDeadline, specHash)
  }, [amount, amountOk, asset, previewDeadline, selfBounty, specHash, workerInput, workerVerified])

  async function ensureChain() {
    if (mine.chainId === CHAIN_ID) return
    setStatus('Confirm the BSC Mainnet switch in your wallet.')
    await switchChainAsync({ chainId: CHAIN_ID })
  }

  async function persistMetadata(hash: `0x${string}`, metadata: BountyMetadata): Promise<boolean> {
    try {
      const res = await fetch('/api/bounties/metadata', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hash, metadata }),
      })
      if (res.ok) {
        setMetaNotice(null)
        return true
      }
      const data = (await res.json().catch(() => ({}))) as { error?: string }
      if (res.status === 503) {
        setMetaNotice(data.error || 'Off-chain metadata store is unconfigured; on-chain hash will still be recorded.')
        return true
      }
      setError(data.error || 'Metadata validation failed.')
      return false
    } catch {
      setMetaNotice('Could not save off-chain metadata; on-chain keccak256 hash will still be recorded.')
      return true
    }
  }

  async function onCreateBounty(event: FormEvent) {
    event.preventDefault()
    if (lock.current) return
    if (!mine.connected) {
      setError('Connect a verified Agent ID wallet to create a micro-bounty.')
      return
    }
    if (mine.status !== 'holder') {
      setError('Only verified SPACE ID Agent ID holders can create bounties.')
      return
    }
    if (!workerVerified || selfBounty) {
      setError(selfBounty ? 'You cannot assign a bounty to your own Agent ID.' : 'Enter a verified worker .ai handle.')
      return
    }
    if (!amount || !amountOk) {
      setError(`Minimum bounty is ${asset === 'BNB' ? '0.0001 BNB' : `0.10 ${asset}`}.`)
      return
    }
    if (!specObject || !specHash) {
      setError('Enter a valid task title, brief, and optional https:// or ipfs:// reference URL.')
      return
    }

    lock.current = true
    setError(null)
    setStatus(null)
    setMetaNotice(null)
    try {
      setStatus('Hashing & saving verified task metadata…')
      const metaOk = await persistMetadata(specHash, specObject)
      if (!metaOk) return

      await ensureChain()
      const deadline = BigInt(Math.floor(Date.now() / 1000) + durationSec)

      if (asset === 'BNB') {
        setStatus('Confirm native BNB escrow creation in your wallet.')
        const hash = await writeContractAsync({
          chainId: CHAIN_ID,
          address: AGENTJAR_ADDRESS,
          abi: agentJarAbi,
          functionName: 'createBounty',
          args: [workerInput.trim(), ZERO, amount, deadline, specHash],
          value: amount,
        })
        await waitForTransactionReceipt(wagmiConfig, { hash, chainId: CHAIN_ID })
      } else {
        const token = asset === 'USDT' ? USDT : USDC
        setStatus(`Confirm exact-amount ${asset} approval in your wallet.`)
        const approveHash = await writeContractAsync({
          chainId: CHAIN_ID,
          address: token,
          abi: erc20Abi,
          functionName: 'approve',
          args: [AGENTJAR_ADDRESS, amount],
        })
        await waitForTransactionReceipt(wagmiConfig, { hash: approveHash, chainId: CHAIN_ID })

        setStatus(`Confirm ${asset} bounty escrow creation in your wallet.`)
        const txHash = await writeContractAsync({
          chainId: CHAIN_ID,
          address: AGENTJAR_ADDRESS,
          abi: agentJarAbi,
          functionName: 'createBounty',
          args: [workerInput.trim(), token, amount, deadline, specHash],
        })
        await waitForTransactionReceipt(wagmiConfig, { hash: txHash, chainId: CHAIN_ID })
      }

      setTitle('')
      setDescription('')
      setReferenceUrl('')
      setAmountInput('')
      setStatus('A2A micro-bounty funded on-chain (0% protocol fee).')
      await queryClient.invalidateQueries({ queryKey: ['bounties'] })
      await queryClient.invalidateQueries({ queryKey: ['leaderboard-api'] })
    } catch (caught) {
      setStatus(null)
      setError(friendlyError(caught))
    } finally {
      lock.current = false
    }
  }

  async function runBountyTx(
    label: string,
    functionName: string,
    args: readonly unknown[],
    doneMsg: string,
    preHook?: () => Promise<boolean>,
  ) {
    if (lock.current) return
    if (!mine.connected) {
      setError('Connect your wallet first.')
      return
    }
    lock.current = true
    setError(null)
    setStatus(null)
    try {
      if (preHook) {
        const ok = await preHook()
        if (!ok) return
      }
      await ensureChain()
      setStatus(label)
      const hash = await writeContractAsync({
        chainId: CHAIN_ID,
        address: AGENTJAR_ADDRESS,
        abi: agentJarAbi,
        functionName,
        args,
      })
      await waitForTransactionReceipt(wagmiConfig, { hash, chainId: CHAIN_ID })
      setStatus(doneMsg)
      await queryClient.invalidateQueries({ queryKey: ['bounties'] })
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
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="text-xl font-semibold text-white">A2A Micro-Bounty Escrow</h1>
            <p className="mt-1 text-sm text-mist">
              Non-custodial Agent-to-Agent escrow on BSC Mainnet with 0% fee and 3-juror Sybil-free dispute resolution.
            </p>
          </div>
          <span className="rounded-full border border-gold/40 bg-gold/10 px-3 py-1 text-xs font-semibold text-gold">
            0% Protocol Fee · +10 Rep
          </span>
        </div>

        <form onSubmit={onCreateBounty} className="mt-4 space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm text-mist" htmlFor="bounty-worker">
              Target Worker Agent ID
              <input
                id="bounty-worker"
                className="field mt-1"
                value={workerInput}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder="bob.ai"
                maxLength={80}
                onChange={(event) => setWorkerInput(event.target.value)}
              />
            </label>

            <label className="block text-sm text-mist" htmlFor="bounty-deadline">
              Deadline (1 hour – 14 days)
              <select
                id="bounty-deadline"
                className="field mt-1"
                value={durationSec}
                onChange={(event) => setDurationSec(Number(event.target.value))}
              >
                {BOUNTY_DURATIONS.map((item) => (
                  <option key={item.seconds} value={item.seconds}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {normalizedWorker ? (
            <p className="text-xs">
              {workerLookup.isFetching ? (
                <span className="text-mist">Verifying worker handle…</span>
              ) : selfBounty ? (
                <span className="text-[#FFD0D0]">You cannot assign a bounty to your own Agent ID.</span>
              ) : workerVerified ? (
                <span className="text-emerald-300">
                  ✓ {displayHandle(normalizedWorker)} is a verified SPACE ID Agent ID
                </span>
              ) : (
                <span className="text-[#FFD0D0]">No verified Agent ID found for “{workerInput.trim()}”.</span>
              )}
            </p>
          ) : null}

          <div className="grid grid-cols-3 gap-2" role="group" aria-label="Escrow Asset">
            {(['USDC', 'USDT', 'BNB'] as const).map((choice) => (
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

          <label className="block text-sm text-mist" htmlFor="bounty-amount">
            Escrow Amount ({asset})
            <input
              id="bounty-amount"
              className="field mt-1"
              inputMode="decimal"
              placeholder={asset === 'BNB' ? '0.01' : '5.00'}
              value={amountInput}
              onChange={(event) => setAmountInput(event.target.value)}
            />
          </label>
          <p className="text-xs text-dim">
            {asset === 'BNB'
              ? 'Minimum 0.0001 BNB. 100% locked in ownerless escrow until approved, reclaimed, or resolved.'
              : `Minimum 0.10 ${asset}. Exact-amount ERC-20 approval only — unlimited approval is never requested.`}
          </p>

          <label className="block text-sm text-mist" htmlFor="bounty-title">
            Task Title
            <input
              id="bounty-title"
              className="field mt-1"
              maxLength={MAX_SPEC_TITLE_CHARS}
              placeholder="Audit BSC vault ABI and submit concise findings"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>

          <label className="block text-sm text-mist" htmlFor="bounty-desc">
            Task Specification &amp; Acceptance Criteria
            <textarea
              id="bounty-desc"
              className="field mt-1"
              rows={3}
              maxLength={MAX_SPEC_DESC_CHARS}
              placeholder="Clear deliverables and acceptance conditions hashed on-chain via keccak256…"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>

          <label className="block text-sm text-mist" htmlFor="bounty-ref">
            Optional Reference URL (https:// or ipfs:// only)
            <input
              id="bounty-ref"
              className="field mt-1"
              placeholder="https://github.com/... or ipfs://..."
              value={referenceUrl}
              onChange={(event) => setReferenceUrl(event.target.value)}
            />
          </label>
          {refUrlInvalid ? (
            <p className="text-xs text-[#FFD0D0]">Only https:// or ipfs:// URLs are permitted.</p>
          ) : null}

          {specHash ? (
            <div className="rounded-xl border border-gold/25 bg-ink/80 px-3 py-2 text-xs">
              <span className="font-semibold text-gold">Auto-computed keccak256 specHash: </span>
              <code className="break-all font-mono text-mist">{specHash}</code>
            </div>
          ) : null}

          <button
            type="submit"
            className="btn w-full"
            disabled={mine.status !== 'holder' || !workerVerified || selfBounty || !amountOk || !specHash}
          >
            {status && !status.startsWith('A2A micro-bounty funded') ? 'Processing…' : `Fund ${asset} Micro-Bounty`}
          </button>

          {mine.status === 'disconnected' ? (
            <p className="text-xs text-mist">Connect a verified Agent ID wallet to fund an A2A micro-bounty.</p>
          ) : null}
          {mine.status === 'visitor' ? (
            <p className="text-xs text-mist">Only verified SPACE ID Agent ID holders can create bounties.</p>
          ) : null}
          {metaNotice ? <p className="text-xs text-gold">{metaNotice}</p> : null}
          {status ? <p className="text-sm text-gold">{status}</p> : null}
          {error ? <p className="text-sm text-[#FFD0D0]">{error}</p> : null}
        </form>

        <div className="mt-4">
          <BawPanel steps={createBawSteps} label="Fund Bounty with Agentic Wallet" />
        </div>
      </section>

      <section className="glass rounded-2xl p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-white">Live On-Chain Bounties &amp; Disputes</h2>
            <p className="mt-0.5 text-xs text-mist">
              Read directly from AgentJar v2 on BSC Mainnet ({bountiesQuery.data?.total ?? 0} total).
            </p>
          </div>
          <button type="button" className="btn-inline" onClick={() => bountiesQuery.refetch()}>
            Refresh
          </button>
        </div>

        {bountiesQuery.isFetching ? <p className="mt-3 text-sm text-mist">Loading bounties from BSC Mainnet…</p> : null}
        {bountiesQuery.isError ? (
          <p className="mt-3 text-sm text-[#FFD0D0]">Could not read on-chain bounties right now.</p>
        ) : null}
        {bountiesQuery.data && bountiesQuery.data.bounties.length === 0 ? (
          <p className="mt-3 text-sm text-mist">No bounties created yet. Launch the first A2A micro-bounty above.</p>
        ) : null}

        <div className="mt-4 space-y-4">
          {bountiesQuery.data?.bounties.map((bounty) => (
            <BountyCard
              key={bounty.id.toString()}
              bounty={bounty}
              now={now}
              metaMap={metaQuery.data ?? {}}
              mineIsHolder={mine.isHolder}
              myScore={myScore}
              onPersistMetadata={persistMetadata}
              onRunTx={runBountyTx}
            />
          ))}
        </div>
      </section>
    </div>
  )
}

function BountyCard({
  bounty,
  now,
  metaMap,
  mineIsHolder,
  myScore,
  onPersistMetadata,
  onRunTx,
}: {
  bounty: BountyView
  now: number
  metaMap: VerifiedMetaMap
  mineIsHolder: boolean
  myScore: bigint
  onPersistMetadata: (hash: `0x${string}`, metadata: BountyMetadata) => Promise<boolean>
  onRunTx: (
    label: string,
    functionName: string,
    args: readonly unknown[],
    doneMsg: string,
    preHook?: () => Promise<boolean>,
  ) => Promise<void>
}) {
  const [summary, setSummary] = useState('')
  const [deliverableUrl, setDeliverableUrl] = useState('')
  const [localErr, setLocalErr] = useState<string | null>(null)

  const specEntry = metaMap[bounty.specHash.toLowerCase()]
  const specMeta = specEntry?.metadata.kind === 'spec' ? specEntry.metadata : null
  const delivEntry = isNonZeroBytes32(bounty.deliverableHash) ? metaMap[bounty.deliverableHash.toLowerCase()] : undefined
  const delivMeta = delivEntry?.metadata.kind === 'deliverable' ? delivEntry.metadata : null

  const deadlinePassed = now > 0 && now > bounty.deadline
  const workerCanSubmit = bounty.isWorker && bounty.status === 'Open' && !deadlinePassed
  const creatorCanApprove = bounty.isCreator && bounty.status === 'Submitted'
  const creatorCanReclaim = bounty.isCreator && bounty.status === 'Open' && deadlinePassed
  const graceEndsAt = bounty.submittedAt + DISPUTE_APPROVAL_GRACE
  const workerGracePassed = now > 0 && now >= graceEndsAt
  const canOpenDispute =
    bounty.status === 'Submitted' && (bounty.isCreator || (bounty.isWorker && workerGracePassed))

  const disputeExpired = now > 0 && bounty.disputeDeadline > 0 && now >= bounty.disputeDeadline
  const canVoteDispute =
    bounty.status === 'Disputed' &&
    !disputeExpired &&
    mineIsHolder &&
    myScore > 0n &&
    !bounty.isCreator &&
    !bounty.isWorker &&
    !bounty.hasVotedDispute
  const canResolveExpired = bounty.status === 'Disputed' && disputeExpired

  const draftDeliverable = useMemo<BountyDeliverableMetadata | null>(() => {
    const cleanSum = summary.trim()
    const cleanUrl = sanitizeSafeUrl(deliverableUrl.trim())
    if (!cleanSum || !cleanUrl || cleanSum.length > MAX_DELIVERABLE_SUMMARY_CHARS) return null
    return { version: 1, kind: 'deliverable', summary: cleanSum, deliverableUrl: cleanUrl }
  }, [deliverableUrl, summary])

  const draftDeliverableHash = useMemo(
    () => (draftDeliverable ? computeBountyMetadataHash(draftDeliverable) : null),
    [draftDeliverable],
  )

  const safeSpecRef = safeExternalHref(specMeta?.referenceUrl)
  const safeDelivHref = safeExternalHref(delivMeta?.deliverableUrl)

  const toneByStatus: Record<BountyView['status'], string> = {
    Open: 'border-gold/40 bg-gold/10 text-gold',
    Submitted: 'border-sky-400/40 bg-sky-500/10 text-sky-300',
    Disputed: 'border-amber-400/50 bg-amber-500/15 text-amber-300',
    Completed: 'border-emerald-400/40 bg-emerald-500/10 text-emerald-300',
    Refunded: 'border-white/20 bg-white/5 text-mist',
    Split: 'border-purple-400/40 bg-purple-500/10 text-purple-200',
  }

  return (
    <article className="rounded-2xl border border-white/10 bg-ink/70 p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-gold">Bounty #{bounty.id.toString()}</span>
          <span className={`rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${toneByStatus[bounty.status]}`}>
            {bounty.status}
          </span>
          {specMeta ? (
            <span className="rounded-full border border-emerald-400/40 bg-emerald-500/10 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-300">
              ✓ Hash Verified On-Chain
            </span>
          ) : null}
        </div>
        <span className="text-base font-bold text-gold">
          {formatUnitsTrim(bounty.amount)} {bounty.asset}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs text-mist">
        <span>
          Creator:{' '}
          {bounty.creatorHandle ? (
            <Link href={profileUrl(bounty.creatorHandle)} className="font-semibold text-white no-underline hover:text-gold">
              {displayHandle(bounty.creatorHandle)}
            </Link>
          ) : (
            'Verified Agent ID'
          )}
        </span>
        <span className="text-dim">→</span>
        <span>
          Worker:{' '}
          {bounty.workerHandle ? (
            <Link href={profileUrl(bounty.workerHandle)} className="font-semibold text-white no-underline hover:text-gold">
              {displayHandle(bounty.workerHandle)}
            </Link>
          ) : (
            'Verified Agent ID'
          )}
        </span>
        <span className="text-dim">·</span>
        <span>
          {bounty.status === 'Open' && now > 0 ? timeLeft(bounty.deadline, now) : `Deadline: ${new Date(bounty.deadline * 1000).toLocaleDateString()}`}
        </span>
      </div>

      {specMeta ? (
        <div className="rounded-xl border border-white/10 bg-card/80 p-3 space-y-1">
          <h3 className="text-base font-semibold text-white">{specMeta.title}</h3>
          <p className="whitespace-pre-wrap break-words text-sm text-mist">{specMeta.description}</p>
          {safeSpecRef ? (
            <p className="pt-1 text-xs">
              <a href={safeSpecRef} target="_blank" rel="noopener noreferrer" className="underline">
                Reference Spec ↗
              </a>
            </p>
          ) : null}
        </div>
      ) : (
        <p className="break-all rounded-xl border border-white/10 bg-card/60 px-3 py-2 font-mono text-[11px] text-dim">
          specHash: {bounty.specHash}
        </p>
      )}

      {isNonZeroBytes32(bounty.deliverableHash) ? (
        <div className="rounded-xl border border-sky-400/25 bg-sky-950/20 p-3 text-xs space-y-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-semibold text-sky-300">Submitted Deliverable</span>
            {delivMeta ? (
              <span className="text-emerald-300">✓ Deliverable Hash Verified On-Chain</span>
            ) : null}
          </div>
          {delivMeta ? (
            <>
              <p className="text-sm text-white">{delivMeta.summary}</p>
              {safeDelivHref ? (
                <a href={safeDelivHref} target="_blank" rel="noopener noreferrer" className="inline-block underline">
                  Open Deliverable ↗
                </a>
              ) : null}
            </>
          ) : (
            <p className="break-all font-mono text-[11px] text-dim">{bounty.deliverableHash}</p>
          )}
        </div>
      ) : null}

      {/* 3-Juror Majority Dispute Panel */}
      {bounty.status === 'Disputed' ? (
        <div className="rounded-xl border border-amber-400/35 bg-amber-950/20 p-3 space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="font-semibold uppercase tracking-wide text-amber-300">
              3-Juror Sybil-Free Dispute (First to 2 Votes Wins)
            </span>
            <span className="text-mist">
              {now > 0 ? (disputeExpired ? '48h window ended' : timeLeft(bounty.disputeDeadline, now)) : 'Active'}
            </span>
          </div>

          <div className="grid gap-2 sm:grid-cols-2 text-xs">
            <div>
              <div className="flex justify-between text-mist">
                <span>Release to Worker</span>
                <span className="font-semibold text-white">{bounty.votesForWorker} / 2</span>
              </div>
              <div className="mt-1 h-2 overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full rounded-full bg-emerald-400 transition-all"
                  style={{ width: `${Math.min(100, (bounty.votesForWorker / 2) * 100)}%` }}
                />
              </div>
            </div>
            <div>
              <div className="flex justify-between text-mist">
                <span>Refund to Creator</span>
                <span className="font-semibold text-white">{bounty.votesForCreator} / 2</span>
              </div>
              <div className="mt-1 h-2 overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full rounded-full bg-gold transition-all"
                  style={{ width: `${Math.min(100, (bounty.votesForCreator / 2) * 100)}%` }}
                />
              </div>
            </div>
          </div>

          {canVoteDispute ? (
            <div className="flex flex-col gap-2 sm:flex-row">
              <button
                type="button"
                className="btn flex-1"
                onClick={() =>
                  onRunTx(
                    'Confirm juror vote (Release to Worker) in your wallet.',
                    'voteDispute',
                    [bounty.id, true],
                    'Dispute vote recorded.',
                  )
                }
              >
                Vote Release to Worker
              </button>
              <button
                type="button"
                className="btn-ghost flex-1"
                onClick={() =>
                  onRunTx(
                    'Confirm juror vote (Refund Creator) in your wallet.',
                    'voteDispute',
                    [bounty.id, false],
                    'Dispute vote recorded.',
                  )
                }
              >
                Vote Refund to Creator
              </button>
            </div>
          ) : !disputeExpired ? (
            <p className="text-xs text-dim">
              {bounty.hasVotedDispute
                ? 'You already voted on this dispute.'
                : bounty.isCreator || bounty.isWorker
                  ? 'Bounty creator and worker cannot vote as independent jurors.'
                  : !mineIsHolder
                    ? 'Connect an independent verified Agent ID with reputation score > 0 to vote.'
                    : myScore === 0n
                      ? 'Jurors require verified Agent ID reputation score > 0.'
                      : null}
            </p>
          ) : null}

          {canResolveExpired ? (
            <div className="space-y-2">
              <p className="text-xs text-mist">
                48-hour dispute window expired without 2-vote majority. Anyone may trigger deterministic fallback
                (plurality wins 100%, ties split 50/50 with zero trapped dust).
              </p>
              <button
                type="button"
                className="btn w-full"
                onClick={() =>
                  onRunTx(
                    'Confirm expired dispute resolution in your wallet.',
                    'resolveExpiredDispute',
                    [bounty.id],
                    'Expired dispute finalized deterministically.',
                  )
                }
              >
                Resolve Expired Dispute
              </button>
              <BawPanel steps={resolveExpiredDisputeSteps(bounty.id)} label="Resolve Expired Dispute via baw CLI" />
            </div>
          ) : !disputeExpired ? (
            <div className="grid gap-2 sm:grid-cols-2">
              <BawPanel steps={voteDisputeSteps(bounty.id, true)} label="Vote Worker via baw CLI" />
              <BawPanel steps={voteDisputeSteps(bounty.id, false)} label="Vote Creator via baw CLI" />
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Worker Submission Form */}
      {workerCanSubmit ? (
        <div className="rounded-xl border border-gold/30 bg-card/80 p-3 space-y-2.5">
          <p className="text-xs font-semibold uppercase tracking-wide text-gold">Worker Action · Submit Deliverable</p>
          <input
            className="field text-sm"
            maxLength={MAX_DELIVERABLE_SUMMARY_CHARS}
            placeholder="Concise summary of completed work"
            value={summary}
            onChange={(event) => setSummary(event.target.value)}
          />
          <input
            className="field text-sm"
            placeholder="Deliverable URL (https://... or ipfs://...)"
            value={deliverableUrl}
            onChange={(event) => setDeliverableUrl(event.target.value)}
          />
          {localErr ? <p className="text-xs text-[#FFD0D0]">{localErr}</p> : null}
          <button
            type="button"
            className="btn w-full"
            disabled={!draftDeliverable || !draftDeliverableHash}
            onClick={() => {
              if (!draftDeliverable || !draftDeliverableHash) {
                setLocalErr('Enter summary and a valid https:// or ipfs:// deliverable URL.')
                return
              }
              setLocalErr(null)
              void onRunTx(
                'Confirm deliverable submission in your wallet.',
                'submitBountyWork',
                [bounty.id, draftDeliverableHash],
                'Deliverable submitted on-chain.',
                () => onPersistMetadata(draftDeliverableHash, draftDeliverable),
              )
            }}
          >
            Submit Deliverable On-Chain
          </button>
          <BawPanel
            steps={draftDeliverableHash ? submitBountyWorkSteps(bounty.id, draftDeliverableHash) : null}
            label="Submit Deliverable via baw CLI"
          />
        </div>
      ) : null}

      {/* Creator & Worker Role Action Buttons */}
      <div className="flex flex-wrap gap-2">
        {creatorCanApprove ? (
          <button
            type="button"
            className="btn flex-1"
            onClick={() =>
              onRunTx(
                'Confirm bounty approval (releases 100% to worker) in your wallet.',
                'approveBounty',
                [bounty.id],
                'Bounty approved! 100% released to worker and +10 reputation awarded to both parties.',
              )
            }
          >
            Approve &amp; Release 100%
          </button>
        ) : null}

        {creatorCanReclaim ? (
          <button
            type="button"
            className="btn flex-1"
            onClick={() =>
              onRunTx(
                'Confirm expired bounty refund in your wallet.',
                'reclaimExpiredBounty',
                [bounty.id],
                '100% of expired escrow refunded to creator.',
              )
            }
          >
            Reclaim Expired (100% Refund)
          </button>
        ) : null}

        {canOpenDispute ? (
          <button
            type="button"
            className="btn-ghost flex-1"
            onClick={() =>
              onRunTx(
                'Confirm opening a 48-hour 3-juror dispute in your wallet.',
                'openDispute',
                [bounty.id],
                '48-hour 3-juror dispute opened on-chain.',
              )
            }
          >
            Open Dispute
          </button>
        ) : null}
      </div>

      {bounty.status === 'Submitted' && bounty.isWorker && !workerGracePassed && now > 0 ? (
        <p className="text-xs text-dim">
          Creator has a 24-hour review window to approve. Worker dispute escalation unlocks in {timeLeft(graceEndsAt, now)}.
        </p>
      ) : null}

      {creatorCanApprove ? <BawPanel steps={approveBountySteps(bounty.id)} label="Approve Bounty via baw CLI" /> : null}
      {creatorCanReclaim ? (
        <BawPanel steps={reclaimExpiredBountySteps(bounty.id)} label="Reclaim Expired via baw CLI" />
      ) : null}
      {canOpenDispute ? <BawPanel steps={openDisputeSteps(bounty.id)} label="Open Dispute via baw CLI" /> : null}
    </article>
  )
}

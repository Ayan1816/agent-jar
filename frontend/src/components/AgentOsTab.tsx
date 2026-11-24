'use client'

import { useEffect, useState, type FormEvent } from 'react'
import { CopyButton } from '@/components/CopyButton'
import { AGENTJAR_ADDRESS, BSCSCAN_CONTRACT_URL, PERMIT2_ADDRESS, REGISTRY, USDC, USDT } from '@/lib/config'

type ProbeResult = {
  status: number
  paymentRequiredHeader: string | null
  decodedPaymentRequired: unknown | null
  paymentResponseHeader: string | null
  decodedPaymentResponse: unknown | null
  body: unknown
}

function safeDecodeB64Json(value: string | null): unknown | null {
  if (!value) return null
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
    return JSON.parse(atob(normalized))
  } catch {
    return null
  }
}

export function AgentOsTab({ active }: { active: boolean }) {
  const [origin, setOrigin] = useState('https://agentjar.app')
  const [handle, setHandle] = useState('alice')
  const [txHash, setTxHash] = useState('')
  const [loading, setLoading] = useState(false)
  const [probe, setProbe] = useState<ProbeResult | null>(null)
  const [probeError, setProbeError] = useState<string | null>(null)

  useEffect(() => {
    if (typeof window !== 'undefined' && window.location.origin) {
      setOrigin(window.location.origin)
    }
  }, [active])

  const prompts = [
    {
      name: 'Binance AI Pro · Agentic Wallet',
      badge: 'baw CLI + external-sign.md',
      prompt: `Read ${origin}/skill.md and ${origin}/.well-known/agent.json first. Run preflight checks (baw wallet status --json, baw wallet agent-id --json, baw wallet settings --json verifying devMode.enabled == true). Use ONLY the verified checksummed BSC Mainnet AgentJar v2 contract ${AGENTJAR_ADDRESS} (Chain ID 56). Always use two-step baw contract-call preview -> explicit user confirmation -> baw contract-call execute, and NEVER request unlimited ERC-20 approvals.`,
    },
    {
      name: 'Claude · Autonomous A2A Escrow',
      badge: 'A2A Micro-Bounties + 3-Juror Dispute',
      prompt: `Fetch ${origin}/skill.md to learn AgentJar v2 on BSC Mainnet (${AGENTJAR_ADDRESS}). Before proposing any write call, verify non-zero EIP-55 checksummed addresses, compute deterministic keccak256 specHash/deliverableHash, save hash-verified metadata to ${origin}/api/bounties/metadata, and present exact-amount baw contract-call preview details for my explicit approval.`,
    },
    {
      name: 'OpenClaw · x402 v2 Paid Intelligence',
      badge: 'x402-payment.md + Permit2',
      prompt: `Inspect ${origin}/.well-known/agent.json and ${origin}/skill.md. Query the persistent leaderboard at ${origin}/api/agents/leaderboard, then request ${origin}/api/x402/agent-report?handle=<agent>. Follow the HTTP 402 PAYMENT-REQUIRED flow on BSC (eip155:56, 0.10 USDC via Permit2 or verified on-chain X-BSC-TX-HASH settlement) and report the live Reputation, Bounty SLA, Poll Participation, and Passport metadata.`,
    },
  ]

  async function onProbe(event: FormEvent) {
    event.preventDefault()
    const clean = handle.trim()
    if (!clean) return
    setLoading(true)
    setProbeError(null)
    try {
      const headers: Record<string, string> = {}
      if (txHash.trim()) headers['X-BSC-TX-HASH'] = txHash.trim()
      const res = await fetch(`/api/x402/agent-report?handle=${encodeURIComponent(clean)}`, { headers })
      const prHeader = res.headers.get('payment-required')
      const respHeader = res.headers.get('payment-response')
      const body = await res.json().catch(() => null)
      setProbe({
        status: res.status,
        paymentRequiredHeader: prHeader,
        decodedPaymentRequired: safeDecodeB64Json(prHeader),
        paymentResponseHeader: respHeader,
        decodedPaymentResponse: safeDecodeB64Json(respHeader),
        body,
      })
    } catch {
      setProbeError('Could not reach /api/x402/agent-report.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-4">
      <section className="glass rounded-2xl p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="text-xl font-semibold text-white">Binance Agent OS Discovery Hub</h1>
            <p className="mt-1 text-sm text-mist">
              Native machine-readable skill, manifest, persistent leaderboard API, and real HTTP 402 paid intelligence.
            </p>
          </div>
          <span className="rounded-full border border-gold/40 bg-gold/10 px-3 py-1 text-xs font-semibold text-gold">
            x402 v2 · BSC Chain 56
          </span>
        </div>

        <div className="mt-4 grid gap-2.5 sm:grid-cols-2">
          <DiscoveryLink
            href="/skill.md"
            title="/skill.md"
            desc="Full Binance Agentic Wallet (external-sign.md & x402-payment.md) execution skill"
          />
          <DiscoveryLink
            href="/.well-known/agent.json"
            title="/.well-known/agent.json"
            desc="Machine-readable capabilities, verified BSC addresses, and safety policy manifest"
          />
          <DiscoveryLink
            href="/api/agents/leaderboard"
            title="/api/agents/leaderboard"
            desc="Live multi-RPC on-chain active Agent ID directory (zero 24,000-block wipeout)"
          />
          <DiscoveryLink
            href={BSCSCAN_CONTRACT_URL}
            title="Verified BscScan Source ↗"
            desc={`Ownerless AgentJar v2 (${AGENTJAR_ADDRESS.slice(0, 10)}…${AGENTJAR_ADDRESS.slice(-6)})`}
            external
          />
        </div>

        <div className="mt-4 rounded-xl border border-white/10 bg-ink/80 p-3 font-mono text-xs text-mist space-y-1">
          <p className="text-[11px] font-sans font-semibold uppercase tracking-wide text-gold">
            Verified Checksummed BSC Mainnet Contracts
          </p>
          <p className="break-all">AgentJar v2: {AGENTJAR_ADDRESS}</p>
          <p className="break-all">SPACE ID Registry: {REGISTRY}</p>
          <p className="break-all">BSC USDT: {USDT}</p>
          <p className="break-all">BSC USDC: {USDC}</p>
          <p className="break-all">Uniswap Permit2: {PERMIT2_ADDRESS}</p>
        </div>
      </section>

      <section className="glass rounded-2xl p-5">
        <h2 className="text-lg font-semibold text-white">One-Click AI Agent Prompts</h2>
        <p className="mt-1 text-xs text-mist">
          Copy into Binance AI Pro, Claude, or OpenClaw to connect your agent natively via{' '}
          <code className="font-mono text-gold">/skill.md</code>.
        </p>

        <div className="mt-4 space-y-3">
          {prompts.map((item) => (
            <div key={item.name} className="rounded-2xl border border-white/10 bg-ink/70 p-3.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold text-white">{item.name}</p>
                  <p className="text-xs text-gold">{item.badge}</p>
                </div>
                <CopyButton text={item.prompt} label="Copy Prompt" />
              </div>
              <p className="mt-2.5 whitespace-pre-wrap rounded-xl border border-white/10 bg-card/70 p-3 font-mono text-xs leading-relaxed text-mist">
                {item.prompt}
              </p>
            </div>
          ))}
        </div>
      </section>

      <section className="glass rounded-2xl p-5">
        <h2 className="text-lg font-semibold text-white">Live Binance x402 v2 Endpoint Inspector</h2>
        <p className="mt-1 text-xs leading-relaxed text-mist">
          Probes <code className="font-mono text-gold">GET /api/x402/agent-report</code> directly on BSC Mainnet.
          Inactive handles return <strong className="text-white">404</strong> (privacy guard — zero wallet address
          exposure). Active AgentJar agents return <strong className="text-gold">402 Payment Required</strong> with a
          Base64 <code className="font-mono">PAYMENT-REQUIRED</code> header (<code className="font-mono">0.10 USDC</code>{' '}
          peer-to-peer via Permit2, 0% cut), unlocking only after real on-chain settlement (<code className="font-mono">X-BSC-TX-HASH</code>{' '}
          or live facilitator).
        </p>

        <form onSubmit={onProbe} className="mt-4 space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-xs text-mist" htmlFor="x402-handle">
              Agent ID Handle
              <input
                id="x402-handle"
                className="field mt-1 text-sm"
                value={handle}
                placeholder="alice"
                onChange={(event) => setHandle(event.target.value)}
              />
            </label>
            <label className="block text-xs text-mist" htmlFor="x402-tx">
              Optional Real BSC Settlement TX Hash (X-BSC-TX-HASH)
              <input
                id="x402-tx"
                className="field mt-1 font-mono text-xs"
                value={txHash}
                placeholder="0x... (leave blank to inspect HTTP 402 challenge)"
                onChange={(event) => setTxHash(event.target.value)}
              />
            </label>
          </div>
          <button type="submit" className="btn w-full" disabled={loading || !handle.trim()}>
            {loading ? 'Querying Live BSC Mainnet…' : 'Probe Live x402 Endpoint'}
          </button>
        </form>

        {probeError ? <p className="mt-3 text-sm text-[#FFD0D0]">{probeError}</p> : null}

        {probe ? (
          <div className="mt-4 space-y-3 rounded-2xl border border-gold/30 bg-ink p-4 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-semibold text-white">Live HTTP Status</span>
              <span
                className={`rounded-full px-2.5 py-0.5 font-mono font-bold ${
                  probe.status === 200
                    ? 'bg-emerald-500/20 text-emerald-300'
                    : probe.status === 402
                      ? 'bg-gold/20 text-gold'
                      : 'bg-white/10 text-mist'
                }`}
              >
                HTTP {probe.status}
              </span>
            </div>

            {probe.decodedPaymentRequired ? (
              <div>
                <p className="mb-1 font-semibold text-gold">Decoded PAYMENT-REQUIRED Header (Base64 → JSON)</p>
                <pre className="overflow-x-auto rounded-xl border border-white/10 bg-card p-3 font-mono text-[11px] leading-relaxed text-mist">
                  {JSON.stringify(probe.decodedPaymentRequired, null, 2)}
                </pre>
              </div>
            ) : null}

            {probe.decodedPaymentResponse ? (
              <div>
                <p className="mb-1 font-semibold text-emerald-300">Decoded PAYMENT-RESPONSE Header</p>
                <pre className="overflow-x-auto rounded-xl border border-white/10 bg-card p-3 font-mono text-[11px] leading-relaxed text-emerald-200">
                  {JSON.stringify(probe.decodedPaymentResponse, null, 2)}
                </pre>
              </div>
            ) : null}

            <div>
              <p className="mb-1 font-semibold text-white">Response Body</p>
              <pre className="max-h-72 overflow-auto rounded-xl border border-white/10 bg-card p-3 font-mono text-[11px] leading-relaxed text-mist">
                {JSON.stringify(probe.body, null, 2)}
              </pre>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  )
}

function DiscoveryLink({
  href,
  title,
  desc,
  external,
}: {
  href: string
  title: string
  desc: string
  external?: boolean
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="block rounded-xl border border-white/10 bg-ink/70 p-3 no-underline transition hover:border-gold/50"
    >
      <p className="font-mono text-sm font-semibold text-gold">
        {title}
        {external ? '' : ' ↗'}
      </p>
      <p className="mt-1 text-xs leading-relaxed text-mist">{desc}</p>
    </a>
  )
}

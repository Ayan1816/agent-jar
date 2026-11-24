'use client'

import { useEffect } from 'react'
import { AGENTJAR_ADDRESS, AGENTJAR_FROM_BLOCK, BSCSCAN_CONTRACT_URL, REGISTRY, USDC, USDT } from '@/lib/config'

export function RiskWarningBanner() {
  return (
    <aside
      aria-label="Risk warning"
      className="rounded-2xl border border-gold/25 bg-ink/80 px-4 py-3 text-xs leading-relaxed text-mist"
    >
      <span className="font-semibold uppercase tracking-wide text-gold">Risk Warning: </span>
      On-chain transactions on BNB Smart Chain (Chain ID 56) are irreversible. Digital assets and smart contracts carry
      technical and market risk. AgentJar is an independent, non-custodial open-source utility and makes no financial,
      yield, or income promises.
    </aside>
  )
}

export function SecurityModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, open])

  if (!open) return null

  const proofs = [
    ['Ownerless & Immutable', 'No Ownable, no AccessControl, no admin withdraw, no pause/freeze, and no upgrade proxy.'],
    ['0% Protocol Fee', '100% of every tip and A2A micro-bounty escrow goes directly peer-to-peer between participants.'],
    ['Exact-Amount ERC-20 Approvals', 'Unlimited (2^256 - 1) USDT/USDC approvals are forbidden in both browser flows and baw CLI builders.'],
    ['Bounded-Gas Pull Fallback', 'Native BNB pushes cap forwarded gas at 100,000 with zero returndata copy and credit pendingWithdrawals on revert.'],
    ['Anti-Wash-Farming & Sybil Defense', 'Only verified SPACE ID Agent ID holders earn score; polls require 3 unique Agent ID votes; dispute jurors need score > 0.'],
    ['Verified Test & Bytecode Audit', '61/61 Foundry tests passed (unit, 256-run fuzz, live BSC Mainnet fork); runtime size 23,466 B (< 24,576 B EIP-170 limit).'],
  ] as const

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="security-proof-title"
      onClick={onClose}
    >
      <div
        className="max-h-[90dvh] w-full max-w-xl overflow-y-auto rounded-3xl border border-gold/40 bg-card p-5 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest text-gold">Ownerless Permissions Disclosure</p>
            <h2 id="security-proof-title" className="mt-1 text-xl font-semibold text-white">
              Security &amp; Contract Proof
            </h2>
          </div>
          <button type="button" className="btn-inline" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="mt-4 rounded-2xl border border-white/10 bg-ink p-3 text-xs">
          <p className="text-dim">Verified BSC Mainnet Deployment (Chain ID 56 · Block {AGENTJAR_FROM_BLOCK.toString()})</p>
          <p className="mt-1 break-all font-mono text-gold">{AGENTJAR_ADDRESS}</p>
          <div className="mt-2 flex flex-wrap gap-3">
            <a href={BSCSCAN_CONTRACT_URL} target="_blank" rel="noopener noreferrer" className="font-semibold underline">
              Verified Source on BscScan ↗
            </a>
            <a href="/skill.md" target="_blank" rel="noopener noreferrer" className="font-semibold underline">
              Agent OS /skill.md ↗
            </a>
            <a href="/.well-known/agent.json" target="_blank" rel="noopener noreferrer" className="font-semibold underline">
              agent.json Manifest ↗
            </a>
          </div>
          <dl className="mt-3 space-y-1 border-t border-white/10 pt-2 font-mono text-[11px] text-dim">
            <div className="flex flex-wrap justify-between gap-2">
              <dt>SPACE ID Registry</dt>
              <dd className="break-all text-mist">{REGISTRY}</dd>
            </div>
            <div className="flex flex-wrap justify-between gap-2">
              <dt>BSC USDT</dt>
              <dd className="break-all text-mist">{USDT}</dd>
            </div>
            <div className="flex flex-wrap justify-between gap-2">
              <dt>BSC USDC</dt>
              <dd className="break-all text-mist">{USDC}</dd>
            </div>
          </dl>
        </div>

        <ul className="mt-4 space-y-2.5">
          {proofs.map(([title, detail]) => (
            <li key={title} className="rounded-xl border border-white/10 bg-ink/70 p-3">
              <p className="text-sm font-semibold text-white">✓ {title}</p>
              <p className="mt-1 text-xs leading-relaxed text-mist">{detail}</p>
            </li>
          ))}
        </ul>

        <p className="mt-4 text-xs leading-relaxed text-dim">
          Built with OpenZeppelin ReentrancyGuard, SafeERC20, SafeCast, Checks-Effects-Interactions (CEI), and JSON/XML
          escaped on-chain SVG metadata. No private keys, seed phrases, or web QR pairing codes are ever requested.
        </p>
      </div>
    </div>
  )
}

'use client'

import { useEffect, useState } from 'react'
import { useAccount, useSwitchChain } from 'wagmi'
import { AgentOsTab } from '@/components/AgentOsTab'
import { BadgeTab } from '@/components/BadgeTab'
import { BountiesTab } from '@/components/BountiesTab'
import { ConnectButton } from '@/components/ConnectButton'
import { PollsTab } from '@/components/PollsTab'
import { RiskWarningBanner, SecurityModal } from '@/components/SecurityModal'
import { TipTab } from '@/components/TipTab'
import { useMounted } from '@/components/useSession'
import { BSCSCAN_CONTRACT_URL, CHAIN_ID, FOOTER_TEXT } from '@/lib/config'
import { readRoute, tabUrl, type TabId } from '@/lib/route'

const TABS: { id: TabId; label: string; shortLabel: string }[] = [
  { id: 'tip', label: 'Tip', shortLabel: 'Tip' },
  { id: 'bounties', label: 'Bounties', shortLabel: 'Bounties' },
  { id: 'polls', label: 'Polls', shortLabel: 'Polls' },
  { id: 'badge', label: 'Passport & Ranks', shortLabel: 'Passport' },
  { id: 'agent-os', label: 'Agent OS', shortLabel: 'Agent OS' },
]

export function AppShell() {
  const mounted = useMounted()
  const [tab, setTab] = useState<TabId>('tip')
  const [payHandle, setPayHandle] = useState<string | null>(null)
  const [bountyWorker, setBountyWorker] = useState<string | null>(null)
  const [securityOpen, setSecurityOpen] = useState(false)
  const { isConnected, chainId } = useAccount()
  const { switchChain, isPending } = useSwitchChain()
  const wrongNetwork = mounted && isConnected && chainId !== CHAIN_ID

  useEffect(() => {
    const apply = () => {
      const route = readRoute()
      setTab(route.tab)
      setPayHandle(route.handle)
      setBountyWorker(route.bountyWorker)
    }
    apply()
    window.addEventListener('hashchange', apply)
    window.addEventListener('popstate', apply)
    return () => {
      window.removeEventListener('hashchange', apply)
      window.removeEventListener('popstate', apply)
    }
  }, [])

  function selectTab(next: TabId) {
    setTab(next)
    window.history.replaceState(null, '', tabUrl(next))
  }

  return (
    <div className="min-h-[100dvh] bg-ink pb-24 md:pb-10">
      <header className="sticky top-0 z-20 border-b border-gold/20 bg-ink/90 backdrop-blur">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-3 px-4 py-3">
          <button type="button" onClick={() => selectTab('tip')} className="inline-flex items-center gap-2.5">
            <Logo />
            <span className="text-left">
              <span className="block text-lg font-semibold leading-none tracking-wide text-white">AgentJar</span>
              <span className="mt-0.5 block text-[10px] font-semibold uppercase tracking-widest text-gold">
                BSC Mainnet · v2
              </span>
            </span>
          </button>
          <ConnectButton />
        </div>
        <nav className="mx-auto hidden max-w-4xl flex-wrap gap-2 px-4 pb-3 md:flex" aria-label="Sections">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => selectTab(item.id)}
              className={`rounded-full px-4 py-2 text-sm font-semibold transition ${
                tab === item.id ? 'bg-gold text-ink' : 'text-mist hover:bg-white/5 hover:text-white'
              }`}
              aria-current={tab === item.id ? 'page' : undefined}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </header>

      <main className="mx-auto flex max-w-4xl flex-col gap-4 px-4 py-5">
        {wrongNetwork ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-gold/40 bg-card px-4 py-3">
            <p className="text-sm text-white">Wrong network connected. Switch to BNB Smart Chain (Chain ID {CHAIN_ID}).</p>
            <button
              type="button"
              className="btn"
              disabled={isPending}
              onClick={() => switchChain({ chainId: CHAIN_ID })}
            >
              {isPending ? 'Waiting for wallet…' : `Switch to BSC (${CHAIN_ID})`}
            </button>
          </div>
        ) : null}

        <div hidden={tab !== 'tip'}>
          <TipTab active={tab === 'tip'} initialHandle={payHandle} />
        </div>
        <div hidden={tab !== 'bounties'}>
          <BountiesTab active={tab === 'bounties'} initialWorker={bountyWorker} />
        </div>
        <div hidden={tab !== 'polls'}>
          <PollsTab active={tab === 'polls'} />
        </div>
        <div hidden={tab !== 'badge'}>
          <BadgeTab active={tab === 'badge'} />
        </div>
        <div hidden={tab !== 'agent-os'}>
          <AgentOsTab active={tab === 'agent-os'} />
        </div>

        <RiskWarningBanner />
      </main>

      <footer className="mx-auto max-w-4xl space-y-3 px-4 pb-8 pt-2 text-center">
        <p className="text-xs leading-relaxed text-mist">{FOOTER_TEXT}</p>
        <div className="flex flex-wrap items-center justify-center gap-3 text-xs">
          <a
            href={BSCSCAN_CONTRACT_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="font-semibold text-gold underline"
          >
            Verified on BscScan ↗
          </a>
          <span className="text-white/25">·</span>
          <button
            type="button"
            onClick={() => setSecurityOpen(true)}
            className="font-semibold text-gold underline hover:text-[#FFE08A]"
          >
            Security &amp; Contract Proof
          </button>
          <span className="text-white/25">·</span>
          <a href="/skill.md" target="_blank" rel="noopener noreferrer" className="text-mist underline">
            /skill.md
          </a>
          <span className="text-white/25">·</span>
          <a href="/.well-known/agent.json" target="_blank" rel="noopener noreferrer" className="text-mist underline">
            agent.json
          </a>
        </div>
      </footer>

      <SecurityModal open={securityOpen} onClose={() => setSecurityOpen(false)} />

      <nav
        className="fixed inset-x-0 bottom-0 z-30 border-t border-gold/25 bg-[#0B0E11]/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
        aria-label="Sections"
      >
        <div className="grid grid-cols-5">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => selectTab(item.id)}
              className={`flex min-h-14 flex-col items-center justify-center gap-1 px-1 text-[11px] font-semibold ${
                tab === item.id ? 'text-gold' : 'text-mist'
              }`}
              aria-current={tab === item.id ? 'page' : undefined}
            >
              <span className={`h-0.5 w-6 rounded-full ${tab === item.id ? 'bg-gold' : 'bg-transparent'}`} />
              <span className="truncate">{item.shortLabel}</span>
            </button>
          ))}
        </div>
      </nav>
    </div>
  )
}

function Logo() {
  return (
    <svg aria-hidden="true" viewBox="0 0 32 32" className="h-8 w-8">
      <rect width="32" height="32" rx="8" fill="#161A1E" stroke="#F0B90B" />
      <path d="M11 12h10c0 5.5-2 9-5 11-3-2-5-5.5-5-11z" fill="none" stroke="#F0B90B" strokeWidth="1.6" />
      <path d="M12.5 12c.5-2 6.5-2 7 0" fill="none" stroke="#F0B90B" strokeWidth="1.6" />
    </svg>
  )
}

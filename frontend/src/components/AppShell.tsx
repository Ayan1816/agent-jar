'use client'

import { useEffect, useState } from 'react'
import { useAccount, useSwitchChain } from 'wagmi'
import { BadgeTab } from '@/components/BadgeTab'
import { ConnectButton } from '@/components/ConnectButton'
import { PollsTab } from '@/components/PollsTab'
import { TipTab } from '@/components/TipTab'
import { useMounted } from '@/components/useSession'
import { agentJarAddress, CHAIN_ID, FOOTER_TEXT } from '@/lib/config'
import { readRoute, tabUrl, type TabId } from '@/lib/route'

const TABS: { id: TabId; label: string }[] = [
  { id: 'tip', label: 'Tip' },
  { id: 'badge', label: 'Badge & Ranks' },
  { id: 'polls', label: 'Polls' },
]

export function AppShell() {
  const mounted = useMounted()
  const [tab, setTab] = useState<TabId>('tip')
  const [payHandle, setPayHandle] = useState<string | null>(null)
  const { isConnected, chainId } = useAccount()
  const { switchChain, isPending } = useSwitchChain()
  const wrongNetwork = mounted && isConnected && chainId !== CHAIN_ID

  useEffect(() => {
    const apply = () => {
      const route = readRoute()
      setTab(route.tab)
      setPayHandle(route.handle)
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
    <div className="min-h-[100dvh] bg-ink pb-24 md:pb-8">
      <header className="sticky top-0 z-20 border-b border-gold/20 bg-ink/90 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 py-3">
          <button type="button" onClick={() => selectTab('tip')} className="inline-flex items-center gap-2">
            <Logo />
            <span className="text-lg font-semibold tracking-wide text-white">AgentJar</span>
          </button>
          <ConnectButton />
        </div>
        <nav className="mx-auto hidden max-w-3xl gap-2 px-4 pb-3 md:flex" aria-label="Sections">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => selectTab(item.id)}
              className={`rounded-full px-4 py-2 text-sm font-semibold ${
                tab === item.id ? 'bg-gold text-ink' : 'text-mist'
              }`}
              aria-current={tab === item.id ? 'page' : undefined}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </header>

      <main className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-4">
        {!agentJarAddress ? (
          <p className="rounded-2xl border border-gold/30 bg-card px-4 py-3 text-sm text-white" role="status">
            Not deployed yet / configure contract address. Set NEXT_PUBLIC_AGENTJAR_ADDRESS and rebuild to enable tips, badges, and polls.
          </p>
        ) : null}
        {wrongNetwork ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-gold/30 bg-card px-4 py-3">
            <p className="text-sm text-white">Wrong network. Switch to chain ID {CHAIN_ID}.</p>
            <button
              type="button"
              className="btn"
              disabled={isPending}
              onClick={() => switchChain({ chainId: CHAIN_ID })}
            >
              {isPending ? 'Waiting for wallet…' : `Switch to chain ${CHAIN_ID}`}
            </button>
          </div>
        ) : null}

        <div hidden={tab !== 'tip'}>
          <TipTab active={tab === 'tip'} initialHandle={payHandle} />
        </div>
        <div hidden={tab !== 'badge'}>
          <BadgeTab active={tab === 'badge'} />
        </div>
        <div hidden={tab !== 'polls'}>
          <PollsTab active={tab === 'polls'} />
        </div>
      </main>

      <footer className="mx-auto max-w-3xl px-4 pb-6">
        <p className="text-center text-sm leading-relaxed text-mist">{FOOTER_TEXT}</p>
      </footer>

      <nav
        className="fixed inset-x-0 bottom-0 z-30 border-t border-gold/25 bg-[#0B0E11]/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
        aria-label="Sections"
      >
        <div className="grid grid-cols-3">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => selectTab(item.id)}
              className={`flex min-h-14 flex-col items-center justify-center gap-1 text-xs font-semibold ${
                tab === item.id ? 'text-gold' : 'text-mist'
              }`}
              aria-current={tab === item.id ? 'page' : undefined}
            >
              <span className={`h-0.5 w-8 rounded-full ${tab === item.id ? 'bg-gold' : 'bg-transparent'}`} />
              {item.label}
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

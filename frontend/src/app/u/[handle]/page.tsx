import Link from 'next/link'
import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { RiskWarningBanner } from '@/components/SecurityModal'
import { BSCSCAN_CONTRACT_URL, FOOTER_TEXT } from '@/lib/config'
import { countLabel } from '@/lib/format'
import { displayHandle, normalizeHandle } from '@/lib/handles'
import { fetchAgentIntelligenceReport, resolveAgentHandleOnChain } from '@/lib/serverClient'
import { progressFor, tierStyle } from '@/lib/tiers'

export const dynamic = 'force-dynamic'

type Props = {
  params: Promise<{ handle: string }>
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { handle } = await params
  const norm = normalizeHandle(decodeURIComponent(handle))
  const shown = norm ? displayHandle(norm) : 'Agent Profile'
  return {
    title: `${shown} · AgentJar Reputation Passport`,
    description: `Live BSC Mainnet on-chain reputation, completed A2A micro-bounties, and dynamic soulbound passport for ${shown}.`,
  }
}

export default async function PublicAgentProfilePage({ params }: Props) {
  const { handle: rawParam } = await params
  const decoded = decodeURIComponent(rawParam)
  const resolved = await resolveAgentHandleOnChain(decoded)

  if (!resolved.found) {
    notFound()
  }

  const report = await fetchAgentIntelligenceReport(resolved.handle, resolved.owner)
  const scoreNum = Number(report.reputation.score)
  const style = tierStyle(report.reputation.tierName)
  const progress = progressFor(scoreNum)
  const shownHandle = displayHandle(resolved.handle)
  const encodedHandle = encodeURIComponent(shownHandle)

  return (
    <div className="min-h-[100dvh] bg-ink px-4 py-6">
      <div className="mx-auto max-w-3xl space-y-5">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-gold/20 pb-4">
          <Link href="/" className="inline-flex items-center gap-2 text-lg font-semibold text-white no-underline">
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-gold bg-card text-xs font-bold text-gold">
              AJ
            </span>
            <span>AgentJar</span>
          </Link>
          <div className="flex flex-wrap gap-2">
            <Link href={`/?pay=${encodedHandle}#/pay/${encodedHandle}`} className="btn no-underline">
              Tip {shownHandle}
            </Link>
            <Link href={`/?bounty=${encodedHandle}#bounties`} className="btn-ghost no-underline">
              Create Bounty
            </Link>
          </div>
        </header>

        <section
          className={`relative overflow-hidden rounded-3xl border bg-gradient-to-br from-[#2A2416] via-card to-ink p-6 ${style.card}`}
        >
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(240,185,11,0.2),transparent_55%)]" />
          <div className="relative grid gap-6 md:grid-cols-[1fr_240px] md:items-center">
            <div className="space-y-3">
              <p className="text-xs font-semibold tracking-[0.2em] text-gold">
                SOULBOUND AGENT REPUTATION PASSPORT · BSC MAINNET
              </p>
              <h1 className="text-3xl font-bold text-white">{shownHandle} ✓</h1>
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded-full border border-gold/40 bg-gold/10 px-3 py-1 text-sm font-semibold ${style.title}`}>
                  {report.reputation.tierName} Tier
                </span>
                {report.agent.activeInDirectory ? (
                  <span className="rounded-full border border-emerald-400/40 bg-emerald-500/10 px-3 py-1 text-xs font-semibold text-emerald-300">
                    Active on AgentJar v2
                  </span>
                ) : (
                  <span className="rounded-full border border-white/15 px-3 py-1 text-xs text-dim">
                    Verified SPACE ID · No AgentJar v2 activity yet
                  </span>
                )}
              </div>

              <div className="pt-1">
                <p className="text-4xl font-bold tabular-nums text-white">{scoreNum.toLocaleString('en-US')}</p>
                <p className="text-xs tracking-wide text-dim">LIVE ON-CHAIN REPUTATION SCORE</p>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-white/10">
                  <div className="h-full rounded-full bg-gold" style={{ width: `${progress.percent}%` }} />
                </div>
                <p className="mt-1.5 text-xs text-mist">{progress.label}</p>
              </div>
            </div>

            <div className="flex flex-col items-center">
              {report.passport.minted && report.passport.metadata?.image ? (
                <img
                  src={report.passport.metadata.image}
                  alt={`On-chain Dynamic SVG Reputation Passport for ${shownHandle}`}
                  className="w-56 rounded-2xl border border-gold/40 shadow-xl"
                />
              ) : (
                <div className="flex h-56 w-56 flex-col items-center justify-center rounded-2xl border border-gold/30 bg-ink/90 p-5 text-center">
                  <p className="font-mono text-xs tracking-widest text-gold">AGENTJAR PASSPORT</p>
                  <p className={`mt-3 font-mono text-2xl font-bold ${style.title}`}>{report.reputation.tierName}</p>
                  <p className="mt-1 font-mono text-sm text-white">@{resolved.handle}</p>
                  <p className="mt-4 text-xs text-dim">
                    {report.passport.minted ? 'Passport minted on-chain' : 'Unminted · Claimable at score ≥ 1'}
                  </p>
                </div>
              )}
            </div>
          </div>
        </section>

        <section className="glass rounded-2xl p-5">
          <h2 className="text-lg font-semibold text-white">Live On-Chain Activity &amp; Bounty SLA</h2>
          <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <ProfileStat
              label="Completed Bounties"
              value={countLabel(report.bountySla.bountiesCompleted, 'bounty', 'bounties')}
            />
            <ProfileStat
              label="Verified Supporters"
              value={countLabel(report.reputation.uniqueVerifiedSupporters, 'supporter')}
            />
            <ProfileStat label="Verified Tips" value={countLabel(report.reputation.verifiedTipsReceived, 'tip')} />
            <ProfileStat label="Best Poll Streak" value={countLabel(report.pollParticipation.bestStreakDays, 'day')} />
            <ProfileStat label="Qualified Polls" value={countLabel(report.pollParticipation.qualifiedPolls, 'poll')} />
            <ProfileStat label="Poll Votes" value={countLabel(report.pollParticipation.pollVotes, 'vote')} />
            <ProfileStat label="BNB Tipped" value={`${Number(report.reputation.bnbReceived).toFixed(4)} BNB`} />
            <ProfileStat label="USD Tipped" value={`$${Number(report.reputation.usdReceived).toFixed(2)}`} />
          </dl>
        </section>

        <RiskWarningBanner />

        <footer className="space-y-2 pb-4 text-center text-xs text-mist">
          <p>{FOOTER_TEXT}</p>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <a href={BSCSCAN_CONTRACT_URL} target="_blank" rel="noopener noreferrer" className="font-semibold text-gold underline">
              Verified on BscScan ↗
            </a>
            <span className="text-white/25">·</span>
            <Link href="/" className="text-mist underline">
              Back to AgentJar App
            </Link>
          </div>
        </footer>
      </div>
    </div>
  )
}

function ProfileStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-ink/70 p-3">
      <dt className="text-xs text-dim">{label}</dt>
      <dd className="mt-1 text-sm font-semibold text-white">{value}</dd>
    </div>
  )
}

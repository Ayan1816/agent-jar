const LADDER = [
  { name: 'Spark', min: 1 },
  { name: 'Bronze', min: 10 },
  { name: 'Silver', min: 40 },
  { name: 'Gold', min: 120 },
  { name: 'Legend', min: 400 },
] as const

/** Local progress math. Tier names shown in the UI come from AgentJar.getTier. */
export function progressFor(score: number): { percent: number; label: string } {
  const current = [...LADDER].reverse().find((tier) => score >= tier.min)
  const next = LADDER.find((tier) => score < tier.min)
  if (!next) return { percent: 100, label: 'Legend is the top tier.' }
  const previous = current?.min ?? 0
  const span = next.min - previous
  const percent = span <= 0 ? 100 : Math.max(0, Math.min(100, ((score - previous) / span) * 100))
  const label = `${score.toLocaleString('en-US')} / ${next.min.toLocaleString('en-US')} to ${next.name}`
  return { percent, label }
}

export function tierStyle(name: string | null): { card: string; title: string } {
  switch (name) {
    case 'Spark':
      return {
        card: 'border-[#F0B90B]/55 shadow-[0_0_32px_rgba(240,185,11,0.28)]',
        title: 'text-[#F0B90B]',
      }
    case 'Bronze':
      return {
        card: 'border-[#E0A06A] shadow-[0_0_32px_rgba(205,127,50,0.45)]',
        title: 'text-[#F3C7A2]',
      }
    case 'Silver':
      return {
        card: 'border-[#E6E8EC] shadow-[0_0_32px_rgba(220,224,230,0.38)]',
        title: 'text-[#F7F8FA]',
      }
    case 'Gold':
      return {
        card: 'border-[#F0B90B] shadow-[0_0_40px_rgba(240,185,11,0.55)]',
        title: 'text-[#F0B90B]',
      }
    case 'Legend':
      return {
        card: 'border-[#FFE08A] shadow-[0_0_48px_rgba(240,185,11,0.75)]',
        title: 'text-[#FFE08A]',
      }
    default:
      return {
        card: 'border-white/15 shadow-none',
        title: 'text-mist',
      }
  }
}

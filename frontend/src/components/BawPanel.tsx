'use client'

import { CopyButton } from '@/components/CopyButton'
import type { BawStep } from '@/lib/baw'
import { BAW_NOTE } from '@/lib/config'

export function BawPanel({ steps, blocked }: { steps: BawStep[] | null; blocked?: boolean }) {
  return (
    <details className="glass rounded-2xl">
      <summary className="cursor-pointer px-4 py-3 font-semibold text-gold">
        Run with Agentic Wallet (`baw` CLI)
      </summary>
      <div className="space-y-4 px-4 pb-4">
        <p className="text-sm leading-relaxed text-mist">{BAW_NOTE}</p>
        {blocked ? (
          <p className="text-sm text-white">Not deployed yet / configure contract address to generate calldata.</p>
        ) : null}
        {!blocked && !steps ? <p className="text-sm text-white">Complete the form to generate calldata.</p> : null}
        {steps?.map((step) => (
          <div key={step.title} className="space-y-2">
            <p className="text-sm text-white">{step.title}</p>
            <Command label="Preview" text={step.preview} />
            <Command label="Execute" text={step.execute} />
          </div>
        ))}
      </div>
    </details>
  )
}

function Command({ label, text }: { label: string; text: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-ink p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-gold">{label}</span>
        <CopyButton text={text} />
      </div>
      <pre className="overflow-x-auto whitespace-pre text-xs leading-relaxed text-white">{text}</pre>
    </div>
  )
}

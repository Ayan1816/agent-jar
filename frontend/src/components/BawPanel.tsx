'use client'

import { CopyButton } from '@/components/CopyButton'
import type { BawStep } from '@/lib/baw'
import { BAW_NOTE } from '@/lib/config'

export function BawPanel({
  steps,
  blocked,
  label = 'Run with Agentic Wallet',
}: {
  steps: BawStep[] | null
  blocked?: boolean
  label?: string
}) {
  return (
    <details className="group glass rounded-2xl">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-semibold text-gold">
        <span className="inline-flex flex-wrap items-center gap-2">
          <span>{label}</span>
          <code className="rounded-md border border-gold/30 bg-gold/10 px-2 py-0.5 font-mono text-xs font-medium text-gold">
            baw CLI
          </code>
        </span>
        <span className="text-xs text-dim transition group-open:rotate-180" aria-hidden="true">
          ▾
        </span>
      </summary>
      <div className="space-y-4 border-t border-white/10 px-4 pb-4 pt-3">
        <p className="text-xs leading-relaxed text-mist">{BAW_NOTE}</p>
        {blocked ? (
          <p className="text-sm text-white">Configure the deployed contract address to generate calldata.</p>
        ) : null}
        {!blocked && !steps ? (
          <p className="text-sm text-dim">Complete the required form fields to generate verified two-step calldata.</p>
        ) : null}
        {steps?.map((step) => (
          <div key={step.title} className="space-y-2">
            <p className="text-sm font-medium text-white">{step.title}</p>
            <Command label="Step 1 · Preview & Simulate" text={step.preview} />
            <Command label="Step 2 · Execute After Explicit User Approval" text={step.execute} />
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
      <pre className="overflow-x-auto whitespace-pre font-mono text-xs leading-relaxed text-white">{text}</pre>
    </div>
  )
}

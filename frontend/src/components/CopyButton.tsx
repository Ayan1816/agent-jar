'use client'

import { useState } from 'react'

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [note, setNote] = useState(label)

  return (
    <button
      type="button"
      className="btn-inline shrink-0"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          setNote('Copied')
          window.setTimeout(() => setNote(label), 1500)
        } catch {
          setNote('Copy blocked')
          window.setTimeout(() => setNote(label), 1500)
        }
      }}
    >
      {note}
    </button>
  )
}

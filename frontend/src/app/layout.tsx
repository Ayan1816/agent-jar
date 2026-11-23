import type { Metadata, Viewport } from 'next'
import type { ReactNode } from 'react'
import { Providers } from '@/components/Providers'
import './globals.css'

export const metadata: Metadata = {
  title: 'AgentJar v2 · Ownerless A2A Tipping, Micro-Bounties & Reputation Passport on BSC',
  description:
    'Ownerless, 0%-fee BSC Mainnet tipping, A2A micro-bounty escrow with 3-juror Sybil-free disputes, hardened holder polls, dynamic SVG Reputation Passports, and x402 v2 intelligence for verified .ai Agent IDs.',
}

export const viewport: Viewport = {
  themeColor: '#0B0E11',
  width: 'device-width',
  initialScale: 1,
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}

import type { Metadata, Viewport } from 'next'
import type { ReactNode } from 'react'
import { Providers } from '@/components/Providers'
import './globals.css'

export const metadata: Metadata = {
  title: 'AgentJar',
  description: 'Tip Agent IDs, claim a soulbound badge, and vote on holder polls.',
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

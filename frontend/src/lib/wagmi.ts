import { fallback } from 'viem'
import { createConfig, http, injected } from 'wagmi'
import { BSC_RPC_URLS, bscMainnet } from '@/lib/config'

export const wagmiConfig = createConfig({
  chains: [bscMainnet],
  connectors: [injected({ shimDisconnect: true })],
  multiInjectedProviderDiscovery: false,
  ssr: true,
  transports: {
    [bscMainnet.id]: fallback(
      BSC_RPC_URLS.map((url) => http(url, { timeout: 15_000, retryCount: 1 })),
      { rank: false, retryCount: 2 },
    ),
  },
})

declare module 'wagmi' {
  interface Register {
    config: typeof wagmiConfig
  }
}

import { fallback } from 'viem'
import { createConfig, http, injected } from 'wagmi'
import { bsc } from 'wagmi/chains'

const primary = process.env.NEXT_PUBLIC_BSC_RPC_URL || 'https://bsc-dataseed.binance.org'
const secondary = process.env.NEXT_PUBLIC_BSC_RPC_FALLBACK || 'https://bsc-rpc.publicnode.com'

export const wagmiConfig = createConfig({
  chains: [bsc],
  connectors: [injected({ shimDisconnect: true })],
  multiInjectedProviderDiscovery: false,
  ssr: true,
  transports: {
    [bsc.id]: fallback([
      http(primary, { timeout: 20_000, retryCount: 1 }),
      http(secondary, { timeout: 20_000, retryCount: 1 }),
    ]),
  },
})

declare module 'wagmi' {
  interface Register {
    config: typeof wagmiConfig
  }
}

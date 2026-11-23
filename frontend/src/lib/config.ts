import { defineChain, getAddress, parseEther } from 'viem'

export const CHAIN_ID = 56
export const CAIP2_BSC = 'eip155:56'

export const REGISTRY = getAddress('0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F')
export const USDT = getAddress('0x55d398326f99059fF775485246999027B3197955')
export const USDC = getAddress('0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d')
export const PERMIT2_ADDRESS = getAddress('0x000000000022D473030F116dDEE9F6B43aC78BA3')
export const ZERO = getAddress('0x0000000000000000000000000000000000000000')

export const bscMainnet = defineChain({
  id: 56,
  name: 'BNB Smart Chain',
  nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://bsc-dataseed.binance.org'] },
  },
  blockExplorers: {
    default: { name: 'BscScan', url: 'https://bscscan.com', apiUrl: 'https://api.etherscan.io/v2/api?chainid=56' },
  },
  contracts: {
    multicall3: {
      address: '0xcA11bde05977b3631167028862bE2a173976CA11',
      blockCreated: 15921452,
    },
  },
})

export const DEFAULT_AGENTJAR_ADDRESS = getAddress('0xE3FdB021493953C95F4c93bCCF83B762e4475Ed7')
export const DEFAULT_AGENTJAR_FROM_BLOCK = 135254966n

const rawJar = process.env.NEXT_PUBLIC_AGENTJAR_ADDRESS?.trim() || DEFAULT_AGENTJAR_ADDRESS

function readJar(): `0x${string}` {
  if (!/^0x[a-fA-F0-9]{40}$/.test(rawJar)) return DEFAULT_AGENTJAR_ADDRESS
  const parsed = getAddress(rawJar)
  if (parsed === ZERO) return DEFAULT_AGENTJAR_ADDRESS
  return parsed
}

function readFromBlock(): bigint {
  const raw = process.env.NEXT_PUBLIC_AGENTJAR_FROM_BLOCK?.trim() ?? ''
  if (/^\d+$/.test(raw)) return BigInt(raw)
  return DEFAULT_AGENTJAR_FROM_BLOCK
}

/** Checksummed verified BSC Mainnet AgentJar v2 address (defaults to live mainnet deployment). */
export const AGENTJAR_ADDRESS: `0x${string}` = readJar()
export const agentJarAddress: `0x${string}` = AGENTJAR_ADDRESS
export const AGENTJAR_FROM_BLOCK: bigint = readFromBlock()
export const BSCSCAN_CONTRACT_URL = `https://bscscan.com/address/${AGENTJAR_ADDRESS}#code`

const configuredPrimary = process.env.NEXT_PUBLIC_BSC_RPC_URL?.trim()
const configuredFallback = process.env.NEXT_PUBLIC_BSC_RPC_FALLBACK?.trim()

export const BSC_RPC_URLS: readonly string[] = [
  configuredPrimary || 'https://bsc-dataseed.binance.org',
  'https://bsc-dataseed1.defibit.io',
  'https://bsc-dataseed1.ninicoin.io',
  ...(configuredFallback ? [configuredFallback] : []),
].filter((url, index, list) => url.length > 0 && list.indexOf(url) === index)

export const MIN_NATIVE_TIP = parseEther('0.0001')
export const MIN_USD_TIP = parseEther('0.1')
export const MAX_MESSAGE_BYTES = 280
export const MAX_QUESTION_BYTES = 200
export const MAX_OPTION_BYTES = 64
export const POLL_SCORE_MIN_VOTES = 3

export const MIN_BOUNTY_DURATION = 60 * 60
export const MAX_BOUNTY_DURATION = 14 * 24 * 60 * 60
export const DISPUTE_APPROVAL_GRACE = 24 * 60 * 60
export const DISPUTE_WINDOW = 48 * 60 * 60

/** 0.10 BSC USDC (18 decimals) paid peer-to-peer to the target .ai agent owner. */
export const X402_REPORT_PRICE_USDC = parseEther('0.1')

export const FOOTER_TEXT =
  'Independent community project. Ownerless & immutable contract: no admin, no pause, no freeze, no withdraw, zero fees. Verified open-source on BscScan.'

export const BAW_NOTE =
  'Enable Developer Mode in your mobile wallet app before using these commands. Developer Mode is time-boxed and has its own daily spend limit. Always review the preview before you execute.'

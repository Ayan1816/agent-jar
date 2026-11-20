import { getAddress, parseEther } from 'viem'

export const CHAIN_ID = 56

export const REGISTRY = getAddress('0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F')
export const USDT = getAddress('0x55d398326f99059fF775485246999027B3197955')
export const USDC = getAddress('0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d')
export const ZERO = getAddress('0x0000000000000000000000000000000000000000')

const rawJar = process.env.NEXT_PUBLIC_AGENTJAR_ADDRESS?.trim() ?? ''

function readJar(): `0x${string}` | undefined {
  if (!/^0x[a-fA-F0-9]{40}$/.test(rawJar)) return undefined
  const parsed = getAddress(rawJar)
  if (parsed === ZERO) return undefined
  return parsed
}

/** Unset until Step 5 writes a deployed address into the environment. */
export const agentJarAddress = readJar()

export const MIN_NATIVE_TIP = parseEther('0.0001')
export const MIN_USD_TIP = parseEther('0.1')
export const MAX_MESSAGE_BYTES = 280

export const FOOTER_TEXT =
  'Independent community project. Ownerless & immutable contract: no admin, no pause, no freeze, no withdraw, zero fees. Verified open-source on BscScan.'

export const BAW_NOTE =
  'Enable Developer Mode in your mobile wallet app before using these commands. Developer Mode is time-boxed and has its own daily spend limit. Always review the preview before you execute.'

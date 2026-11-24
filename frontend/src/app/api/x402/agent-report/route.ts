import { NextRequest, NextResponse } from 'next/server'
import { decodeEventLog, getAddress, isAddress, verifyTypedData } from 'viem'
import { agentJarAbi, erc20Abi } from '@/lib/abi'
import {
  AGENTJAR_ADDRESS,
  CAIP2_BSC,
  CHAIN_ID,
  PERMIT2_ADDRESS,
  USDC,
  X402_REPORT_PRICE_USDC,
  ZERO,
} from '@/lib/config'
import { displayHandle } from '@/lib/handles'
import { fetchAgentIntelligenceReport, resolveAgentHandleOnChain, serverPublicClient } from '@/lib/serverClient'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const PERMIT2_DOMAIN = {
  name: 'Permit2',
  chainId: CHAIN_ID,
  verifyingContract: PERMIT2_ADDRESS,
} as const

const PERMIT2_WITNESS_TYPES = {
  PermitWitnessTransferFrom: [
    { name: 'permitted', type: 'TokenPermissions' },
    { name: 'spender', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'witness', type: 'Witness' },
  ],
  TokenPermissions: [
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' },
  ],
  Witness: [
    { name: 'to', type: 'address' },
    { name: 'validAfter', type: 'uint256' },
  ],
} as const

/** ~24 hours of BSC blocks (~3s/block) for on-chain TX receipt settlement freshness. */
const MAX_SETTLEMENT_AGE_BLOCKS = 28_800n

type PaymentRequirements = {
  scheme: 'exact'
  network: typeof CAIP2_BSC
  amount: string
  asset: `0x${string}`
  payTo: `0x${string}`
  maxTimeoutSeconds: number
  extra: {
    name: string
    version: string
    decimals: number
    assetTransferMethod: 'permit2'
    permit2Address: `0x${string}`
  }
}

type PaymentRequiredPayload = {
  x402Version: 2
  error: string
  resource: {
    url: string
    description: string
    mimeType: string
  }
  accepts: [PaymentRequirements]
}

type VerificationResult =
  | {
      ok: true
      method: 'x402-facilitator-settled' | 'bsc-tx-receipt'
      payer: `0x${string}`
      transaction: `0x${string}`
      amount: bigint
      asset: `0x${string}`
      viaAgentJar: boolean
    }
  | {
      ok: false
      status: 400 | 402
      reason: string
    }

function encodeBase64Json(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64')
}

function decodeStrictBase64Json(headerValue: string): { ok: true; data: unknown } | { ok: false; reason: string } {
  const trimmed = headerValue.trim()
  if (!trimmed || trimmed.length > 16_384 || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(trimmed)) {
    return { ok: false, reason: 'Malformed PAYMENT-SIGNATURE header: invalid base64 encoding.' }
  }
  try {
    const normalized = trimmed.replace(/-/g, '+').replace(/_/g, '/')
    const decoded = Buffer.from(normalized, 'base64').toString('utf8')
    const parsed: unknown = JSON.parse(decoded)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, reason: 'Malformed PAYMENT-SIGNATURE payload: expected JSON object.' }
    }
    return { ok: true, data: parsed }
  } catch {
    return { ok: false, reason: 'Malformed PAYMENT-SIGNATURE payload: invalid JSON.' }
  }
}

function parseUintString(value: unknown): bigint | null {
  if (typeof value === 'bigint' && value >= 0n) return value
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value)
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value)
  return null
}

function getFacilitatorUrl(): string | null {
  const raw = process.env.X402_FACILITATOR_URL?.trim() ?? ''
  if (!raw) return null
  try {
    const parsed = new URL(raw)
    if (parsed.protocol !== 'https:') return null
    return raw.replace(/\/+$/, '')
  } catch {
    return null
  }
}

function buildPaymentRequired(requestUrl: string, handle: string, payTo: `0x${string}`): PaymentRequiredPayload {
  return {
    x402Version: 2,
    error: `Payment of 0.10 USDC on BSC (eip155:56) required directly to ${displayHandle(handle)} (0% platform fee).`,
    resource: {
      url: requestUrl,
      description: `Live on-chain Agent Reputation, Bounty SLA, Poll Participation & SVG Passport intelligence report for ${displayHandle(handle)}.`,
      mimeType: 'application/json',
    },
    accepts: [
      {
        scheme: 'exact',
        network: CAIP2_BSC,
        amount: X402_REPORT_PRICE_USDC.toString(),
        asset: USDC,
        payTo,
        maxTimeoutSeconds: 300,
        extra: {
          name: 'USD Coin',
          version: '1',
          decimals: 18,
          assetTransferMethod: 'permit2',
          permit2Address: PERMIT2_ADDRESS,
        },
      },
    ],
  }
}

/**
 * Verifies a live BSC Mainnet transaction receipt via viem, decoding BSC USDC Transfer logs
 * and confirming >= 0.10 USDC settled directly to the resolved .ai agent owner (direct transfer
 * or routed via AgentJar.tipToken). Rejects any malformed, missing, reverted, stale, or
 * underpaid transaction hash with 400 or 402.
 */
async function verifyBscTxReceipt(txHashRaw: string, expectedPayTo: `0x${string}`): Promise<VerificationResult> {
  const txHash = txHashRaw.trim()
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return { ok: false, status: 400, reason: 'Malformed X-BSC-TX-HASH header: expected 32-byte 0x hex transaction hash.' }
  }

  let receipt
  let latestBlock: bigint
  try {
    ;[receipt, latestBlock] = await Promise.all([
      serverPublicClient.getTransactionReceipt({ hash: txHash as `0x${string}` }),
      serverPublicClient.getBlockNumber(),
    ])
  } catch {
    return { ok: false, status: 402, reason: 'Transaction receipt not found on BSC Mainnet.' }
  }

  if (receipt.status !== 'success') {
    return { ok: false, status: 402, reason: 'Referenced BSC transaction reverted on-chain.' }
  }
  if (latestBlock > receipt.blockNumber && latestBlock - receipt.blockNumber > MAX_SETTLEMENT_AGE_BLOCKS) {
    return { ok: false, status: 402, reason: 'Settlement transaction is older than the 24-hour freshness window.' }
  }

  const viaAgentJar = Boolean(receipt.to && getAddress(receipt.to) === AGENTJAR_ADDRESS)

  for (const log of receipt.logs) {
    if (getAddress(log.address) !== USDC) continue
    try {
      const decoded = decodeEventLog({
        abi: erc20Abi,
        eventName: 'Transfer',
        data: log.data,
        topics: log.topics,
      })
      const args = decoded.args as unknown as {
        from?: `0x${string}`
        to?: `0x${string}`
        value?: bigint
      }
      if (
        !args ||
        typeof args.from !== 'string' ||
        typeof args.to !== 'string' ||
        typeof args.value !== 'bigint' ||
        !isAddress(args.from) ||
        !isAddress(args.to)
      ) {
        continue
      }
      if (getAddress(args.to) === expectedPayTo && args.value >= X402_REPORT_PRICE_USDC) {
        return {
          ok: true,
          method: 'bsc-tx-receipt',
          payer: getAddress(args.from),
          transaction: txHash as `0x${string}`,
          amount: args.value,
          asset: USDC,
          viaAgentJar,
        }
      }
    } catch {
      // Ignore non-Transfer logs emitted by USDC.
    }
  }

  return {
    ok: false,
    status: 402,
    reason: 'Transaction does not contain a verified >= 0.10 BSC USDC Transfer log to the target .ai agent owner.',
  }
}

/**
 * Strictly validates an x402 v2 PAYMENT-SIGNATURE header and NEVER accepts an unsettled
 * signature on its own. Settlement requires a configured HTTPS X402_FACILITATOR_URL that
 * confirms live on-chain settlement on BSC Mainnet; otherwise returns 402 requiring real
 * on-chain X-BSC-TX-HASH settlement.
 */
async function verifyAndSettlePaymentSignature(
  headerValue: string,
  requirements: PaymentRequirements,
): Promise<VerificationResult> {
  const decoded = decodeStrictBase64Json(headerValue)
  if (!decoded.ok) return { ok: false, status: 400, reason: decoded.reason }

  const root = decoded.data as Record<string, unknown>
  if (root.x402Version !== 2) {
    return { ok: false, status: 402, reason: 'Unsupported x402Version; expected 2.' }
  }

  const accepted = root.accepted as Record<string, unknown> | undefined
  if (!accepted || typeof accepted !== 'object') {
    return { ok: false, status: 402, reason: 'Missing accepted payment requirement in PAYMENT-SIGNATURE.' }
  }
  if (accepted.scheme !== 'exact' || accepted.network !== CAIP2_BSC) {
    return { ok: false, status: 402, reason: 'Payment must use scheme "exact" on network "eip155:56".' }
  }
  if (typeof accepted.asset !== 'string' || !isAddress(accepted.asset) || getAddress(accepted.asset) !== USDC) {
    return { ok: false, status: 402, reason: `Unsupported payment asset; expected BSC USDC (${USDC}).` }
  }
  if (
    typeof accepted.payTo !== 'string' ||
    !isAddress(accepted.payTo) ||
    getAddress(accepted.payTo) !== requirements.payTo
  ) {
    return { ok: false, status: 402, reason: 'Payment recipient does not match the resolved .ai agent owner.' }
  }
  const acceptedAmount = parseUintString(accepted.amount)
  if (acceptedAmount === null || acceptedAmount < X402_REPORT_PRICE_USDC) {
    return { ok: false, status: 402, reason: 'Payment amount is below the required 0.10 USDC.' }
  }

  const payload = root.payload as Record<string, unknown> | undefined
  if (!payload || typeof payload !== 'object') {
    return { ok: false, status: 402, reason: 'Missing payload object in PAYMENT-SIGNATURE.' }
  }

  const signature = payload.signature
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    return { ok: false, status: 402, reason: 'Invalid or missing 65-byte ECDSA signature in PAYMENT-SIGNATURE.' }
  }

  const auth = payload.permit2Authorization as Record<string, unknown> | undefined
  if (!auth || typeof auth !== 'object') {
    return { ok: false, status: 402, reason: 'Missing permit2Authorization object for BSC permit2 payment.' }
  }

  if (typeof auth.from !== 'string' || !isAddress(auth.from) || getAddress(auth.from) === ZERO) {
    return { ok: false, status: 402, reason: 'Invalid permit2Authorization.from payer address.' }
  }
  if (typeof auth.spender !== 'string' || !isAddress(auth.spender) || getAddress(auth.spender) === ZERO) {
    return { ok: false, status: 402, reason: 'Invalid permit2Authorization.spender address.' }
  }

  const permitted = auth.permitted as Record<string, unknown> | undefined
  const witness = auth.witness as Record<string, unknown> | undefined
  if (!permitted || typeof permitted !== 'object' || !witness || typeof witness !== 'object') {
    return { ok: false, status: 402, reason: 'Missing permitted or witness fields in permit2Authorization.' }
  }
  if (typeof permitted.token !== 'string' || !isAddress(permitted.token) || getAddress(permitted.token) !== USDC) {
    return { ok: false, status: 402, reason: 'Permit2 token does not match BSC USDC.' }
  }
  if (typeof witness.to !== 'string' || !isAddress(witness.to) || getAddress(witness.to) !== requirements.payTo) {
    return { ok: false, status: 402, reason: 'Permit2 witness.to does not match the resolved .ai agent owner.' }
  }

  const permittedAmount = parseUintString(permitted.amount)
  const nonce = parseUintString(auth.nonce)
  const deadline = parseUintString(auth.deadline)
  const validAfter = parseUintString(witness.validAfter)
  if (permittedAmount === null || nonce === null || deadline === null || validAfter === null) {
    return { ok: false, status: 402, reason: 'Invalid numeric fields in permit2Authorization.' }
  }
  if (permittedAmount < X402_REPORT_PRICE_USDC) {
    return { ok: false, status: 402, reason: 'Permit2 authorized amount is below 0.10 USDC.' }
  }

  const nowSec = BigInt(Math.floor(Date.now() / 1000))
  if (deadline <= nowSec) {
    return { ok: false, status: 402, reason: 'Permit2 authorization deadline has expired.' }
  }
  if (validAfter > nowSec) {
    return { ok: false, status: 402, reason: 'Permit2 authorization is not yet valid (validAfter in future).' }
  }

  const payer = getAddress(auth.from)
  const spender = getAddress(auth.spender)
  const witnessTo = getAddress(witness.to)

  let sigOk = false
  try {
    sigOk = await verifyTypedData({
      address: payer,
      domain: PERMIT2_DOMAIN,
      types: PERMIT2_WITNESS_TYPES,
      primaryType: 'PermitWitnessTransferFrom',
      message: {
        permitted: { token: USDC, amount: permittedAmount },
        spender,
        nonce,
        deadline,
        witness: { to: witnessTo, validAfter },
      },
      signature: signature as `0x${string}`,
    })
  } catch {
    sigOk = false
  }
  if (!sigOk) {
    return { ok: false, status: 402, reason: 'Invalid Permit2 EIP-712 signature for declared payer.' }
  }

  // STRICT REAL SETTLEMENT RULE: Never accept an unsettled PAYMENT-SIGNATURE without a live
  // configured x402 facilitator settling the Permit2 authorization on BSC Mainnet.
  const facilitatorUrl = getFacilitatorUrl()
  if (!facilitatorUrl) {
    return {
      ok: false,
      status: 402,
      reason:
        'Unsettled PAYMENT-SIGNATURE rejected: X402_FACILITATOR_URL is not configured. Settle >= 0.10 BSC USDC on-chain to the resolved .ai agent owner and retry with the X-BSC-TX-HASH header.',
    }
  }

  try {
    const facilitatorPayload = {
      x402Version: 2,
      paymentPayload: root,
      paymentRequirements: requirements,
    }

    const verifyRes = await fetch(`${facilitatorUrl}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(facilitatorPayload),
      signal: AbortSignal.timeout(15_000),
    })
    if (!verifyRes.ok) {
      return { ok: false, status: 402, reason: 'x402 facilitator rejected PAYMENT-SIGNATURE during /verify.' }
    }
    const verifyJson = (await verifyRes.json()) as { isValid?: boolean; invalidReason?: string }
    if (verifyJson.isValid !== true) {
      return {
        ok: false,
        status: 402,
        reason: verifyJson.invalidReason || 'x402 facilitator reported PAYMENT-SIGNATURE invalid.',
      }
    }

    const settleRes = await fetch(`${facilitatorUrl}/settle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(facilitatorPayload),
      signal: AbortSignal.timeout(30_000),
    })
    if (!settleRes.ok) {
      return { ok: false, status: 402, reason: 'x402 facilitator failed to settle payment on BSC Mainnet.' }
    }
    const settleJson = (await settleRes.json()) as {
      success?: boolean
      transaction?: string
      errorReason?: string
    }
    if (settleJson.success !== true || typeof settleJson.transaction !== 'string') {
      return {
        ok: false,
        status: 402,
        reason: settleJson.errorReason || 'x402 facilitator did not confirm on-chain settlement.',
      }
    }

    // Independently confirm the facilitator's settled BSC Mainnet transaction receipt on-chain.
    const onChainCheck = await verifyBscTxReceipt(settleJson.transaction, requirements.payTo)
    if (!onChainCheck.ok) {
      return {
        ok: false,
        status: 402,
        reason: `Facilitator settlement tx could not be verified on BSC Mainnet: ${onChainCheck.reason}`,
      }
    }

    return {
      ok: true,
      method: 'x402-facilitator-settled',
      payer: onChainCheck.payer,
      transaction: onChainCheck.transaction,
      amount: onChainCheck.amount,
      asset: onChainCheck.asset,
      viaAgentJar: onChainCheck.viaAgentJar,
    }
  } catch {
    return {
      ok: false,
      status: 402,
      reason: 'Unable to complete live settlement via X402_FACILITATOR_URL. Retry with an on-chain X-BSC-TX-HASH.',
    }
  }
}

export async function GET(request: NextRequest) {
  const rawHandle = request.nextUrl.searchParams.get('handle')?.trim() ?? ''
  if (!rawHandle) {
    return NextResponse.json(
      { error: 'Missing required query parameter: handle (e.g. ?handle=alice or ?handle=alice.ai).' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    )
  }

  let resolved
  try {
    resolved = await resolveAgentHandleOnChain(rawHandle)
  } catch {
    return NextResponse.json(
      { error: 'Unable to reach SPACE ID Agent ID registry on BSC Mainnet.' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    )
  }

  if (!resolved.found) {
    return NextResponse.json(
      { error: `No verified SPACE ID Agent ID found for handle "${rawHandle}".` },
      { status: 404, headers: { 'Cache-Control': 'no-store' } },
    )
  }

  // Privacy Guard (Safety Red Line #9): Only active opt-in AgentJar users are served via x402.
  // Never expose payTo wallet addresses for handles that are not active on AgentJar v2.
  let activeOnAgentJar = false
  try {
    const active = await serverPublicClient.readContract({
      address: AGENTJAR_ADDRESS,
      abi: agentJarAbi,
      functionName: 'isActiveAgent',
      args: [resolved.owner],
    })
    activeOnAgentJar = active === true
  } catch {
    return NextResponse.json(
      { error: 'Unable to verify agent activity on AgentJar v2 contract.' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    )
  }

  if (!activeOnAgentJar) {
    return NextResponse.json(
      { error: 'Agent is not active on AgentJar' },
      { status: 404, headers: { 'Cache-Control': 'no-store' } },
    )
  }

  const paymentRequired = buildPaymentRequired(request.nextUrl.toString(), resolved.handle, resolved.owner)
  const paymentRequiredHeader = encodeBase64Json(paymentRequired)

  const paymentSigHeader = request.headers.get('payment-signature')
  const txHashHeader = request.headers.get('x-bsc-tx-hash')

  if (!paymentSigHeader && !txHashHeader) {
    return NextResponse.json(
      {
        error: paymentRequired.error,
        x402Version: 2,
        handle: displayHandle(resolved.handle),
        paymentRequired,
      },
      {
        status: 402,
        headers: {
          'PAYMENT-REQUIRED': paymentRequiredHeader,
          'Cache-Control': 'no-store',
        },
      },
    )
  }

  // Prefer verified on-chain X-BSC-TX-HASH receipt when provided; otherwise require real
  // facilitator settlement for PAYMENT-SIGNATURE (never accepting unsettled signatures).
  const verification = txHashHeader
    ? await verifyBscTxReceipt(txHashHeader, resolved.owner)
    : await verifyAndSettlePaymentSignature(paymentSigHeader!, paymentRequired.accepts[0])

  if (!verification.ok) {
    return NextResponse.json(
      {
        error: verification.reason,
        x402Version: 2,
        handle: displayHandle(resolved.handle),
      },
      {
        status: verification.status,
        headers: {
          'PAYMENT-REQUIRED': paymentRequiredHeader,
          'Cache-Control': 'no-store',
        },
      },
    )
  }

  try {
    const report = await fetchAgentIntelligenceReport(resolved.handle, resolved.owner)
    const paymentResponse = {
      success: true,
      x402Version: 2,
      scheme: 'exact',
      network: CAIP2_BSC,
      method: verification.method,
      asset: verification.asset,
      amount: verification.amount.toString(),
      payer: verification.payer,
      payTo: resolved.owner,
      transaction: verification.transaction,
      viaAgentJar: verification.viaAgentJar,
      settledAt: new Date().toISOString(),
    }

    return NextResponse.json(
      {
        x402: {
          verified: true,
          settledOnChain: true,
          network: CAIP2_BSC,
          method: verification.method,
          transaction: verification.transaction,
          amount: verification.amount.toString(),
          asset: verification.asset,
          viaAgentJar: verification.viaAgentJar,
        },
        report,
      },
      {
        status: 200,
        headers: {
          'PAYMENT-RESPONSE': encodeBase64Json(paymentResponse),
          'Cache-Control': 'private, no-store',
        },
      },
    )
  } catch {
    return NextResponse.json(
      { error: 'Payment settled on-chain, but BSC Mainnet RPC failed while building the live intelligence report.' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    )
  }
}

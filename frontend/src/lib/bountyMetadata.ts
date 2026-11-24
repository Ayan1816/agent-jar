import { keccak256, stringToBytes } from 'viem'

export type BountySpecMetadata = {
  version: 1
  kind: 'spec'
  title: string
  description: string
  referenceUrl?: string
}

export type BountyDeliverableMetadata = {
  version: 1
  kind: 'deliverable'
  summary: string
  deliverableUrl: string
}

export type BountyMetadata = BountySpecMetadata | BountyDeliverableMetadata

export const MAX_METADATA_BODY_BYTES = 4096
export const MAX_SPEC_TITLE_CHARS = 120
export const MAX_SPEC_DESC_CHARS = 1500
export const MAX_DELIVERABLE_SUMMARY_CHARS = 1000
export const MAX_URL_CHARS = 512

const ZERO_BYTES32 = `0x${'0'.repeat(64)}`
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g

export function isNonZeroBytes32(value: unknown): value is `0x${string}` {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value) && value.toLowerCase() !== ZERO_BYTES32
}

export function sanitizeText(value: unknown, maxChars: number): string | null {
  if (typeof value !== 'string') return null
  const cleaned = value.replace(CONTROL_CHARS, '').trim()
  if (cleaned.length > maxChars) return null
  return cleaned
}

/**
 * Strictly validates that a URL uses only `https://` or `ipfs://` schemes (rejecting
 * `javascript:`, `data:`, `http:`, `vbscript:`, etc. to prevent XSS).
 */
export function sanitizeSafeUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const cleaned = value.replace(CONTROL_CHARS, '').trim()
  if (!cleaned || cleaned.length > MAX_URL_CHARS) return null
  if (/[\s<>'"`]/.test(cleaned)) return null

  const lower = cleaned.toLowerCase()
  if (lower.startsWith('https://')) {
    try {
      const parsed = new URL(cleaned)
      if (parsed.protocol !== 'https:' || !parsed.hostname) return null
      return cleaned
    } catch {
      return null
    }
  }

  if (lower.startsWith('ipfs://')) {
    const rest = cleaned.slice(7)
    if (rest.length < 4 || !/^[A-Za-z0-9._~:/?#[\]@!$&()*+,;=%-]+$/.test(rest)) return null
    return cleaned
  }

  return null
}

/** Convert an already-validated https:// or ipfs:// URL to a safe browser href. */
export function safeExternalHref(url: string | undefined): string | null {
  const valid = sanitizeSafeUrl(url)
  if (!valid) return null
  if (valid.toLowerCase().startsWith('ipfs://')) {
    return `https://ipfs.io/ipfs/${valid.slice(7)}`
  }
  return valid
}

export function validateAndSanitizeMetadata(
  raw: unknown,
): { ok: true; metadata: BountyMetadata } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'Metadata must be a JSON object.' }
  }
  const obj = raw as Record<string, unknown>
  if (obj.version !== 1) {
    return { ok: false, error: 'Unsupported metadata version; expected 1.' }
  }

  if (obj.kind === 'spec') {
    const title = sanitizeText(obj.title, MAX_SPEC_TITLE_CHARS)
    const description = sanitizeText(obj.description, MAX_SPEC_DESC_CHARS)
    if (!title) return { ok: false, error: `Title is required (1-${MAX_SPEC_TITLE_CHARS} chars).` }
    if (!description) return { ok: false, error: `Description is required (1-${MAX_SPEC_DESC_CHARS} chars).` }

    const out: BountySpecMetadata = { version: 1, kind: 'spec', title, description }
    if (obj.referenceUrl !== undefined && obj.referenceUrl !== '') {
      const safeRef = sanitizeSafeUrl(obj.referenceUrl)
      if (!safeRef) return { ok: false, error: 'Reference URL must start with https:// or ipfs://.' }
      out.referenceUrl = safeRef
    }
    return { ok: true, metadata: out }
  }

  if (obj.kind === 'deliverable') {
    const summary = sanitizeText(obj.summary, MAX_DELIVERABLE_SUMMARY_CHARS)
    const deliverableUrl = sanitizeSafeUrl(obj.deliverableUrl)
    if (!summary) return { ok: false, error: `Deliverable summary is required (1-${MAX_DELIVERABLE_SUMMARY_CHARS} chars).` }
    if (!deliverableUrl) {
      return { ok: false, error: 'Deliverable URL is required and must start with https:// or ipfs://.' }
    }
    return {
      ok: true,
      metadata: { version: 1, kind: 'deliverable', summary, deliverableUrl },
    }
  }

  return { ok: false, error: 'Invalid metadata kind; expected "spec" or "deliverable".' }
}

/** Deterministic canonical JSON string with fixed key order for keccak256 verification. */
export function canonicalizeBountyMetadata(metadata: BountyMetadata): string {
  if (metadata.kind === 'spec') {
    const ordered: Record<string, unknown> = {
      version: 1,
      kind: 'spec',
      title: metadata.title,
      description: metadata.description,
    }
    if (metadata.referenceUrl) ordered.referenceUrl = metadata.referenceUrl
    return JSON.stringify(ordered)
  }
  return JSON.stringify({
    version: 1,
    kind: 'deliverable',
    summary: metadata.summary,
    deliverableUrl: metadata.deliverableUrl,
  })
}

export function computeBountyMetadataHash(metadata: BountyMetadata): `0x${string}` {
  return keccak256(stringToBytes(canonicalizeBountyMetadata(metadata)))
}

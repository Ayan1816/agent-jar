import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { NextRequest, NextResponse } from 'next/server'
import {
  canonicalizeBountyMetadata,
  computeBountyMetadataHash,
  isNonZeroBytes32,
  MAX_METADATA_BODY_BYTES,
  validateAndSanitizeMetadata,
  type BountyMetadata,
} from '@/lib/bountyMetadata'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type StoredRecord = {
  hash: `0x${string}`
  metadata: BountyMetadata
  storedAt: string
}

const LOCAL_STORE_PATH = join(process.cwd(), '.data', 'bounty-metadata.json')

function getUpstashConfig(): { url: string; token: string } | null {
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim() ?? ''
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim() ?? ''
  if (!url || !token) return null
  return { url: url.replace(/\/+$/, ''), token }
}

function redisKey(hash: `0x${string}`): string {
  return `agentjar:v2:bounty-meta:${hash.toLowerCase()}`
}

async function readLocalStore(): Promise<Record<string, StoredRecord>> {
  try {
    const raw = await readFile(LOCAL_STORE_PATH, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, StoredRecord>
    }
    return {}
  } catch {
    return {}
  }
}

async function persistRecord(record: StoredRecord): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const upstash = getUpstashConfig()
  if (upstash) {
    try {
      const res = await fetch(`${upstash.url}/set/${encodeURIComponent(redisKey(record.hash))}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${upstash.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(record),
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) {
        return { ok: false, status: 503, error: 'Failed to persist metadata to Upstash Redis.' }
      }
      return { ok: true }
    } catch {
      return { ok: false, status: 503, error: 'Upstash Redis persistence endpoint unreachable.' }
    }
  }

  // Strictly disallow local JSON file fallback in production builds.
  if (process.env.NODE_ENV === 'production') {
    return {
      ok: false,
      status: 503,
      error:
        'Bounty metadata storage is not configured for production. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.',
    }
  }

  try {
    await mkdir(dirname(LOCAL_STORE_PATH), { recursive: true })
    const store = await readLocalStore()
    store[record.hash.toLowerCase()] = record
    await writeFile(LOCAL_STORE_PATH, JSON.stringify(store, null, 2), 'utf8')
    return { ok: true }
  } catch {
    return { ok: false, status: 500, error: 'Unable to write local development bounty metadata store.' }
  }
}

async function loadRecord(
  hash: `0x${string}`,
): Promise<{ ok: true; record: StoredRecord | null } | { ok: false; status: number; error: string }> {
  const upstash = getUpstashConfig()
  if (upstash) {
    try {
      const res = await fetch(`${upstash.url}/get/${encodeURIComponent(redisKey(hash))}`, {
        headers: { Authorization: `Bearer ${upstash.token}` },
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) {
        return { ok: false, status: 503, error: 'Failed to read metadata from Upstash Redis.' }
      }
      const json = (await res.json()) as { result?: string | StoredRecord | null }
      if (!json.result) return { ok: true, record: null }
      const parsed = typeof json.result === 'string' ? (JSON.parse(json.result) as StoredRecord) : json.result
      return { ok: true, record: parsed }
    } catch {
      return { ok: false, status: 503, error: 'Upstash Redis read endpoint unreachable.' }
    }
  }

  if (process.env.NODE_ENV === 'production') {
    return {
      ok: false,
      status: 503,
      error:
        'Bounty metadata storage is not configured for production. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.',
    }
  }

  const store = await readLocalStore()
  return { ok: true, record: store[hash.toLowerCase()] ?? null }
}

export async function POST(request: NextRequest) {
  const contentLength = request.headers.get('content-length')
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > MAX_METADATA_BODY_BYTES) {
    return NextResponse.json(
      { error: `Request body exceeds the ${MAX_METADATA_BODY_BYTES}-byte maximum.` },
      { status: 413, headers: { 'Cache-Control': 'no-store' } },
    )
  }

  let rawText: string
  try {
    rawText = await request.text()
  } catch {
    return NextResponse.json({ error: 'Unable to read request body.' }, { status: 400 })
  }

  if (Buffer.byteLength(rawText, 'utf8') > MAX_METADATA_BODY_BYTES) {
    return NextResponse.json(
      { error: `Request body exceeds the ${MAX_METADATA_BODY_BYTES}-byte maximum.` },
      { status: 413, headers: { 'Cache-Control': 'no-store' } },
    )
  }

  let body: unknown
  try {
    body = JSON.parse(rawText)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON request body.' }, { status: 400 })
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'Expected JSON object with { hash, metadata }.' }, { status: 400 })
  }

  const { hash, metadata: rawMetadata } = body as { hash?: unknown; metadata?: unknown }
  if (!isNonZeroBytes32(hash)) {
    return NextResponse.json(
      { error: 'Missing or invalid 32-byte non-zero keccak256 hash (0x...).' },
      { status: 400 },
    )
  }

  const validated = validateAndSanitizeMetadata(rawMetadata)
  if (!validated.ok) {
    return NextResponse.json({ error: validated.error }, { status: 400 })
  }

  const computedHash = computeBountyMetadataHash(validated.metadata)
  if (computedHash.toLowerCase() !== hash.toLowerCase()) {
    return NextResponse.json(
      {
        error: 'Hash mismatch: canonical keccak256 of payload does not match provided hash.',
        expectedHash: computedHash,
        providedHash: hash,
      },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    )
  }

  const record: StoredRecord = {
    hash: computedHash,
    metadata: validated.metadata,
    storedAt: new Date().toISOString(),
  }

  const saved = await persistRecord(record)
  if (!saved.ok) {
    return NextResponse.json({ error: saved.error }, { status: saved.status, headers: { 'Cache-Control': 'no-store' } })
  }

  return NextResponse.json(
    {
      verified: true,
      hash: computedHash,
      canonicalBytes: Buffer.byteLength(canonicalizeBountyMetadata(validated.metadata), 'utf8'),
      metadata: validated.metadata,
      storedAt: record.storedAt,
    },
    { status: 201, headers: { 'Cache-Control': 'no-store' } },
  )
}

export async function GET(request: NextRequest) {
  const hashParam = request.nextUrl.searchParams.get('hash')?.trim() ?? ''
  if (!isNonZeroBytes32(hashParam)) {
    return NextResponse.json(
      { error: 'Missing or invalid query parameter: hash (expected 32-byte 0x hex).' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    )
  }

  const loaded = await loadRecord(hashParam)
  if (!loaded.ok) {
    return NextResponse.json(
      { error: loaded.error },
      { status: loaded.status, headers: { 'Cache-Control': 'no-store' } },
    )
  }

  if (!loaded.record) {
    return NextResponse.json(
      { error: 'Metadata not found for the requested hash.' },
      { status: 404, headers: { 'Cache-Control': 'no-store' } },
    )
  }

  // Re-validate and re-hash on every read to guarantee tamper-proof integrity.
  const validated = validateAndSanitizeMetadata(loaded.record.metadata)
  if (!validated.ok) {
    return NextResponse.json(
      { error: 'Stored metadata failed integrity schema validation.' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    )
  }

  const recomputed = computeBountyMetadataHash(validated.metadata)
  if (recomputed.toLowerCase() !== hashParam.toLowerCase()) {
    return NextResponse.json(
      { error: 'Integrity failure: stored metadata hash does not match requested keccak256 hash.' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    )
  }

  return NextResponse.json(
    {
      verified: true,
      hash: recomputed,
      metadata: validated.metadata,
      storedAt: loaded.record.storedAt,
    },
    {
      status: 200,
      headers: {
        'Cache-Control': 'public, max-age=60, s-maxage=300, stale-while-revalidate=600',
      },
    },
  )
}

import { NextRequest, NextResponse } from 'next/server'
import { fetchActiveLeaderboard } from '@/lib/serverClient'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const limitParam = request.nextUrl.searchParams.get('limit')
  let limit = 50
  if (limitParam !== null) {
    if (!/^\d+$/.test(limitParam)) {
      return NextResponse.json({ error: 'Invalid limit parameter. Provide a positive integer up to 200.' }, { status: 400 })
    }
    const parsed = Number(limitParam)
    if (parsed < 1 || parsed > 200) {
      return NextResponse.json({ error: 'limit must be between 1 and 200.' }, { status: 400 })
    }
    limit = parsed
  }

  try {
    const payload = await fetchActiveLeaderboard(limit)
    return NextResponse.json(payload, {
      status: 200,
      headers: {
        'Cache-Control': 'public, s-maxage=15, stale-while-revalidate=60',
      },
    })
  } catch {
    return NextResponse.json(
      { error: 'Unable to read AgentJar v2 active agent directory from BSC Mainnet RPCs.' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    )
  }
}

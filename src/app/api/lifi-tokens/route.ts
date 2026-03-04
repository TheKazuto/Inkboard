import { NextRequest, NextResponse } from 'next/server'
import { kvGet, kvSet } from '@/lib/kvCache'

export const revalidate = 0

const LIFI_API = 'https://li.quest/v1'
const SOFT_TTL = 5 * 60 * 1000  // 5 minutes
const HARD_TTL = 30 * 60        // 30 minutes (seconds) — stale fallback window

// Allowlist: only accept numeric chain IDs
const VALID_CHAIN = /^\d{1,8}$/

export async function GET(req: NextRequest) {
  const chainId = req.nextUrl.searchParams.get('chain')
  if (!chainId || !VALID_CHAIN.test(chainId)) {
    return NextResponse.json({ tokens: {} }, { status: 400 })
  }

  const cacheKey = `lifi-tokens:${chainId}`
  const cached = await kvGet<unknown>(cacheKey, SOFT_TTL)

  if (cached.data && cached.fresh) {
    return NextResponse.json(cached.data)
  }

  try {
    const res = await fetch(`${LIFI_API}/tokens?chains=${chainId}`, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) throw new Error(`LI.FI ${res.status}`)
    const data = await res.json()
    await kvSet(cacheKey, data, HARD_TTL)
    return NextResponse.json(data)
  } catch (e: unknown) {
    console.error('[lifi-tokens] chain:', chainId, e instanceof Error ? e.message : e)
    // Return stale cache on error
    if (cached.data) return NextResponse.json(cached.data)
    return NextResponse.json({ tokens: {} }, { status: 502 })
  }
}

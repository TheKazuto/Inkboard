import { NextRequest, NextResponse } from 'next/server'

export const revalidate = 0

const LIFI_API = 'https://li.quest/v1'
const cache = new Map<string, { data: unknown; ts: number }>()
const TTL = 5 * 60 * 1000  // 5 minutes — tokens change more often than chains

// Allowlist: only accept numeric chain IDs
const VALID_CHAIN = /^\d{1,8}$/

export async function GET(req: NextRequest) {
  const chainId = req.nextUrl.searchParams.get('chain')
  if (!chainId || !VALID_CHAIN.test(chainId)) {
    return NextResponse.json({ tokens: {} }, { status: 400 })
  }

  const cached = cache.get(chainId)
  if (cached && Date.now() - cached.ts < TTL) {
    return NextResponse.json(cached.data)
  }

  try {
    const res = await fetch(`${LIFI_API}/tokens?chains=${chainId}`, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) throw new Error(`LI.FI ${res.status}`)
    const data = await res.json()
    cache.set(chainId, { data, ts: Date.now() })
    return NextResponse.json(data)
  } catch (e: unknown) {
    console.error('[lifi-tokens] chain:', chainId, e instanceof Error ? e.message : e)
    // Return stale cache on error
    if (cached) return NextResponse.json(cached.data)
    return NextResponse.json({ tokens: {} }, { status: 502 })
  }
}

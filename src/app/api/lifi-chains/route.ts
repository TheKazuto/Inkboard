import { NextResponse } from 'next/server'

export const revalidate = 0

const LIFI_API = 'https://li.quest/v1'
let cache: { data: unknown; ts: number } | null = null
const TTL = 60 * 60 * 1000  // 1 hour — chain list is very stable

export async function GET() {
  if (cache && Date.now() - cache.ts < TTL) {
    return NextResponse.json(cache.data)
  }

  try {
    const res = await fetch(`${LIFI_API}/chains?chainTypes=EVM`, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) throw new Error(`LI.FI ${res.status}`)
    const data = await res.json()
    cache = { data, ts: Date.now() }
    return NextResponse.json(data)
  } catch (e: unknown) {
    console.error('[lifi-chains]', e instanceof Error ? e.message : e)
    // Return cached data even if stale
    if (cache) return NextResponse.json(cache.data)
    return NextResponse.json({ chains: [] }, { status: 502 })
  }
}

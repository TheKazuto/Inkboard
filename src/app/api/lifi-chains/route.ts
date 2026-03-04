import { NextResponse } from 'next/server'
import { kvGet, kvSet } from '@/lib/kvCache'

export const revalidate = 0

const LIFI_API = 'https://li.quest/v1'
const SOFT_TTL = 60 * 60 * 1000   // 1 hour — chain list is very stable
const HARD_TTL = 4 * 60 * 60      // 4 hours (seconds) — stale fallback window

export async function GET() {
  const cached = await kvGet<unknown>('lifi-chains', SOFT_TTL)

  if (cached.data && cached.fresh) {
    return NextResponse.json(cached.data)
  }

  try {
    const res = await fetch(`${LIFI_API}/chains?chainTypes=EVM`, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) throw new Error(`LI.FI ${res.status}`)
    const data = await res.json()
    await kvSet('lifi-chains', data, HARD_TTL)
    return NextResponse.json(data)
  } catch (e: unknown) {
    console.error('[lifi-chains]', e instanceof Error ? e.message : e)
    // Return stale cached data on error
    if (cached.data) return NextResponse.json(cached.data)
    return NextResponse.json({ chains: [] }, { status: 502 })
  }
}

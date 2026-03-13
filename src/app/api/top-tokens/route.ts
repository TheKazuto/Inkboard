import { NextResponse } from 'next/server'
import { kvGet, kvSet } from '@/lib/kvCache'

export const revalidate = 0

// KV cache — shared across all isolates/users
// SOFT_TTL = 5min  →  fresh window
// HARD_TTL = 15min →  stale fallback stays available 10min after soft miss
const CACHE_KEY = 'top-tokens'
const SOFT_TTL  = 5 * 60 * 1000  // 5 minutes (ms)
const HARD_TTL  = 15 * 60         // 15 minutes (seconds)

export async function GET() {
  // Fast path — serve from KV if fresh
  const cached = await kvGet<unknown>(CACHE_KEY, SOFT_TTL)
  if (cached.data && cached.fresh) {
    return NextResponse.json(cached.data, { headers: { 'X-Cache': 'HIT' } })
  }

  try {
    const apiKey = process.env.COINGECKO_API_KEY
    const headers: Record<string, string> = { 'Accept': 'application/json' }
    if (apiKey) headers['x-cg-demo-api-key'] = apiKey

    const res = await fetch(
      'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&category=ink-ecosystem&order=market_cap_desc&per_page=10&page=1&sparkline=false&price_change_percentage=24h',
      { headers, signal: AbortSignal.timeout(10_000) }
    )

    if (!res.ok) {
      // Return stale data on upstream error rather than propagating the error
      if (cached.data) return NextResponse.json(cached.data, { headers: { 'X-Cache': 'STALE' } })
      return NextResponse.json({ error: 'CoinGecko error', status: res.status }, { status: res.status })
    }

    const data = await res.json()
    await kvSet(CACHE_KEY, data, HARD_TTL)
    return NextResponse.json(data, { headers: { 'X-Cache': 'MISS' } })
  } catch (err) {
    console.error('[top-tokens] fetch error:', err)
    if (cached.data) return NextResponse.json(cached.data, { headers: { 'X-Cache': 'STALE' } })
    return NextResponse.json({ error: 'Failed to fetch' }, { status: 500 })
  }
}

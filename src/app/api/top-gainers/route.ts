import { NextResponse } from 'next/server'

export const revalidate = 0

const GECKO = 'https://api.geckoterminal.com/api/v2'

interface Gainer {
  symbol: string
  name: string
  address: string
  priceUsd: number
  change24h: number
  volume24h: number
  imageUrl: string | null
}

// Module-level cache — 3 minutes
let cache: { data: Gainer[]; ts: number } | null = null
const TTL = 3 * 60 * 1000

export async function GET() {
  // Serve from cache if fresh
  if (cache && Date.now() - cache.ts < TTL) {
    return NextResponse.json(cache.data)
  }

  try {
    // Fetch trending pools on Ink — sorted by activity, includes 24h price change
    // Also fetch top pools by volume as a fallback source
    const [trendingRes, volumeRes] = await Promise.all([
      fetch(`${GECKO}/networks/ink/trending_pools?page=1`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      }).catch(() => null),
      fetch(`${GECKO}/networks/ink/pools?page=1&sort=h24_volume_usd_desc`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      }).catch(() => null),
    ])

    const allPools: any[] = []

    for (const res of [trendingRes, volumeRes]) {
      if (!res || !res.ok) continue
      const json = await res.json()
      const pools = json?.data ?? []
      allPools.push(...pools)
    }

    if (allPools.length === 0) {
      return NextResponse.json(cache?.data ?? [], { status: 200 })
    }

    // Build included token map for metadata (images, names)
    // Some responses include token metadata in "included"
    const tokenMap = new Map<string, any>()

    // Extract unique base tokens with their 24h change, deduped by address
    const seen = new Map<string, Gainer>()

    for (const pool of allPools) {
      const attrs = pool.attributes
      if (!attrs) continue

      const change24h = parseFloat(attrs.price_change_percentage?.h24 ?? '0')
      const volume24h = parseFloat(attrs.volume_usd?.h24 ?? '0')
      const priceUsd  = parseFloat(attrs.base_token_price_usd ?? '0')

      // Extract base token info from pool name (format: "TOKEN / QUOTE")
      const poolName = attrs.name ?? ''
      const baseSymbol = poolName.split('/')[0]?.trim() ?? ''
      if (!baseSymbol) continue

      // Get base token address from relationship
      const baseTokenId = pool.relationships?.base_token?.data?.id ?? ''
      const address = baseTokenId.split('_').pop() ?? ''

      // Skip only wrapped native tokens (they duplicate ETH price action)
      const skipSymbols = ['WETH', 'wETH']
      if (skipSymbols.includes(baseSymbol)) continue

      // Skip pools with very low volume (likely spam)
      if (volume24h < 100) continue

      // Keep the entry with highest 24h change per token
      const existing = seen.get(address.toLowerCase())
      if (!existing || change24h > existing.change24h) {
        seen.set(address.toLowerCase(), {
          symbol: baseSymbol,
          name: baseSymbol, // GeckoTerminal pool names often just have symbol
          address,
          priceUsd,
          change24h,
          volume24h,
          imageUrl: attrs.base_token_image_url ?? null,
        })
      }
    }

    // Sort by 24h change descending, take top 10
    const sorted = [...seen.values()]
      .filter(t => t.change24h > -100) // filter out broken data
      .sort((a, b) => b.change24h - a.change24h)
      .slice(0, 10)

    cache = { data: sorted, ts: Date.now() }
    return NextResponse.json(sorted)
  } catch (e) {
    console.error('[top-gainers] Error:', e)
    return NextResponse.json(cache?.data ?? [], { status: 200 })
  }
}

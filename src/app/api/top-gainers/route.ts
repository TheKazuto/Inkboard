import { NextResponse } from 'next/server'

export const revalidate = 0

const GECKO = 'https://api.geckoterminal.com/api/v2'

interface Gainer {
  symbol:    string
  name:      string
  address:   string
  priceUsd:  number
  change24h: number
  volume24h: number
  imageUrl:  string | null
}

// Module-level cache — 3 minutes
let cache: { data: Gainer[]; ts: number } | null = null
const TTL = 3 * 60 * 1000

export async function GET() {
  if (cache && Date.now() - cache.ts < TTL) {
    return NextResponse.json(cache.data)
  }

  try {
    // include=base_token,quote_token populates the `included` array with token
    // metadata (symbol, name, image_url) keyed by relationship ID.
    const [trendingRes, volumeRes] = await Promise.all([
      fetch(`${GECKO}/networks/ink/trending_pools?page=1&include=base_token,quote_token`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      }).catch(() => null),
      fetch(`${GECKO}/networks/ink/pools?page=1&sort=h24_volume_usd_desc&include=base_token,quote_token`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      }).catch(() => null),
    ])

    const allPools:    any[] = []
    const allIncluded: any[] = []

    for (const res of [trendingRes, volumeRes]) {
      if (!res || !res.ok) continue
      const json = await res.json()
      allPools.push(...(json?.data     ?? []))
      allIncluded.push(...(json?.included ?? []))
    }

    if (allPools.length === 0) {
      return NextResponse.json(cache?.data ?? [], { status: 200 })
    }

    // Build token metadata map: GeckoTerminal relationship ID → { symbol, name, imageUrl }
    // Relationship ID format: "token_ink_0xADDRESS"
    const tokenMeta = new Map<string, { symbol: string; name: string; imageUrl: string | null }>()
    for (const inc of allIncluded) {
      if (inc.type !== 'token') continue
      const a = inc.attributes ?? {}
      tokenMeta.set(inc.id, {
        symbol:   a.symbol  ?? '',
        name:     a.name    ?? a.symbol ?? '',
        imageUrl: (a.image_url && a.image_url !== 'missing.png') ? a.image_url : null,
      })
    }

    const skipSymbols = new Set(['WETH', 'wETH'])
    const seen = new Map<string, Gainer>()

    for (const pool of allPools) {
      const attrs = pool.attributes ?? {}

      const change24h = parseFloat(attrs.price_change_percentage?.h24 ?? '0')
      const volume24h = parseFloat(attrs.volume_usd?.h24 ?? '0')
      const priceUsd  = parseFloat(attrs.base_token_price_usd ?? '0')

      if (volume24h < 100) continue

      // Resolve base token via relationship → included metadata
      const baseRelId = pool.relationships?.base_token?.data?.id ?? ''
      const meta      = tokenMeta.get(baseRelId)

      // Fallback: parse symbol from pool name "TOKEN / QUOTE"
      const poolName   = attrs.name ?? ''
      const fallbackSym = poolName.split('/')[0]?.trim() ?? ''

      const symbol = meta?.symbol || fallbackSym
      if (!symbol || skipSymbols.has(symbol)) continue

      // Address is the last segment of the relationship ID
      const address = baseRelId.split('_').pop() ?? ''
      if (!address) continue

      const existing = seen.get(address.toLowerCase())
      if (!existing || change24h > existing.change24h) {
        seen.set(address.toLowerCase(), {
          symbol,
          name:     meta?.name ?? symbol,
          address,
          priceUsd,
          change24h,
          volume24h,
          imageUrl: meta?.imageUrl ?? null,
        })
      }
    }

    const sorted = [...seen.values()]
      .filter(t => t.change24h > -100)
      .sort((a, b) => b.change24h - a.change24h)
      .slice(0, 10)

    cache = { data: sorted, ts: Date.now() }
    return NextResponse.json(sorted)
  } catch (e) {
    console.error('[top-gainers] Error:', e)
    return NextResponse.json(cache?.data ?? [], { status: 200 })
  }
}

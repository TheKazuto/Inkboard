import { NextRequest, NextResponse } from 'next/server'
import { kvGet, kvSet } from '@/lib/kvCache'

// KV cache — 1h soft TTL, 4h hard TTL
const SOFT_TTL = 60 * 60 * 1000   // 1 hour (ms)
const HARD_TTL = 4 * 60 * 60      // 4 hours (seconds)

// Fix #3 (ALTO): Strict allowlist of valid platform values.
// Previously, the `platform` param was interpolated directly into the CoinGecko URL
// without any validation, enabling path traversal and cache-key poisoning.
// Now only known-good values are accepted — anything else gets a 400.

/** Platforms served via GeckoTerminal (Ink not yet on CoinGecko token list) */
const GECKO_TERMINAL_NETWORKS: Record<string, string> = {
  ink:          'ink',
  'ink-mainnet': 'ink',
}

/** All valid CoinGecko token-list platform slugs supported by the swap page */
const COINGECKO_PLATFORMS = new Set([
  'ethereum',
  'binance-smart-chain',
  'polygon-pos',
  'avalanche',
  'arbitrum-one',
  'optimistic-ethereum',
  'base',
  'fantom',
  'aurora',
  'celo',
  'harmony-shard-0',
  'moonbeam',
  'moonriver',
  'cronos',
  'xdai',
  'klay-token',
  'boba',
  'okex-chain',
  'telos',
  'fuse',
  'iotex',
  'tron',
  'near-protocol',
  'linea',
  'zksync',
  'scroll',
  'mantle',
  'blast',
  'metis-andromeda',
  'zkfair',
  'solana',
])

async function fetchFromGeckoTerminal(network: string) {
  const tokenMap = new Map<string, {
    symbol: string; name: string; address: string; decimals: number; logoURI: string
  }>()

  for (let page = 1; page <= 3; page++) {
    try {
      const res = await fetch(
        `https://api.geckoterminal.com/api/v2/networks/${encodeURIComponent(network)}/pools?include=base_token,quote_token&page=${page}&sort=h24_volume_usd_desc`,
        { headers: { 'Accept': 'application/json' }, next: { revalidate: 3600 } }
      )
      if (!res.ok) break

      const data = await res.json()
      const included: unknown[] = data.included ?? []

      for (const item of included) {
        if (typeof item !== 'object' || item === null) continue
        const obj = item as Record<string, unknown>
        if (obj.type !== 'token') continue
        const a = obj.attributes as Record<string, unknown>
        const addr = (a.address as string)?.toLowerCase()
        if (!addr || tokenMap.has(addr)) continue

        tokenMap.set(addr, {
          symbol:   (a.symbol as string) ?? '',
          name:     (a.name as string) ?? (a.symbol as string) ?? '',
          address:  a.address as string,
          decimals: (a.decimals as number) ?? 18,
          logoURI:  a.image_url && a.image_url !== 'missing.png' ? (a.image_url as string) : '',
        })
      }
    } catch { break }
  }

  return { tokens: Array.from(tokenMap.values()) }
}

export async function GET(req: NextRequest) {
  const platform = req.nextUrl.searchParams.get('platform')
  if (!platform) {
    return NextResponse.json({ error: 'Missing platform', tokens: [] }, { status: 400 })
  }

  // Fix #3: Reject any platform not in our allowlists
  const gtNetwork = GECKO_TERMINAL_NETWORKS[platform]
  const isCoinGecko = COINGECKO_PLATFORMS.has(platform)
  if (!gtNetwork && !isCoinGecko) {
    return NextResponse.json({ error: 'Unsupported platform', tokens: [] }, { status: 400 })
  }

  // Check cache (key is now guaranteed to be a known-safe value)
  const cacheKey = `token-list:${platform}`
  const cached = await kvGet<unknown>(cacheKey, SOFT_TTL)
  if (cached.data && cached.fresh) {
    return NextResponse.json(cached.data)
  }

  try {
    let data: unknown

    if (gtNetwork) {
      data = await fetchFromGeckoTerminal(gtNetwork)
    } else {
      // Safe: platform is a member of the COINGECKO_PLATFORMS allowlist
      const res = await fetch(`https://tokens.coingecko.com/${platform}/all.json`, {
        headers: { 'Accept': 'application/json' },
        next: { revalidate: 3600 },
      })
      if (!res.ok) throw new Error(`CoinGecko ${res.status}`)
      data = await res.json()
    }

    await kvSet(cacheKey, data, HARD_TTL)
    return NextResponse.json(data)
  } catch (e: unknown) {
    // Fix #9: Generic error — no internal details exposed
    console.error('[token-list] platform:', platform, 'error:', e instanceof Error ? e.message : e)
    // Return stale cache on error
    if (cached.data) return NextResponse.json(cached.data)
    return NextResponse.json({ error: 'Failed to fetch token list', tokens: [] }, { status: 502 })
  }
}

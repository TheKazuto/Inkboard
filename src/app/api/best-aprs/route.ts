import { NextResponse } from 'next/server'

export const revalidate = 0

// ─── Types ────────────────────────────────────────────────────────────────────
export interface AprEntry {
  protocol:   string
  logo:       string
  url:        string
  tokens:     string[]
  label:      string
  apr:        number
  type:       'pool' | 'vault' | 'lend'
  isStable:   boolean
}

// ─── Stablecoin classification ────────────────────────────────────────────────
const STABLECOINS = new Set([
  'USDC', 'USDC.e', 'USDT', 'USDT0', 'DAI', 'FRAX', 'frxUSD', 'sfrxUSD',
  'crvUSD', 'BUSD', 'TUSD', 'LUSD', 'MIM', 'USD1', 'LVUSD',
])

function isStable(sym: string): boolean { return STABLECOINS.has(sym) }
function allStable(tokens: string[]): boolean { return tokens.length > 0 && tokens.every(isStable) }

// ─── Server-side cache ────────────────────────────────────────────────────────
const CACHE_TTL = 3 * 60 * 1000 // 3 minutes

interface CacheEntry {
  data:      AprEntry[]
  fetchedAt: number
}

let cache: CacheEntry | null = null
let inflight: Promise<AprEntry[]> | null = null

// ─── Curve (Ink) ──────────────────────────────────────────────────────────────
async function fetchCurve(): Promise<AprEntry[]> {
  const out: AprEntry[] = []
  try {
    // Try both factory types for Ink
    const factoryTypes = ['factory-twocrypto', 'factory-stable']
    
    for (const factory of factoryTypes) {
      try {
        const res = await fetch(
          `https://api-core.curve.finance/v1/getPools/ink/${factory}`,
          { signal: AbortSignal.timeout(10_000) }
        )
        if (!res.ok) continue
        const json = await res.json()
        const pools = json?.data?.poolData ?? []

        for (const p of pools) {
          const symbols = (p.coins ?? []).map((c: any) => c.symbol ?? '?')
          const tvl = p.usdTotal ?? 0
          if (tvl < 1_000) continue // skip tiny pools

          // Estimate APR from virtualPrice change if available
          let apr = 0
          if (p.gaugeCrvApy && Array.isArray(p.gaugeCrvApy) && p.gaugeCrvApy.length > 0) {
            apr = p.gaugeCrvApy[0] ?? 0
          }
          if (!apr && p.apy) {
            apr = typeof p.apy === 'number' ? p.apy : 0
          }

          if (apr <= 0) continue

          out.push({
            protocol: 'Curve',
            logo:     'https://icons.llamao.fi/icons/protocols/curve-dex?w=48&h=48',
            url:      `https://curve.fi/#/ink/pools`,
            tokens:   symbols,
            label:    symbols.join('/'),
            apr,
            type:     'pool',
            isStable: allStable(symbols),
          })
        }
      } catch { /* skip factory type */ }
    }
  } catch (e) { console.error('[best-aprs] Curve error:', e) }
  return out
}

// ─── Uniswap V3+V4 (Ink) ─────────────────────────────────────────────────────
async function fetchUniswap(): Promise<AprEntry[]> {
  const out: AprEntry[] = []
  try {
    const query = `{
      v3Pools: topV3Pools(first: 50, chain: INK, orderBy: TVL) {
        protocolVersion
        address
        token0 { symbol }
        token1 { symbol }
        tvl { value }
        volume1Day: cumulativeVolume(duration: DAY) { value }
        feeTier
      }
      v4Pools: topV4Pools(first: 50, chain: INK, orderBy: TVL) {
        protocolVersion
        poolId
        token0 { symbol }
        token1 { symbol }
        tvl { value }
        volume1Day: cumulativeVolume(duration: DAY) { value }
        feeTier
      }
    }`

    const res = await fetch('https://interface.gateway.uniswap.org/v1/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://app.uniswap.org',
      },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(12_000),
    })

    if (!res.ok) return out
    const json = await res.json()

    const v3 = json?.data?.v3Pools ?? []
    const v4 = json?.data?.v4Pools ?? []
    const allPools = [...v3, ...v4]

    for (const p of allPools) {
      const sym0 = p.token0?.symbol ?? '?'
      const sym1 = p.token1?.symbol ?? '?'
      const tvl = p.tvl?.value ?? 0
      const vol = p.volume1Day?.value ?? 0
      const fee = (p.feeTier ?? 3000) / 1_000_000

      if (tvl < 1_000) continue

      const dailyFeeRev = vol * fee
      const apr = tvl > 0 ? (dailyFeeRev / tvl) * 365 * 100 : 0

      if (apr <= 0 || apr > 50_000) continue

      const version = p.protocolVersion === 'V4' ? 'V4' : 'V3'
      const id = p.address ?? p.poolId ?? ''

      out.push({
        protocol: `Uniswap ${version}`,
        logo:     'https://icons.llamao.fi/icons/protocols/uniswap?w=48&h=48',
        url:      `https://app.uniswap.org/pool/${id}`,
        tokens:   [sym0, sym1],
        label:    `${sym0}/${sym1}`,
        apr,
        type:     'pool',
        isStable: allStable([sym0, sym1]),
      })
    }
  } catch (e) { console.error('[best-aprs] Uniswap error:', e) }
  return out
}

// ─── Velodrome Slipstream (Ink) ───────────────────────────────────────────────
// TODO: Add Velodrome API integration when scanner is ready
// API endpoint: https://api.velodrome.finance or sugar subgraph

// ─── Aave (Ink) ──────────────────────────────────────────────────────────────
// TODO: Add Aave integration when deployed/scanner ready

// ─── Frax (Ink) ──────────────────────────────────────────────────────────────
// TODO: Add Frax vault APRs (sfrxUSD, sfrxETH)

// ─── InkySwap (Ink) ──────────────────────────────────────────────────────────
// TODO: Add InkySwap integration

// ─── Main fetch function ──────────────────────────────────────────────────────
async function fetchAllAprs(): Promise<AprEntry[]> {
  const results = await Promise.allSettled([
    fetchCurve(),
    fetchUniswap(),
  ])

  const all: AprEntry[] = []
  for (const r of results) {
    if (r.status === 'fulfilled') all.push(...r.value)
  }

  // Sort by APR descending
  all.sort((a, b) => b.apr - a.apr)
  return all
}

// ─── GET handler ──────────────────────────────────────────────────────────────
export async function GET() {
  const now = Date.now()

  // Return cached data if fresh
  if (cache && now - cache.fetchedAt < CACHE_TTL) {
    return NextResponse.json(cache.data, {
      headers: { 'X-Cache': 'HIT', 'Cache-Control': 'public, max-age=60' },
    })
  }

  // Deduplicate in-flight requests
  if (!inflight) {
    inflight = fetchAllAprs().finally(() => { inflight = null })
  }

  try {
    const data = await inflight
    cache = { data, fetchedAt: now }
    return NextResponse.json(data, {
      headers: { 'X-Cache': 'MISS', 'Cache-Control': 'public, max-age=60' },
    })
  } catch (e) {
    console.error('[best-aprs] Fatal:', e)
    // Fallback to stale cache
    if (cache) {
      return NextResponse.json(cache.data, {
        headers: { 'X-Cache': 'STALE' },
      })
    }
    return NextResponse.json([], { status: 502 })
  }
}

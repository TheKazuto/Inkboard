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
  tvl:        number
  type:       'pool' | 'vault' | 'lend'
  isStable:   boolean
}

// ─── Stablecoin classification ────────────────────────────────────────────────
const STABLECOINS = new Set([
  'USDC', 'USDC.E', 'USDT', 'USDT0', 'DAI', 'FRAX', 'FRXUSD', 'SFRXUSD',
  'CRVUSD', 'BUSD', 'TUSD', 'LUSD', 'MIM', 'USD1', 'LVUSD', 'USDE', 'SUSDE',
  'DOLA', 'GUSD', 'SUSD', 'USDP', 'PYUSD', 'FDUSD',
])

function isStable(sym: string): boolean {
  return STABLECOINS.has(sym.toUpperCase())
}
function allStable(tokens: string[]): boolean {
  return tokens.length > 0 && tokens.every(isStable)
}

// ─── Protocol metadata ───────────────────────────────────────────────────────
// Map DefiLlama project slugs to display info
const PROTOCOL_META: Record<string, { name: string; logo: string; urlBase: string }> = {
  'velodrome-v3': {
    name: 'Velodrome V3',
    logo: 'https://icons.llamao.fi/icons/protocols/velodrome-v2?w=48&h=48',
    urlBase: 'https://velodrome.finance/liquidity?filters=Ink',
  },
  'velodrome-v2': {
    name: 'Velodrome V2',
    logo: 'https://icons.llamao.fi/icons/protocols/velodrome-v2?w=48&h=48',
    urlBase: 'https://velodrome.finance/liquidity?filters=Ink',
  },
  'velodrome': {
    name: 'Velodrome',
    logo: 'https://icons.llamao.fi/icons/protocols/velodrome-v2?w=48&h=48',
    urlBase: 'https://velodrome.finance/liquidity?filters=Ink',
  },
  'curve-dex': {
    name: 'Curve',
    logo: 'https://icons.llamao.fi/icons/protocols/curve-dex?w=48&h=48',
    urlBase: 'https://curve.fi/#/ink/pools',
  },
  'uniswap-v3': {
    name: 'Uniswap V3',
    logo: 'https://icons.llamao.fi/icons/protocols/uniswap?w=48&h=48',
    urlBase: 'https://app.uniswap.org/explore/pools',
  },
  'uniswap-v4': {
    name: 'Uniswap V4',
    logo: 'https://icons.llamao.fi/icons/protocols/uniswap?w=48&h=48',
    urlBase: 'https://app.uniswap.org/explore/pools',
  },
  'aave-v3': {
    name: 'Aave V3',
    logo: 'https://icons.llamao.fi/icons/protocols/aave-v3?w=48&h=48',
    urlBase: 'https://app.aave.com/reserve-overview',
  },
  'morpho': {
    name: 'Morpho',
    logo: 'https://icons.llamao.fi/icons/protocols/morpho?w=48&h=48',
    urlBase: 'https://app.morpho.org',
  },
  'beefy': {
    name: 'Beefy',
    logo: 'https://icons.llamao.fi/icons/protocols/beefy?w=48&h=48',
    urlBase: 'https://app.beefy.com',
  },
  'yearn-finance': {
    name: 'Yearn',
    logo: 'https://icons.llamao.fi/icons/protocols/yearn-finance?w=48&h=48',
    urlBase: 'https://yearn.fi/vaults',
  },
  'tydro': {
    name: 'Tydro',
    logo: 'https://icons.llamao.fi/icons/protocols/tydro?w=48&h=48',
    urlBase: 'https://app.tydro.com',
  },
}

// Infer pool type from DefiLlama project, pool metadata, and exposure
function inferType(project: string, poolMeta: string | null, exposure: string | null): 'pool' | 'vault' | 'lend' {
  const p = project.toLowerCase()
  const m = (poolMeta ?? '').toLowerCase()
  const e = (exposure ?? '').toLowerCase()

  // Lending protocols (explicit list)
  if (p.includes('aave') || p.includes('compound') || p.includes('morpho') ||
      p.includes('silo') || p.includes('euler') || p.includes('fraxlend') ||
      p.includes('tydro') || p.includes('radiant') || p.includes('spark') ||
      p.includes('benqi') || p.includes('moonwell') || p.includes('seamless') ||
      p.includes('ionic') || p.includes('dforce') || p.includes('venus') ||
      m.includes('lend') || m.includes('supply') || m.includes('borrow')) {
    return 'lend'
  }

  // DefiLlama "single" exposure with no pool pair → lending market
  if (e === 'single') return 'lend'

  // Vault / yield aggregator protocols
  if (p.includes('beefy') || p.includes('yearn') || p.includes('convex') ||
      p.includes('stakedao') || p.includes('concentrator') ||
      m.includes('vault') || m.includes('auto')) {
    return 'vault'
  }

  // Default: liquidity pool
  return 'pool'
}

// ─── Server-side cache ────────────────────────────────────────────────────────
const CACHE_TTL = 3 * 60 * 1000 // 3 minutes

interface CacheEntry {
  data:      AprEntry[]
  fetchedAt: number
}

let cache: CacheEntry | null = null
let inflight: Promise<AprEntry[]> | null = null

// ─── DefiLlama Yields API ────────────────────────────────────────────────────
// Free endpoint, returns all pools across all chains and protocols.
// We filter server-side for chain=Ink.
// Docs: https://defillama.com/docs/api
async function fetchDefiLlama(): Promise<AprEntry[]> {
  const out: AprEntry[] = []
  try {
    const res = await fetch('https://yields.llama.fi/pools', {
      signal: AbortSignal.timeout(15_000),
      headers: { 'Accept': 'application/json' },
    })

    if (!res.ok) {
      console.error(`[best-aprs] DefiLlama HTTP ${res.status}`)
      return out
    }

    const json = await res.json()
    const pools: any[] = json?.data ?? []

    // Filter for Ink chain only
    const inkPools = pools.filter((p: any) =>
      p.chain?.toLowerCase() === 'ink'
    )

    console.log(`[best-aprs] DefiLlama: ${pools.length} total pools, ${inkPools.length} on Ink`)

    // Debug: log unique projects found on Ink
    const projects = [...new Set(inkPools.map((p: any) => p.project))]
    console.log(`[best-aprs] Ink projects: ${projects.join(', ')}`)

    for (const p of inkPools) {
      const project = p.project ?? ''
      const symbol  = p.symbol ?? ''
      const apy     = p.apy ?? 0         // Total APY (base + reward)
      const apyBase = p.apyBase ?? 0     // Base APY from fees
      const tvl     = p.tvlUsd ?? 0

      // Skip tiny pools and zero APY
      if (tvl < 100 || apy <= 0) continue

      // Cap unrealistic APYs (>50000% likely error)
      if (apy > 50_000) continue

      // Parse token symbols from the symbol field
      // DefiLlama formats: "USDC-WETH", "USDC", "WETH-USDC (CL200)", "WETH-USDC (stable)"
      const cleanSymbol = symbol.replace(/\s*\([^)]*\)\s*/g, '') // Remove parenthesized suffixes
      const tokens = cleanSymbol
        .split(/[-\/]/)
        .map((t: string) => t.trim())
        .filter(Boolean)

      // Use APY as displayed (DefiLlama already annualizes)
      const apr = apy

      const type = inferType(project, p.poolMeta ?? null, p.exposure ?? null)

      // Get protocol display info
      const meta = PROTOCOL_META[project] ?? {
        name: project.replace(/-/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()),
        logo: `https://icons.llamao.fi/icons/protocols/${project}?w=48&h=48`,
        urlBase: '#',
      }

      out.push({
        protocol: meta.name,
        logo:     meta.logo,
        url:      meta.urlBase,
        tokens,
        label:    symbol,
        apr,
        tvl,
        type,
        isStable: allStable(tokens),
      })
    }
  } catch (e) {
    console.error('[best-aprs] DefiLlama error:', e)
  }
  return out
}

// ─── Main fetch function ──────────────────────────────────────────────────────
async function fetchAllAprs(): Promise<AprEntry[]> {
  const all = await fetchDefiLlama()

  // Sort by APR descending, with TVL as tiebreaker
  all.sort((a, b) => b.apr - a.apr || b.tvl - a.tvl)
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
    if (cache) {
      return NextResponse.json(cache.data, { headers: { 'X-Cache': 'STALE' } })
    }
    return NextResponse.json([], { status: 502 })
  }
}

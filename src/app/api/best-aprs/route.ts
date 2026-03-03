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
  'DOLA', 'GUSD', 'SUSD', 'USDP', 'PYUSD', 'FDUSD', 'USDG',
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

    // Debug: log Velodrome pools specifically (even filtered ones)
    const veloInk = inkPools.filter((p: any) =>
      (p.project ?? '').toLowerCase().includes('velodrome')
    )
    console.log(`[best-aprs] DefiLlama Velodrome on Ink: ${veloInk.length} pools`)
    for (const v of veloInk.slice(0, 5)) {
      console.log(`  → ${v.symbol}: apy=${v.apy}, apyBase=${v.apyBase}, apyReward=${v.apyReward}, tvl=$${v.tvlUsd}, exposure=${v.exposure}`)
    }

    for (const p of inkPools) {
      const project = p.project ?? ''
      const symbol  = p.symbol ?? ''
      const apy     = p.apy ?? 0         // Total APY (base + reward)
      const apyBase = p.apyBase ?? 0     // Base APY from fees
      const tvl     = p.tvlUsd ?? 0
      const isVelodrome = project.toLowerCase().includes('velodrome')

      // Skip tiny pools — but use lower threshold for Velodrome (Ink is new chain)
      const minTvl = isVelodrome ? 0 : 100
      if (tvl < minTvl) continue

      // Skip zero APY (but allow Velodrome with tvl > 0 — might still be useful)
      if (apy <= 0 && !isVelodrome) continue

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

// ─── DexScreener API for Velodrome on Ink ─────────────────────────────────────
// DexScreener indexes Velodrome pools on Ink but does NOT provide APR data.
// We use it ONLY for pool discovery (tokens, TVL). Real APRs (with VELO
// emissions) come from DefiLlama when available. Pools without DefiLlama
// APR data are shown with TVL info so users can check the real APR on
// velodrome.finance directly.
const INK_TOKENS = [
  '0x4200000000000000000000000000000000000006', // WETH
  '0xF1815bd50670a7d54d3B88daeddea88960E8e8a9', // USDC.e
  '0x0200C29006150606B650577BBE7B6248F58470c1', // USDT0
]

const VELO_URL = 'https://velodrome.finance/liquidity?chain=57073'

async function fetchDexScreenerVelodrome(): Promise<AprEntry[]> {
  const out: AprEntry[] = []
  const seen = new Set<string>() // dedup by pairAddress

  try {
    // Fetch pairs for each known Ink token in parallel
    const fetches = INK_TOKENS.map(async (tokenAddr) => {
      try {
        const res = await fetch(
          `https://api.dexscreener.com/token-pairs/v1/ink/${tokenAddr}`,
          { signal: AbortSignal.timeout(10_000) }
        )
        if (!res.ok) return []
        const pairs: any[] = await res.json()
        return Array.isArray(pairs) ? pairs : []
      } catch {
        return []
      }
    })

    const results = await Promise.all(fetches)
    const allPairs = results.flat()

    console.log(`[best-aprs] DexScreener: ${allPairs.length} total Ink pairs found`)

    for (const p of allPairs) {
      // Only Velodrome pairs
      const dexId = (p.dexId ?? '').toLowerCase()
      if (!dexId.includes('velodrome')) continue

      const pairAddr = p.pairAddress ?? ''
      if (seen.has(pairAddr)) continue
      seen.add(pairAddr)

      const base  = p.baseToken?.symbol ?? ''
      const quote = p.quoteToken?.symbol ?? ''
      if (!base || !quote) continue

      const liqUsd = p.liquidity?.usd ?? 0

      // Skip tiny pools
      if (liqUsd < 50) continue

      // Determine if stable pool
      const labels = (p.labels ?? []).map((l: string) => l.toLowerCase())
      const pairIsStable = labels.includes('stable') || allStable([base, quote])

      const tokens = [base, quote]
      const label  = `${base}-${quote}${pairIsStable ? ' (stable)' : ''}`

      // NOTE: We do NOT estimate APR from DexScreener data.
      // DexScreener only has volume/liquidity, not VELO gauge emissions
      // which make up 90%+ of the real APR on Velodrome.
      // APR will be filled from DefiLlama in the merge step if available,
      // otherwise it stays 0 (user should check velodrome.finance).
      out.push({
        protocol: 'Velodrome',
        logo:     'https://icons.llamao.fi/icons/protocols/velodrome-v2?w=48&h=48',
        url:      VELO_URL,
        tokens,
        label,
        apr:      0,
        tvl:      liqUsd,
        type:     'pool',
        isStable: pairIsStable,
      })
    }

    console.log(`[best-aprs] DexScreener: ${out.length} Velodrome pools on Ink after filtering`)
  } catch (e) {
    console.error('[best-aprs] DexScreener error:', e)
  }
  return out
}

// ─── Dedup key helper ─────────────────────────────────────────────────────────
// Normalize protocol names for matching (all Velodrome variants → "velodrome")
function dedupeKey(tokens: string[], protocol: string): string {
  const normTokens = [...tokens].map(t => t.toUpperCase()).sort().join('-')
  let normProto = protocol.toLowerCase()
  // Normalize all Velodrome variants
  if (normProto.includes('velodrome') || normProto.includes('aerodrome')) {
    normProto = 'velodrome'
  }
  return `${normTokens}:${normProto}`
}

// ─── Main fetch function ──────────────────────────────────────────────────────
async function fetchAllAprs(): Promise<AprEntry[]> {
  // Fetch from both sources in parallel
  const [defiLlama, dexScreener] = await Promise.all([
    fetchDefiLlama(),
    fetchDexScreenerVelodrome(),
  ])

  // DefiLlama has REAL APRs (fees + emissions), always preferred
  const all = [...defiLlama]
  const existingKeys = new Set(all.map(e => dedupeKey(e.tokens, e.protocol)))

  // Build a lookup of DefiLlama APRs by token pair (for enriching DexScreener)
  const llamaAprByTokens = new Map<string, { apr: number; tvl: number }>()
  for (const e of defiLlama) {
    if (e.protocol.toLowerCase().includes('velodrome')) {
      const tokenKey = [...e.tokens].map(t => t.toUpperCase()).sort().join('-')
      const existing = llamaAprByTokens.get(tokenKey)
      // Keep the highest APR entry for each token pair
      if (!existing || e.apr > existing.apr) {
        llamaAprByTokens.set(tokenKey, { apr: e.apr, tvl: e.tvl })
      }
    }
  }

  let enriched = 0
  let added = 0

  for (const v of dexScreener) {
    const key = dedupeKey(v.tokens, v.protocol)
    if (existingKeys.has(key)) continue // DefiLlama already has this pool

    // Try to enrich DexScreener pool with DefiLlama APR data
    const tokenKey = [...v.tokens].map(t => t.toUpperCase()).sort().join('-')
    const llamaData = llamaAprByTokens.get(tokenKey)
    if (llamaData && llamaData.apr > 0) {
      v.apr = llamaData.apr
      enriched++
    }

    // Only add pools that have APR data (from DefiLlama enrichment)
    // or that have significant TVL (> $1000) even without APR
    if (v.apr > 0 || v.tvl >= 1000) {
      all.push(v)
      existingKeys.add(key)
      added++
    }
  }

  console.log(`[best-aprs] Total: ${all.length} entries (${defiLlama.length} DefiLlama + ${added} DexScreener, ${enriched} enriched with DefiLlama APR)`)

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

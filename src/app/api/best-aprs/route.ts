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

// ─── GeckoTerminal API for Velodrome on Ink ──────────────────────────────────
// GeckoTerminal (by CoinGecko) indexes Velodrome pools on Ink with dedicated
// DEX endpoints. We estimate fee APR from 24h volume and liquidity.
// Note: this is FEE APR only and does not include VELO gauge emissions.
// Real APR on velodrome.finance may be higher.
// If DefiLlama has data (which includes emissions), it takes priority.

const VELO_URL = 'https://velodrome.finance/liquidity?chain=57073'
const GECKO_BASE = 'https://api.geckoterminal.com/api/v2'

// GeckoTerminal DEX IDs for Velodrome on Ink
const VELO_DEX_IDS = [
  'velodrome-finance-v2-ink',   // V2 AMM pools (stable + volatile)
  'velodrome-slipstream-ink',   // V3 Slipstream (concentrated liquidity)
]

// Velodrome fee rates by pool type
const VELO_FEE_STABLE  = 0.0001  // 0.01% for stable pools
const VELO_FEE_DEFAULT = 0.003   // 0.3% for volatile/CL pools

async function fetchGeckoTerminalVelodrome(): Promise<AprEntry[]> {
  const out: AprEntry[] = []
  const seen = new Set<string>() // dedup by pool address

  try {
    // Fetch pools from each Velodrome DEX on Ink in parallel
    const fetches = VELO_DEX_IDS.map(async (dexId) => {
      try {
        const url = `${GECKO_BASE}/networks/ink/dexes/${dexId}/pools?page=1&sort=h24_volume_usd_desc&include=base_token,quote_token`
        const res = await fetch(url, {
          signal: AbortSignal.timeout(10_000),
          headers: { 'Accept': 'application/json' },
        })
        if (!res.ok) {
          console.log(`[best-aprs] GeckoTerminal ${dexId}: HTTP ${res.status}`)
          return { dexId, pools: [], included: [] }
        }
        const json = await res.json()
        return {
          dexId,
          pools: json.data ?? [],
          included: json.included ?? [],
        }
      } catch (e) {
        console.log(`[best-aprs] GeckoTerminal ${dexId}: fetch error`, e)
        return { dexId, pools: [], included: [] }
      }
    })

    const results = await Promise.all(fetches)

    // Build token lookup from included resources
    const tokenSymbols = new Map<string, string>()
    for (const { included } of results) {
      for (const inc of included) {
        if (inc.type === 'token' && inc.attributes?.symbol) {
          tokenSymbols.set(inc.id, inc.attributes.symbol)
        }
      }
    }

    let totalPools = 0
    for (const { dexId, pools } of results) {
      const isSlipstream = dexId.includes('slipstream')

      for (const pool of pools) {
        totalPools++
        const addr = pool.attributes?.address ?? pool.id ?? ''
        if (seen.has(addr)) continue
        seen.add(addr)

        const attrs = pool.attributes ?? {}
        const poolName = attrs.name ?? ''

        // Get token symbols from included data or parse from pool name
        const baseTokenId = pool.relationships?.base_token?.data?.id ?? ''
        const quoteTokenId = pool.relationships?.quote_token?.data?.id ?? ''
        let base = tokenSymbols.get(baseTokenId) ?? ''
        let quote = tokenSymbols.get(quoteTokenId) ?? ''

        // Fallback: parse from pool name like "WETH / USDC.e"
        if ((!base || !quote) && poolName.includes('/')) {
          const parts = poolName.split('/').map((s: string) => s.trim())
          if (!base && parts[0]) base = parts[0]
          if (!quote && parts[1]) quote = parts[1]
        }

        if (!base || !quote) continue

        // Get volume and liquidity
        const reserveUsd = parseFloat(attrs.reserve_in_usd ?? '0')
        const vol24h     = parseFloat(attrs.volume_usd?.h24 ?? '0')

        // Skip tiny pools
        if (reserveUsd < 50) continue

        // Determine if stable pool
        const pairIsStable = poolName.toLowerCase().includes('stable') ||
                             allStable([base, quote])

        // Estimate fee APR from 24h volume
        // Slipstream (CL) pools typically have higher fee tiers
        const feeRate = pairIsStable ? VELO_FEE_STABLE : VELO_FEE_DEFAULT
        const feeApr = reserveUsd > 0 ? (vol24h * feeRate * 365 / reserveUsd) * 100 : 0

        // Cap unrealistic APR
        const cappedApr = Math.min(feeApr, 50_000)

        const tokens = [base, quote]
        const suffix = pairIsStable ? ' (stable)' : isSlipstream ? ' (CL)' : ''
        const label  = `${base}-${quote}${suffix}`

        out.push({
          protocol: isSlipstream ? 'Velodrome V3' : 'Velodrome',
          logo:     'https://icons.llamao.fi/icons/protocols/velodrome-v2?w=48&h=48',
          url:      VELO_URL,
          tokens,
          label,
          apr:      Math.round(cappedApr * 100) / 100,
          tvl:      reserveUsd,
          type:     'pool',
          isStable: pairIsStable,
        })
      }
    }

    console.log(`[best-aprs] GeckoTerminal: ${totalPools} total Velodrome pools on Ink, ${out.length} after filtering`)
  } catch (e) {
    console.error('[best-aprs] GeckoTerminal error:', e)
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
  const [defiLlama, geckoTerminal] = await Promise.all([
    fetchDefiLlama(),
    fetchGeckoTerminalVelodrome(),
  ])

  // DefiLlama has REAL APRs (fees + emissions), always preferred
  const all = [...defiLlama]
  const existingKeys = new Set(all.map(e => dedupeKey(e.tokens, e.protocol)))

  // Build a lookup of DefiLlama APRs by token pair (for enriching GeckoTerminal)
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

  for (const v of geckoTerminal) {
    const key = dedupeKey(v.tokens, v.protocol)
    if (existingKeys.has(key)) continue // DefiLlama already has this pool with real APR

    // Try to enrich GeckoTerminal pool with DefiLlama APR data (includes emissions)
    const tokenKey = [...v.tokens].map(t => t.toUpperCase()).sort().join('-')
    const llamaData = llamaAprByTokens.get(tokenKey)
    if (llamaData && llamaData.apr > v.apr) {
      v.apr = llamaData.apr
      enriched++
    }

    // Add pool if it has any APR or significant TVL
    if (v.apr > 0 || v.tvl >= 1000) {
      all.push(v)
      existingKeys.add(key)
      added++
    }
  }

  console.log(`[best-aprs] Total: ${all.length} entries (${defiLlama.length} DefiLlama + ${added} GeckoTerminal, ${enriched} enriched with DefiLlama APR)`)

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

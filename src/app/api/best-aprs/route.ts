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

// ─── LpSugar on-chain API for Velodrome on Ink ───────────────────────────────
// LpSugar is Velodrome's official on-chain data contract. It returns pool data
// including the REAL APR (fees + VELO gauge emissions), not just fee APR.
// We call it via eth_call RPC on the Ink chain.
// Fallback: GeckoTerminal fee-only APR if Sugar call fails.
//
// Contract: 0x46e07c9b4016f8E5c3cD0b2fd20147A4d0972120 (Ink chain 57073)
// Source: https://github.com/velodrome-finance/sugar
// ABI fetched from Blockscout at runtime and cached.

const LP_SUGAR     = '0x46e07c9b4016f8E5c3cD0b2fd20147A4d0972120'
const INK_RPC      = 'https://rpc-gel.inkonchain.com'
const INK_RPC_ALT  = 'https://ink.drpc.org'
const BLOCKSCOUT   = 'https://explorer.inkonchain.com'
const VELO_URL     = 'https://velodrome.finance/liquidity?chain=57073'
const GECKO_BASE   = 'https://api.geckoterminal.com/api/v2'

// GeckoTerminal DEX IDs for Velodrome on Ink (used for TVL data)
const VELO_DEX_IDS = [
  'velodrome-finance-v2-ink',
  'velodrome-slipstream-ink',
]

// ─── ABI cache (fetched from Blockscout once) ────────────────────────────────
let sugarAbiCache: any[] | null = null

async function getSugarAbi(): Promise<any[] | null> {
  if (sugarAbiCache) return sugarAbiCache
  try {
    const res = await fetch(
      `${BLOCKSCOUT}/api?module=contract&action=getabi&address=${LP_SUGAR}`,
      { signal: AbortSignal.timeout(8_000) }
    )
    const json = await res.json()
    if (json.status === '1' && json.result) {
      sugarAbiCache = JSON.parse(json.result)
      console.log(`[best-aprs] Sugar ABI cached (${sugarAbiCache!.length} entries)`)
      return sugarAbiCache
    }
    console.log(`[best-aprs] Blockscout ABI status: ${json.status}, message: ${json.message}`)
  } catch (e) {
    console.error('[best-aprs] Failed to fetch Sugar ABI from Blockscout:', e)
  }
  return null
}

// ─── LpSugar RPC call ────────────────────────────────────────────────────────
// Calls LpSugar.all(limit, offset) via eth_call and decodes using ethers.js
async function fetchLpSugar(): Promise<AprEntry[]> {
  const out: AprEntry[] = []

  // Step 1: Get ABI from Blockscout
  const abi = await getSugarAbi()
  if (!abi) throw new Error('No Sugar ABI available from Blockscout')

  // Step 2: Dynamic import ethers.js for ABI encoding/decoding
  // Requires: npm install ethers
  let Interface: any
  try {
    const ethers = await import('ethers')
    Interface = ethers.Interface
  } catch {
    throw new Error('ethers package not installed — run: npm install ethers')
  }

  const iface = new Interface(abi)

  // Step 3: Encode the function call: all(200, 0)
  // 200 limit should cover all pools on Ink (currently ~20-50)
  const calldata = iface.encodeFunctionData('all', [200, 0])

  // Step 4: Make eth_call to Ink RPC (with fallback RPC)
  let rpcResult: string | null = null
  for (const rpc of [INK_RPC, INK_RPC_ALT]) {
    try {
      const res = await fetch(rpc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_call',
          params: [{ to: LP_SUGAR, data: calldata }, 'latest'],
        }),
        signal: AbortSignal.timeout(30_000),
      })
      const json = await res.json()
      if (json.error) {
        console.log(`[best-aprs] Sugar RPC error (${rpc}): ${json.error.message}`)
        continue
      }
      rpcResult = json.result
      break
    } catch (e) {
      console.log(`[best-aprs] Sugar RPC timeout/error (${rpc}):`, e)
    }
  }

  if (!rpcResult) throw new Error('All RPC endpoints failed for Sugar call')

  // Step 5: Decode the response
  const decoded = iface.decodeFunctionResult('all', rpcResult)
  const pools = decoded[0] // Array of Lp structs

  console.log(`[best-aprs] LpSugar: ${pools.length} pools returned from contract`)

  // Step 6: Map to AprEntry[]
  for (const p of pools) {
    try {
      const symbol = String(p.symbol ?? '')
      if (!symbol) continue

      // Parse token names from pool symbol
      // Formats: "vAMM-WETH/USDC.e" (V2 volatile), "sAMM-USDC.e/USDT0" (V2 stable),
      //          "CL200-WETH/USDC.e" (Slipstream CL with tickSpacing=200)
      const match = symbol.match(/^(?:vAMM|sAMM|CL\d+)-(.+)\/(.+)$/)
      if (!match) {
        // Some pools might have different naming, try splitting by /
        const slashIdx = symbol.indexOf('/')
        if (slashIdx === -1) continue
        // Skip prefix before first dash
        const dashIdx = symbol.indexOf('-')
        const base = dashIdx >= 0 ? symbol.slice(dashIdx + 1, slashIdx) : symbol.slice(0, slashIdx)
        const quote = symbol.slice(slashIdx + 1)
        if (!base || !quote) continue
        // Process below with these values
        processPool(p, symbol, base.trim(), quote.trim(), out)
        continue
      }

      const [, base, quote] = match
      processPool(p, symbol, base.trim(), quote.trim(), out)
    } catch (e) {
      // Skip individual pool errors
      console.log(`[best-aprs] Sugar pool parse error:`, e)
    }
  }

  console.log(`[best-aprs] LpSugar: ${out.length} pools after filtering`)

  // Log top pools for debugging
  const sorted = [...out].sort((a, b) => b.apr - a.apr)
  for (const s of sorted.slice(0, 5)) {
    console.log(`  → ${s.label}: APR=${s.apr}%`)
  }

  return out
}

// Helper: process a single Sugar pool into an AprEntry
function processPool(
  p: any, symbol: string, base: string, quote: string, out: AprEntry[]
) {
  const tokens = [base, quote]

  // Pool type detection from symbol prefix
  const isCL     = symbol.startsWith('CL')
  const isStablePool = symbol.startsWith('sAMM') || allStable(tokens)

  // APR from the Sugar contract
  // The contract returns APR as a uint256. Scaling depends on the Sugar version:
  // - Most common: percentage with 18 decimals (245.3% → 245300000000000000000)
  // - Or: basis points (245.3% → 24530)
  // We auto-detect based on magnitude.
  const aprRaw = BigInt(p.apr?.toString() ?? '0')
  let apr: number

  if (aprRaw === 0n) {
    apr = 0
  } else if (aprRaw > 10n ** 15n) {
    // Likely 18-decimal format: divide by 10^18
    apr = Number(aprRaw) / 1e18
  } else if (aprRaw > 100_000n) {
    // Likely basis points × 100 or similar: divide by 100
    apr = Number(aprRaw) / 100
  } else {
    // Likely direct percentage or basis points
    // If > 10000, treat as basis points
    apr = Number(aprRaw) > 10000 ? Number(aprRaw) / 100 : Number(aprRaw)
  }

  // Cap unrealistic values
  if (apr > 50_000 || apr < 0) return

  // Check if gauge is alive (receiving emissions)
  // Pool is still valid even without gauge (fee revenue), but APR may be 0
  const gaugeAlive = Boolean(p.gauge_alive ?? p.gaugeAlive ?? false)

  const suffix = isStablePool ? ' (stable)' : isCL ? ' (CL)' : ''
  const label  = `${base}-${quote}${suffix}`

  out.push({
    protocol: isCL ? 'Velodrome V3' : 'Velodrome',
    logo:     'https://icons.llamao.fi/icons/protocols/velodrome-v2?w=48&h=48',
    url:      VELO_URL,
    tokens,
    label,
    apr:      Math.round(apr * 100) / 100,
    tvl:      0, // Will be enriched from GeckoTerminal
    type:     'pool',
    isStable: isStablePool,
  })
}

// ─── GeckoTerminal for TVL data and fallback ─────────────────────────────────
// Used for: (1) TVL data to enrich Sugar pools, (2) Fallback if Sugar RPC fails
async function fetchGeckoTerminalVelodrome(): Promise<AprEntry[]> {
  const out: AprEntry[] = []
  const seen = new Set<string>()

  try {
    const fetches = VELO_DEX_IDS.map(async (dexId) => {
      try {
        const url = `${GECKO_BASE}/networks/ink/dexes/${dexId}/pools?page=1&sort=h24_volume_usd_desc&include=base_token,quote_token`
        const res = await fetch(url, {
          signal: AbortSignal.timeout(10_000),
          headers: { 'Accept': 'application/json' },
        })
        if (!res.ok) return { dexId, pools: [], included: [] }
        const json = await res.json()
        return { dexId, pools: json.data ?? [], included: json.included ?? [] }
      } catch {
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

    // Velodrome fee rates for fallback APR estimation
    const VELO_FEE_STABLE  = 0.0001
    const VELO_FEE_DEFAULT = 0.003

    for (const { dexId, pools } of results) {
      const isSlipstream = dexId.includes('slipstream')
      for (const pool of pools) {
        const addr = pool.attributes?.address ?? pool.id ?? ''
        if (seen.has(addr)) continue
        seen.add(addr)

        const attrs = pool.attributes ?? {}
        const poolName = attrs.name ?? ''

        const baseTokenId = pool.relationships?.base_token?.data?.id ?? ''
        const quoteTokenId = pool.relationships?.quote_token?.data?.id ?? ''
        let base = tokenSymbols.get(baseTokenId) ?? ''
        let quote = tokenSymbols.get(quoteTokenId) ?? ''

        if ((!base || !quote) && poolName.includes('/')) {
          const parts = poolName.split('/').map((s: string) => s.trim())
          if (!base && parts[0]) base = parts[0]
          if (!quote && parts[1]) quote = parts[1]
        }
        if (!base || !quote) continue

        const reserveUsd = parseFloat(attrs.reserve_in_usd ?? '0')
        const vol24h     = parseFloat(attrs.volume_usd?.h24 ?? '0')
        if (reserveUsd < 50) continue

        const pairIsStable = poolName.toLowerCase().includes('stable') ||
                             allStable([base, quote])

        // Fee-only APR estimate (used as fallback when Sugar fails)
        const feeRate = pairIsStable ? VELO_FEE_STABLE : VELO_FEE_DEFAULT
        const feeApr = reserveUsd > 0 ? (vol24h * feeRate * 365 / reserveUsd) * 100 : 0

        const tokens = [base, quote]
        const suffix = pairIsStable ? ' (stable)' : isSlipstream ? ' (CL)' : ''

        out.push({
          protocol: isSlipstream ? 'Velodrome V3' : 'Velodrome',
          logo:     'https://icons.llamao.fi/icons/protocols/velodrome-v2?w=48&h=48',
          url:      VELO_URL,
          tokens,
          label:    `${base}-${quote}${suffix}`,
          apr:      Math.round(Math.min(feeApr, 50_000) * 100) / 100,
          tvl:      reserveUsd,
          type:     'pool',
          isStable: pairIsStable,
        })
      }
    }

    console.log(`[best-aprs] GeckoTerminal: ${out.length} Velodrome pools (with TVL data)`)
  } catch (e) {
    console.error('[best-aprs] GeckoTerminal error:', e)
  }
  return out
}

// ─── Combined Velodrome fetcher: Sugar APR + GeckoTerminal TVL ───────────────
async function fetchVelodromeData(): Promise<AprEntry[]> {
  // Fetch Sugar (real APR) and GeckoTerminal (TVL) in parallel
  const [sugarResult, geckoResult] = await Promise.allSettled([
    fetchLpSugar(),
    fetchGeckoTerminalVelodrome(),
  ])

  const sugarPools = sugarResult.status === 'fulfilled' ? sugarResult.value : []
  const geckoPools = geckoResult.status === 'fulfilled' ? geckoResult.value : []

  if (sugarResult.status === 'rejected') {
    console.log(`[best-aprs] LpSugar failed: ${sugarResult.reason}`)
  }

  // If Sugar succeeded → use Sugar APR, enrich with GeckoTerminal TVL
  if (sugarPools.length > 0) {
    // Build TVL lookup from GeckoTerminal by token pair
    const tvlByPair = new Map<string, number>()
    for (const g of geckoPools) {
      const key = [...g.tokens].map(t => t.toUpperCase()).sort().join('-')
      const existing = tvlByPair.get(key) ?? 0
      if (g.tvl > existing) tvlByPair.set(key, g.tvl)
    }

    // Enrich Sugar pools with TVL
    for (const s of sugarPools) {
      const key = [...s.tokens].map(t => t.toUpperCase()).sort().join('-')
      s.tvl = tvlByPair.get(key) ?? 0
    }

    // Also add any GeckoTerminal pools NOT in Sugar (edge cases)
    const sugarKeys = new Set(sugarPools.map(s =>
      [...s.tokens].map(t => t.toUpperCase()).sort().join('-')
    ))
    for (const g of geckoPools) {
      const key = [...g.tokens].map(t => t.toUpperCase()).sort().join('-')
      if (!sugarKeys.has(key) && g.tvl >= 500) {
        sugarPools.push(g)
      }
    }

    console.log(`[best-aprs] Velodrome: ${sugarPools.length} pools (Sugar APR + GeckoTerminal TVL)`)
    return sugarPools
  }

  // Fallback: Sugar failed, use GeckoTerminal fee-only APR
  console.log(`[best-aprs] Velodrome: falling back to GeckoTerminal (fee-only APR)`)
  return geckoPools
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
  // Fetch from all sources in parallel:
  // - DefiLlama: All Ink protocols (Curve, Aave, Morpho, Tydro, etc.)
  // - Velodrome: Sugar on-chain APR + GeckoTerminal TVL (with fallback)
  const [defiLlama, velodrome] = await Promise.all([
    fetchDefiLlama(),
    fetchVelodromeData(),
  ])

  // DefiLlama has data for many protocols including Velodrome
  // Velodrome data from Sugar has the most accurate APR (includes emissions)
  const all: AprEntry[] = []
  const existingKeys = new Set<string>()

  // 1. Add Velodrome data first (Sugar has the best APR data)
  for (const v of velodrome) {
    if (v.apr > 0 || v.tvl >= 500) {
      const key = dedupeKey(v.tokens, v.protocol)
      all.push(v)
      existingKeys.add(key)
    }
  }

  // 2. Add DefiLlama data, skipping Velodrome pools already covered
  for (const d of defiLlama) {
    const key = dedupeKey(d.tokens, d.protocol)
    if (existingKeys.has(key)) {
      // If DefiLlama has higher APR for this pool, update (shouldn't happen with Sugar)
      const existing = all.find(e => dedupeKey(e.tokens, e.protocol) === key)
      if (existing && d.apr > existing.apr && d.apr > 0) {
        existing.apr = d.apr
        if (d.tvl > existing.tvl) existing.tvl = d.tvl
      }
      continue
    }
    all.push(d)
    existingKeys.add(key)
  }

  // 3. Enrich any Velodrome pools that have 0 TVL with DefiLlama TVL
  const llamaTvlByTokens = new Map<string, number>()
  for (const d of defiLlama) {
    if (d.protocol.toLowerCase().includes('velodrome') && d.tvl > 0) {
      const tokenKey = [...d.tokens].map(t => t.toUpperCase()).sort().join('-')
      const existing = llamaTvlByTokens.get(tokenKey) ?? 0
      if (d.tvl > existing) llamaTvlByTokens.set(tokenKey, d.tvl)
    }
  }
  for (const e of all) {
    if (e.tvl === 0 && e.protocol.toLowerCase().includes('velodrome')) {
      const tokenKey = [...e.tokens].map(t => t.toUpperCase()).sort().join('-')
      e.tvl = llamaTvlByTokens.get(tokenKey) ?? 0
    }
  }

  console.log(`[best-aprs] Total: ${all.length} entries (${velodrome.length} Velodrome + ${defiLlama.length} DefiLlama, merged)`)

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

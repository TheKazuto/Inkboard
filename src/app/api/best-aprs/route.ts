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
// We use Blockscout's query-read-method API to call the contract and get
// decoded results — no ethers/viem dependency needed.
//
// Contract: 0x46e07c9b4016f8E5c3cD0b2fd20147A4d0972120 (Ink chain 57073)
// Source: https://github.com/velodrome-finance/sugar

const LP_SUGAR     = '0x46e07c9b4016f8E5c3cD0b2fd20147A4d0972120'
const BLOCKSCOUT   = 'https://explorer.inkonchain.com'
const VELO_URL     = 'https://velodrome.finance/liquidity?chain=57073'
const GECKO_BASE   = 'https://api.geckoterminal.com/api/v2'

// GeckoTerminal DEX IDs for Velodrome on Ink (used for TVL data)
const VELO_DEX_IDS = [
  'velodrome-finance-v2-ink',
  'velodrome-slipstream-ink',
]

// ─── Blockscout read-contract proxy ──────────────────────────────────────────
// Blockscout v2 API can call view functions and return decoded results.
// Step 1: GET /api/v2/smart-contracts/{addr}/methods-read → find method_id
// Step 2: POST /api/v2/smart-contracts/{addr}/query-read-method → call & decode

// Cache the method_id for LpSugar.all()
let sugarAllMethodId: string | null = null

async function getSugarMethodId(): Promise<string | null> {
  if (sugarAllMethodId) return sugarAllMethodId
  try {
    const res = await fetch(
      `${BLOCKSCOUT}/api/v2/smart-contracts/${LP_SUGAR}/methods-read`,
      { signal: AbortSignal.timeout(8_000) }
    )
    if (!res.ok) {
      console.log(`[best-aprs] Blockscout methods-read: HTTP ${res.status}`)
      return null
    }
    const methods: any[] = await res.json()
    // Find the "all" method that takes (uint256, uint256)
    const allMethod = methods.find((m: any) =>
      m.name === 'all' &&
      m.inputs?.length === 2 &&
      m.inputs[0]?.type === 'uint256' &&
      m.inputs[1]?.type === 'uint256'
    )
    if (allMethod?.method_id) {
      sugarAllMethodId = allMethod.method_id
      console.log(`[best-aprs] Sugar all() method_id: ${sugarAllMethodId}`)
      return sugarAllMethodId
    }
    console.log(`[best-aprs] Sugar all() not found in ${methods.length} methods`)
    // Log available methods for debugging
    for (const m of methods.slice(0, 10)) {
      console.log(`  method: ${m.name}(${(m.inputs ?? []).map((i: any) => i.type).join(',')}) → ${m.method_id}`)
    }
  } catch (e) {
    console.error('[best-aprs] Blockscout methods-read error:', e)
  }
  return null
}

// ─── LpSugar call via Blockscout ─────────────────────────────────────────────
async function fetchLpSugar(): Promise<AprEntry[]> {
  const out: AprEntry[] = []

  // Step 1: Get method_id for all(uint256, uint256)
  const methodId = await getSugarMethodId()
  if (!methodId) throw new Error('Could not find Sugar all() method_id from Blockscout')

  // Step 2: Call the contract via Blockscout's query-read-method
  const res = await fetch(
    `${BLOCKSCOUT}/api/v2/smart-contracts/${LP_SUGAR}/query-read-method`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        args: ['200', '0'],       // all(limit=200, offset=0)
        method_id: methodId,
        contract_type: 'regular',
      }),
      signal: AbortSignal.timeout(60_000), // Sugar call can be slow
    }
  )

  if (!res.ok) {
    throw new Error(`Blockscout query-read-method: HTTP ${res.status}`)
  }

  const data = await res.json()

  // Step 3: Parse the Blockscout response
  // Blockscout returns decoded results in data.result.output or data.result
  // The format for tuple[] is typically an array of arrays
  const output = data?.result?.output ?? data?.result ?? data
  if (!output) throw new Error('Empty response from Blockscout query-read-method')

  // Debug: log raw structure
  console.log(`[best-aprs] Sugar Blockscout response type: ${typeof output}, isArray: ${Array.isArray(output)}`)
  if (Array.isArray(output) && output.length > 0) {
    console.log(`[best-aprs] Sugar first item keys:`, typeof output[0] === 'object' ? Object.keys(output[0]).slice(0, 10).join(', ') : typeof output[0])
  }

  // Parse pools from response
  // Blockscout may return as:
  // (a) Array of objects with named fields { symbol, apr, gauge_alive, ... }
  // (b) Array of tuples where we match by position to Lp struct fields
  // (c) Single output item wrapping the array: [{ type: "tuple[]", value: [...] }]
  let pools: any[] = []

  if (Array.isArray(output)) {
    // Check if it's wrapped in output format: [{type: "tuple[]", value: [...]}]
    if (output.length > 0 && output[0]?.type && output[0]?.value) {
      pools = Array.isArray(output[0].value) ? output[0].value : []
    } else {
      pools = output
    }
  } else if (output?.output && Array.isArray(output.output)) {
    if (output.output[0]?.value) {
      pools = Array.isArray(output.output[0].value) ? output.output[0].value : []
    } else {
      pools = output.output
    }
  }

  console.log(`[best-aprs] LpSugar: ${pools.length} pools from Blockscout`)

  if (pools.length === 0) {
    // Log the raw response for debugging
    const preview = JSON.stringify(data).slice(0, 500)
    console.log(`[best-aprs] Sugar raw response preview: ${preview}`)
    throw new Error('Sugar returned 0 pools — response format may have changed')
  }

  // Step 4: Map each pool to AprEntry
  // Lp struct fields from Sugar README (in order):
  // lp, symbol, decimals, stable, total_supply, token0, reserve0, token1, reserve1,
  // gauge, gauge_liquidity, gauge_alive, fee, bribe, factory,
  // emissions, emissions_token, pool_fee, unstaked_fee,
  // token0_fees, token1_fees, nfpm, alm, apr, ...
  for (const p of pools) {
    try {
      // Handle both object (named fields) and array (positional) formats
      let symbol: string
      let apr: any
      let gaugeAlive: boolean
      let stable: boolean

      if (Array.isArray(p)) {
        // Positional: p[1]=symbol, p[3]=stable, p[12]=gauge_alive, p[23]=apr (approximate)
        symbol     = String(p[1] ?? '')
        stable     = Boolean(p[3])
        gaugeAlive = Boolean(p[12])
        apr        = p[23] // APR field position — may need adjustment
      } else if (typeof p === 'object' && p !== null) {
        // Named fields
        symbol     = String(p.symbol ?? p[1] ?? '')
        stable     = Boolean(p.stable ?? p[3] ?? false)
        gaugeAlive = Boolean(p.gauge_alive ?? p.gaugeAlive ?? p[12] ?? false)
        apr        = p.apr ?? p[23] ?? 0
      } else {
        continue
      }

      if (!symbol) continue

      // Parse token names from pool symbol
      // Formats: "vAMM-WETH/USDC.e", "sAMM-USDC.e/USDT0", "CL200-WETH/USDC.e"
      const match = symbol.match(/^(?:vAMM|sAMM|CL\d+)-(.+)\/(.+)$/)
      let base: string, quote: string
      if (match) {
        base = match[1].trim()
        quote = match[2].trim()
      } else {
        // Fallback: split by /
        const slashIdx = symbol.indexOf('/')
        if (slashIdx === -1) continue
        const dashIdx = symbol.indexOf('-')
        base = (dashIdx >= 0 ? symbol.slice(dashIdx + 1, slashIdx) : symbol.slice(0, slashIdx)).trim()
        quote = symbol.slice(slashIdx + 1).trim()
      }
      if (!base || !quote) continue

      const isCL = symbol.startsWith('CL')
      const isStablePool = symbol.startsWith('sAMM') || stable || allStable([base, quote])

      // Parse APR value — auto-detect scaling
      const aprNum = parseAprValue(apr)
      if (aprNum < 0 || aprNum > 50_000) continue

      const suffix = isStablePool ? ' (stable)' : isCL ? ' (CL)' : ''
      const label  = `${base}-${quote}${suffix}`

      out.push({
        protocol: isCL ? 'Velodrome V3' : 'Velodrome',
        logo:     'https://icons.llamao.fi/icons/protocols/velodrome-v2?w=48&h=48',
        url:      VELO_URL,
        tokens:   [base, quote],
        label,
        apr:      Math.round(aprNum * 100) / 100,
        tvl:      0, // Will be enriched from GeckoTerminal
        type:     'pool',
        isStable: isStablePool,
      })
    } catch (e) {
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

// Parse APR from Sugar contract — handles different scaling formats
function parseAprValue(raw: any): number {
  if (raw === null || raw === undefined) return 0

  // If it's a string that looks like a big number (18 decimals)
  const str = String(raw)
  try {
    const n = BigInt(str)
    if (n === 0n) return 0
    if (n > 10n ** 15n) {
      // 18-decimal format: 245.3% → 245300000000000000000
      return Number(n) / 1e18
    }
    if (n > 100_000n) {
      // Basis points × 100 or similar
      return Number(n) / 100
    }
    // Direct percentage or basis points
    return Number(n) > 10000 ? Number(n) / 100 : Number(n)
  } catch {
    // Not a BigInt — try as float
    const f = parseFloat(str)
    if (isNaN(f)) return 0
    // If very large, likely 18-decimal
    if (f > 1e15) return f / 1e18
    if (f > 100_000) return f / 100
    return f > 10000 ? f / 100 : f
  }
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

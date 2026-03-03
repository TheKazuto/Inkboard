import { NextResponse } from 'next/server'
import { encodeFunctionData, decodeFunctionResult, type Abi } from 'viem'

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

// ─── Direct Gauge RPC calls for Velodrome emissions on Ink ──────────────────
// Instead of Sugar (complex Vyper view that reverts), we call individual
// contracts: Voter.gauges(pool) → gauge address, Gauge.rewardRate() → emissions/sec.
// These are simple single-slot reads that always work.
//
// Voter (SuperchainLeafVoter on Ink): 0x97cDBCe21B6fd0585d29E539B1B99dAd328a1123
// Source: https://github.com/velodrome-finance/indexer/blob/main/config.yaml

const VOTER_INK    = '0x97cDBCe21B6fd0585d29E539B1B99dAd328a1123' as const
const INK_RPC      = 'https://rpc-gel.inkonchain.com'
const INK_RPC_ALT  = 'https://ink.drpc.org'
const VELO_URL     = 'https://velodrome.finance/liquidity?chain=57073'
const GECKO_BASE   = 'https://api.geckoterminal.com/api/v2'
const SECONDS_YEAR = 86400 * 365

// GeckoTerminal DEX IDs for Velodrome on Ink
const VELO_DEX_IDS = [
  'velodrome-finance-v2-ink',
  'velodrome-slipstream-ink',
]

// xVELO on Ink — the emissions token
const XVELO_INK = '0x7f9AdFbd38b669F03d1d11000Bc76b9AaEA28A81'

// ABI for individual contract calls (minimal — no complex structs)
const VOTER_ABI: Abi = [{
  name: 'gauges',
  type: 'function',
  stateMutability: 'view',
  inputs:  [{ name: '_pool', type: 'address' }],
  outputs: [{ name: '', type: 'address' }],
}, {
  name: 'isAlive',
  type: 'function',
  stateMutability: 'view',
  inputs:  [{ name: '_gauge', type: 'address' }],
  outputs: [{ name: '', type: 'bool' }],
}]

const GAUGE_ABI: Abi = [{
  name: 'rewardRate',
  type: 'function',
  stateMutability: 'view',
  inputs:  [],
  outputs: [{ name: '', type: 'uint256' }],
}]

const ZERO_ADDR = '0x0000000000000000000000000000000000000000'

// ─── JSON-RPC batch helper ──────────────────────────────────────────────────
async function rpcBatch(
  calls: { to: string; data: `0x${string}` }[],
): Promise<(`0x${string}` | null)[]> {
  if (calls.length === 0) return []

  const batch = calls.map((c, i) => ({
    jsonrpc: '2.0',
    id: i + 1,
    method: 'eth_call',
    params: [{ to: c.to, data: c.data }, 'latest'],
  }))

  for (const rpc of [INK_RPC, INK_RPC_ALT]) {
    try {
      const res = await fetch(rpc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(batch),
        signal: AbortSignal.timeout(15_000),
      })
      const results = await res.json()

      // Handle non-batch response (some RPCs don't support batching)
      if (!Array.isArray(results)) {
        console.log(`[best-aprs] RPC ${rpc} returned non-batch response, falling back to sequential`)
        return sequentialRpc(calls, rpc)
      }

      // Sort by id to match input order
      const sorted = results.sort((a: any, b: any) => a.id - b.id)
      const out = sorted.map((r: any) => {
        if (r.error || !r.result || r.result === '0x') return null
        return r.result as `0x${string}`
      })

      console.log(`[best-aprs] RPC batch OK via ${rpc}: ${out.filter(Boolean).length}/${calls.length} success`)
      return out
    } catch (e) {
      console.log(`[best-aprs] RPC batch fail (${rpc}):`, e)
    }
  }

  return calls.map(() => null)
}

async function sequentialRpc(
  calls: { to: string; data: `0x${string}` }[],
  rpc: string,
): Promise<(`0x${string}` | null)[]> {
  const out: (`0x${string}` | null)[] = []
  for (const c of calls) {
    try {
      const res = await fetch(rpc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1,
          method: 'eth_call',
          params: [{ to: c.to, data: c.data }, 'latest'],
        }),
        signal: AbortSignal.timeout(8_000),
      })
      const json = await res.json()
      if (json.error || !json.result || json.result === '0x') {
        out.push(null)
      } else {
        out.push(json.result as `0x${string}`)
      }
    } catch {
      out.push(null)
    }
  }
  return out
}

// ─── Fetch gauge emissions for pool addresses ───────────────────────────────
async function fetchGaugeEmissions(
  poolAddresses: string[],
): Promise<Map<string, number>> {
  // Map: poolAddress (lowercase) → rewardRate (VELO/sec, float, 18 decimals already divided)
  const emissions = new Map<string, number>()
  if (poolAddresses.length === 0) return emissions

  // Step 1: Call Voter.gauges(pool) for each pool to get gauge addresses
  const gaugesCalls = poolAddresses.map(pool => ({
    to: VOTER_INK,
    data: encodeFunctionData({ abi: VOTER_ABI, functionName: 'gauges', args: [pool as `0x${string}`] }),
  }))

  console.log(`[best-aprs] Fetching gauges for ${poolAddresses.length} pools...`)
  const gaugeResults = await rpcBatch(gaugesCalls)

  // Parse gauge addresses
  const gaugeMap = new Map<string, string>() // poolAddr → gaugeAddr
  const gaugeAddrs: string[] = []
  for (let i = 0; i < poolAddresses.length; i++) {
    const raw = gaugeResults[i]
    if (!raw) continue
    try {
      const decoded = decodeFunctionResult({ abi: VOTER_ABI, functionName: 'gauges', data: raw })
      const gaugeAddr = String(decoded)
      if (gaugeAddr && gaugeAddr !== ZERO_ADDR) {
        gaugeMap.set(poolAddresses[i].toLowerCase(), gaugeAddr)
        gaugeAddrs.push(gaugeAddr)
      }
    } catch {}
  }

  console.log(`[best-aprs] Found ${gaugeMap.size} active gauges out of ${poolAddresses.length} pools`)

  if (gaugeAddrs.length === 0) return emissions

  // Step 2: Call Gauge.rewardRate() for each gauge
  const rewardCalls = gaugeAddrs.map(gauge => ({
    to: gauge,
    data: encodeFunctionData({ abi: GAUGE_ABI, functionName: 'rewardRate', args: [] }),
  }))

  const rewardResults = await rpcBatch(rewardCalls)

  // Parse reward rates and map back to pool addresses
  let withEmissions = 0
  const poolToGauge = [...gaugeMap.entries()] // [(poolAddr, gaugeAddr)]
  for (let i = 0; i < poolToGauge.length; i++) {
    const [poolAddr, _gaugeAddr] = poolToGauge[i]
    const raw = rewardResults[i]
    if (!raw) continue
    try {
      const decoded = decodeFunctionResult({ abi: GAUGE_ABI, functionName: 'rewardRate', data: raw })
      const rateWei = BigInt(String(decoded))
      if (rateWei > 0n) {
        const rateFloat = Number(rateWei) / 1e18
        emissions.set(poolAddr, rateFloat)
        withEmissions++
      }
    } catch {}
  }

  console.log(`[best-aprs] Gauge emissions: ${withEmissions} gauges with active rewards`)
  return emissions
}

// ─── GeckoTerminal: TVL, volume, and VELO price ──────────────────────────────

interface GeckoPool {
  address: string   // pool contract address on Ink
  base: string
  quote: string
  tvl: number
  vol24h: number
  isCL: boolean
  isStable: boolean
  feeApr: number
}

async function fetchGeckoTerminalData(): Promise<{ pools: GeckoPool[], veloPrice: number }> {
  const [poolsResult, priceResult] = await Promise.allSettled([
    fetchGeckoPools(),
    fetchVeloPrice(),
  ])
  const pools     = poolsResult.status === 'fulfilled' ? poolsResult.value : []
  const veloPrice = priceResult.status === 'fulfilled' ? priceResult.value : 0
  if (priceResult.status === 'rejected') {
    console.log(`[best-aprs] VELO price fetch failed: ${priceResult.reason}`)
  }
  return { pools, veloPrice }
}

async function fetchVeloPrice(): Promise<number> {
  // GeckoTerminal simple price
  try {
    const url = `${GECKO_BASE}/simple/networks/ink/token_price/${XVELO_INK}`
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8_000),
      headers: { 'Accept': 'application/json' },
    })
    if (res.ok) {
      const json = await res.json()
      const prices = json?.data?.attributes?.token_prices ?? {}
      const priceStr = prices[XVELO_INK.toLowerCase()] ?? '0'
      const price = parseFloat(priceStr)
      if (price > 0) {
        console.log(`[best-aprs] VELO price: $${price} (GeckoTerminal)`)
        return price
      }
    }
  } catch (e) {
    console.log(`[best-aprs] GeckoTerminal price error:`, e)
  }

  // Fallback: CoinGecko
  try {
    const res = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=velodrome-finance&vs_currencies=usd',
      { signal: AbortSignal.timeout(8_000) }
    )
    if (res.ok) {
      const json = await res.json()
      const price = json?.['velodrome-finance']?.usd ?? 0
      if (price > 0) {
        console.log(`[best-aprs] VELO price: $${price} (CoinGecko)`)
        return price
      }
    }
  } catch {}

  console.log(`[best-aprs] WARNING: VELO price unavailable`)
  return 0
}

async function fetchGeckoPools(): Promise<GeckoPool[]> {
  const out: GeckoPool[] = []
  const seen = new Set<string>()
  const VELO_FEE_STABLE = 0.0001, VELO_FEE_DEFAULT = 0.003

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

  const tokenSymbols = new Map<string, string>()
  for (const { included } of results) {
    for (const inc of included) {
      if (inc.type === 'token' && inc.attributes?.symbol) {
        tokenSymbols.set(inc.id, inc.attributes.symbol)
      }
    }
  }

  for (const { dexId, pools } of results) {
    const isSlipstream = dexId.includes('slipstream')
    for (const pool of pools) {
      const addr = pool.attributes?.address ?? pool.id ?? ''
      if (seen.has(addr)) continue
      seen.add(addr)

      const attrs = pool.attributes ?? {}
      const poolName = attrs.name ?? ''
      const baseTokenId  = pool.relationships?.base_token?.data?.id ?? ''
      const quoteTokenId = pool.relationships?.quote_token?.data?.id ?? ''
      let base  = tokenSymbols.get(baseTokenId) ?? ''
      let quote = tokenSymbols.get(quoteTokenId) ?? ''

      if ((!base || !quote) && poolName.includes('/')) {
        const parts = poolName.split('/').map((s: string) => s.trim())
        if (!base && parts[0]) base = parts[0]
        if (!quote && parts[1]) quote = parts[1]
      }
      if (!base || !quote) continue

      const tvl    = parseFloat(attrs.reserve_in_usd ?? '0')
      const vol24h = parseFloat(attrs.volume_usd?.h24 ?? '0')
      if (tvl < 50) continue

      // Extract the actual pool address (format: "ink_0xABC123...")
      let poolAddress = attrs.address ?? ''
      if (!poolAddress && typeof pool.id === 'string') {
        poolAddress = pool.id.replace(/^ink_/i, '')
      }

      const pairIsStable = poolName.toLowerCase().includes('stable') || allStable([base, quote])
      const feeRate = pairIsStable ? VELO_FEE_STABLE : VELO_FEE_DEFAULT
      const feeApr  = tvl > 0 ? (vol24h * feeRate * 365 / tvl) * 100 : 0

      out.push({ address: poolAddress, base, quote, tvl, vol24h, isCL: isSlipstream, isStable: pairIsStable, feeApr })
    }
  }

  console.log(`[best-aprs] GeckoTerminal: ${out.length} Velodrome pools`)
  return out
}

// ─── Combined Velodrome: Gauge emissions + GeckoTerminal price/TVL ──────────
async function fetchVelodromeData(): Promise<AprEntry[]> {
  const geckoData = await fetchGeckoTerminalData()
  const { pools: geckoPools, veloPrice } = geckoData
  const out: AprEntry[] = []

  if (geckoPools.length === 0) {
    console.log(`[best-aprs] No GeckoTerminal pools found`)
    return out
  }

  // Get pool addresses for gauge lookup
  const poolAddresses = geckoPools
    .map(g => g.address)
    .filter(a => a && a.startsWith('0x'))

  // Fetch gauge emissions via direct RPC calls
  let emissions = new Map<string, number>()
  if (poolAddresses.length > 0 && veloPrice > 0) {
    try {
      emissions = await fetchGaugeEmissions(poolAddresses)
    } catch (e) {
      console.log(`[best-aprs] Gauge emissions fetch failed: ${e}`)
    }
  }

  const hasEmissions = emissions.size > 0 && veloPrice > 0

  if (hasEmissions) {
    console.log(`[best-aprs] Computing emission APR: ${geckoPools.length} pools, VELO=$${veloPrice}, ${emissions.size} with gauges`)
  } else {
    console.log(`[best-aprs] Velodrome: fallback to fee-only APR (veloPrice=$${veloPrice}, gauges=${emissions.size})`)
  }

  for (const g of geckoPools) {
    // Emission APR from gauge rewardRate
    let emissionApr = 0
    if (hasEmissions) {
      const rewardRate = emissions.get(g.address.toLowerCase()) ?? 0
      if (rewardRate > 0 && g.tvl > 0) {
        // rewardRate is VELO/sec (already divided by 1e18)
        emissionApr = (rewardRate * veloPrice * SECONDS_YEAR / g.tvl) * 100
      }
    }

    const totalApr = emissionApr + g.feeApr

    if (totalApr <= 0 && g.tvl < 500) continue
    if (totalApr > 50_000) continue

    const suffix = g.isStable ? ' (stable)' : g.isCL ? ' (CL)' : ''
    out.push({
      protocol: g.isCL ? 'Velodrome V3' : 'Velodrome',
      logo:     'https://icons.llamao.fi/icons/protocols/velodrome-v2?w=48&h=48',
      url:      VELO_URL,
      tokens:   [g.base, g.quote],
      label:    `${g.base}-${g.quote}${suffix}`,
      apr:      Math.round(totalApr * 100) / 100,
      tvl:      g.tvl,
      type:     'pool',
      isStable: g.isStable,
    })
  }

  // Log top 5
  const sorted = [...out].sort((a, b) => b.apr - a.apr)
  for (const s of sorted.slice(0, 5)) {
    console.log(`  → ${s.label}: APR=${s.apr}% (tvl=$${s.tvl.toFixed(0)})`)
  }

  console.log(`[best-aprs] Velodrome: ${out.length} pools (${emissions.size} with emission APR)`)
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
  // Fetch from all sources in parallel:
  // - DefiLlama: All Ink protocols (Curve, Aave, Morpho, Tydro, etc.)
  // - Velodrome: Gauge emissions via direct RPC + GeckoTerminal TVL
  const [defiLlama, velodrome] = await Promise.all([
    fetchDefiLlama(),
    fetchVelodromeData(),
  ])

  // DefiLlama has data for many protocols including Velodrome
  // Velodrome data from gauge emissions has the most accurate APR
  const all: AprEntry[] = []
  const existingKeys = new Set<string>()

  // 1. Add Velodrome data first (gauge emissions have the best APR data)
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
      // If DefiLlama has higher APR for this pool, update
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

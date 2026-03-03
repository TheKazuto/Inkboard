import { NextResponse } from 'next/server'
import { encodeFunctionData, decodeFunctionResult, type Abi } from 'viem'

export const revalidate = 0

// ─── Types ──────────────────────────────────────────────────────────────────
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

// ─── Stablecoin classification ──────────────────────────────────────────────
const STABLECOINS = new Set([
  'USDC', 'USDC.E', 'USDT', 'USDT0', 'DAI', 'FRAX', 'FRXUSD', 'SFRXUSD',
  'CRVUSD', 'BUSD', 'TUSD', 'LUSD', 'MIM', 'USD1', 'LVUSD', 'USDE', 'SUSDE',
  'DOLA', 'GUSD', 'SUSD', 'USDP', 'PYUSD', 'FDUSD', 'USDG', 'OUSDT',
])

function isStable(sym: string): boolean {
  return STABLECOINS.has(sym.toUpperCase())
}
function allStable(tokens: string[]): boolean {
  return tokens.length > 0 && tokens.every(isStable)
}

// ─── Protocol metadata (DefiLlama project slug → display info) ──────────────
const PROTOCOL_META: Record<string, { name: string; logo: string; urlBase: string }> = {
  'velodrome-v3':   { name: 'Velodrome V3', logo: 'https://icons.llamao.fi/icons/protocols/velodrome-v2?w=48&h=48', urlBase: 'https://velodrome.finance/liquidity?filters=Ink' },
  'velodrome-v2':   { name: 'Velodrome V2', logo: 'https://icons.llamao.fi/icons/protocols/velodrome-v2?w=48&h=48', urlBase: 'https://velodrome.finance/liquidity?filters=Ink' },
  'velodrome':      { name: 'Velodrome',    logo: 'https://icons.llamao.fi/icons/protocols/velodrome-v2?w=48&h=48', urlBase: 'https://velodrome.finance/liquidity?filters=Ink' },
  'curve-dex':      { name: 'Curve',        logo: 'https://icons.llamao.fi/icons/protocols/curve-dex?w=48&h=48',    urlBase: 'https://curve.fi/#/ink/pools' },
  'tydro':          { name: 'Tydro',        logo: 'https://icons.llamao.fi/icons/protocols/tydro?w=48&h=48',       urlBase: 'https://app.tydro.com' },
  'inkyswap':       { name: 'InkySwap',     logo: 'https://icons.llamao.fi/icons/protocols/inkyswap?w=48&h=48',    urlBase: 'https://inkyswap.com/liquidity' },
}

function inferType(project: string, poolMeta: string | null): 'pool' | 'vault' | 'lend' {
  const p = project.toLowerCase(), m = (poolMeta ?? '').toLowerCase()
  if (p.includes('tydro') || m.includes('lend') || m.includes('supply') || m.includes('borrow')) return 'lend'
  if (m.includes('vault') || m.includes('auto')) return 'vault'
  return 'pool'
}

// ─── Velodrome on Ink (chain 57073) ─────────────────────────────────────────
const VOTER_INK    = '0x97cDBCe21B6fd0585d29E539B1B99dAd328a1123' as const
const INK_RPC      = 'https://rpc-gel.inkonchain.com'
const INK_RPC_ALT  = 'https://ink.drpc.org'
const VELO_URL     = 'https://velodrome.finance/liquidity?chain=57073'
const GECKO_BASE   = 'https://api.geckoterminal.com/api/v2'
const SECONDS_YEAR = 86400 * 365
const XVELO_INK    = '0x7f9AdFbd38b669F03d1d11000Bc76b9AaEA28A81'
const VELO_DEX_IDS = ['velodrome-finance-v2-ink', 'velodrome-finance-slipstream-ink']

// ─── InkySwap on Ink ────────────────────────────────────────────────────────
const INKY_URL       = 'https://inkyswap.com/liquidity'
const INKY_API_BASE  = 'https://inkyswap.com/api'

const VOTER_ABI: Abi = [{ name: 'gauges', type: 'function', stateMutability: 'view', inputs: [{ name: '_pool', type: 'address' }], outputs: [{ name: '', type: 'address' }] }]
const GAUGE_ABI: Abi = [{ name: 'rewardRate', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] }]

// ─── JSON-RPC batch with sequential fallback ────────────────────────────────
interface BatchCall   { to: string; data: `0x${string}` }
interface BatchResult { success: boolean; data: `0x${string}` }

async function rpcBatch(calls: BatchCall[], gas?: string): Promise<BatchResult[]> {
  if (calls.length === 0) return []
  const mkParams = (c: BatchCall) => gas ? { to: c.to, data: c.data, gas } : { to: c.to, data: c.data }
  const batch = calls.map((c, i) => ({ jsonrpc: '2.0' as const, id: i + 1, method: 'eth_call' as const, params: [mkParams(c), 'latest'] }))

  for (const rpc of [INK_RPC, INK_RPC_ALT]) {
    try {
      const res = await fetch(rpc, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(batch), signal: AbortSignal.timeout(15_000),
      })
      const json = await res.json()
      if (!Array.isArray(json)) return sequentialFallback(calls, gas)

      const results: BatchResult[] = calls.map(() => ({ success: false, data: '0x' as `0x${string}` }))
      let ok = 0
      for (const r of json) {
        const idx = (r.id ?? 0) - 1
        if (idx >= 0 && idx < calls.length && r.result && r.result !== '0x') {
          results[idx] = { success: true, data: r.result as `0x${string}` }
          ok++
        }
      }
      console.log(`[best-aprs] RPC batch via ${rpc}: ${ok}/${calls.length} success`)
      return results
    } catch { continue }
  }
  return calls.map(() => ({ success: false, data: '0x' as `0x${string}` }))
}

async function sequentialFallback(calls: BatchCall[], gas?: string): Promise<BatchResult[]> {
  return Promise.all(calls.map(async (call) => {
    try {
      const params = gas ? { to: call.to, data: call.data, gas } : { to: call.to, data: call.data }
      const res = await fetch(INK_RPC, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [params, 'latest'] }),
        signal: AbortSignal.timeout(10_000),
      })
      const json = await res.json()
      return json.result && json.result !== '0x'
        ? { success: true, data: json.result as `0x${string}` }
        : { success: false, data: '0x' as `0x${string}` }
    } catch { return { success: false, data: '0x' as `0x${string}` } }
  }))
}

// ─── Gauge emissions: Voter.gauges(pool) → Gauge.rewardRate() ───────────────
async function fetchGaugeEmissions(poolAddresses: string[]): Promise<Map<string, number>> {
  const emissions = new Map<string, number>()
  console.log(`[best-aprs] Fetching gauges for ${poolAddresses.length} pools...`)

  const gaugeResults = await rpcBatch(poolAddresses.map(pool => ({
    to: VOTER_INK,
    data: encodeFunctionData({ abi: VOTER_ABI, functionName: 'gauges', args: [pool as `0x${string}`] }),
  })))

  const ZERO = '0x0000000000000000000000000000000000000000'
  const poolGauges: { pool: string; gauge: string }[] = []
  for (let i = 0; i < poolAddresses.length; i++) {
    if (!gaugeResults[i].success) continue
    try {
      const gauge = decodeFunctionResult({ abi: VOTER_ABI, functionName: 'gauges', data: gaugeResults[i].data }) as string
      if (gauge && gauge !== ZERO) poolGauges.push({ pool: poolAddresses[i], gauge })
    } catch { /* skip */ }
  }
  console.log(`[best-aprs] Found ${poolGauges.length} active gauges out of ${poolAddresses.length} pools`)
  if (poolGauges.length === 0) return emissions

  const rateResults = await rpcBatch(poolGauges.map(pg => ({
    to: pg.gauge,
    data: encodeFunctionData({ abi: GAUGE_ABI, functionName: 'rewardRate', args: [] }),
  })))

  let withRewards = 0
  for (let i = 0; i < poolGauges.length; i++) {
    if (!rateResults[i].success) continue
    try {
      const rate = decodeFunctionResult({ abi: GAUGE_ABI, functionName: 'rewardRate', data: rateResults[i].data }) as bigint
      if (rate > 0n) { emissions.set(poolGauges[i].pool.toLowerCase(), Number(rate) / 1e18); withRewards++ }
    } catch { /* skip */ }
  }
  console.log(`[best-aprs] Gauge emissions: ${withRewards} gauges with active rewards`)
  return emissions
}

// ─── VELO price (GeckoTerminal → CoinGecko fallback) ────────────────────────
async function fetchVeloPrice(): Promise<number> {
  try {
    const res = await fetch(`${GECKO_BASE}/simple/networks/ink/token_price/${XVELO_INK}`, { signal: AbortSignal.timeout(8_000), headers: { Accept: 'application/json' } })
    if (res.ok) {
      const price = parseFloat((await res.json())?.data?.attributes?.token_prices?.[XVELO_INK.toLowerCase()] ?? '0')
      if (price > 0) { console.log(`[best-aprs] VELO price: $${price} (GeckoTerminal)`); return price }
    }
  } catch { /* fall through */ }
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=velodrome-finance&vs_currencies=usd', { signal: AbortSignal.timeout(8_000) })
    if (res.ok) {
      const price = (await res.json())?.['velodrome-finance']?.usd ?? 0
      if (price > 0) { console.log(`[best-aprs] VELO price: $${price} (CoinGecko)`); return price }
    }
  } catch { /* skip */ }
  console.log(`[best-aprs] WARNING: VELO price unavailable`)
  return 0
}

// ─── GeckoTerminal pool list for Velodrome on Ink ───────────────────────────
interface GeckoPool { address: string; base: string; quote: string; tvl: number; vol24h: number; isCL: boolean; isStable: boolean; feeApr: number }

async function fetchGeckoPools(): Promise<GeckoPool[]> {
  const out: GeckoPool[] = [], seen = new Set<string>()
  const FEE_STABLE = 0.0001, FEE_DEFAULT = 0.003

  const results = await Promise.all(VELO_DEX_IDS.map(async (dexId) => {
    try {
      const url = `${GECKO_BASE}/networks/ink/dexes/${dexId}/pools?page=1&sort=h24_volume_usd_desc&include=base_token,quote_token`
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { Accept: 'application/json' } })
      if (!res.ok) return { dexId, pools: [], included: [] }
      const json = await res.json()
      return { dexId, pools: json.data ?? [], included: json.included ?? [] }
    } catch { return { dexId, pools: [], included: [] } }
  }))

  const tokenSymbols = new Map<string, string>()
  for (const { included } of results)
    for (const inc of included)
      if (inc.type === 'token' && inc.attributes?.symbol) tokenSymbols.set(inc.id, inc.attributes.symbol)

  for (const { dexId, pools } of results) {
    const isCL = dexId.includes('slipstream')
    for (const pool of pools) {
      const attrs = pool.attributes ?? {}
      const addr = (attrs.address ?? '').toLowerCase()
      if (!addr || seen.has(addr)) continue
      seen.add(addr)

      const poolName = attrs.name ?? ''
      let base  = tokenSymbols.get(pool.relationships?.base_token?.data?.id ?? '') ?? ''
      let quote = tokenSymbols.get(pool.relationships?.quote_token?.data?.id ?? '') ?? ''
      if ((!base || !quote) && poolName.includes('/')) {
        const [p0, p1] = poolName.split('/').map((s: string) => s.trim())
        if (!base && p0) base = p0; if (!quote && p1) quote = p1
      }
      if (!base || !quote) continue

      const tvl = parseFloat(attrs.reserve_in_usd ?? '0'), vol24h = parseFloat(attrs.volume_usd?.h24 ?? '0')
      if (tvl < 50) continue

      const pairIsStable = poolName.toLowerCase().includes('stable') || allStable([base, quote])
      const feeApr = tvl > 0 ? (vol24h * (pairIsStable ? FEE_STABLE : FEE_DEFAULT) * 365 / tvl) * 100 : 0
      out.push({ address: addr, base, quote, tvl, vol24h, isCL, isStable: pairIsStable, feeApr })
    }
  }
  console.log(`[best-aprs] GeckoTerminal: ${out.length} Velodrome pools`)
  return out
}

// ─── Combined Velodrome: on-chain emissions + GeckoTerminal TVL/fees ────────
async function fetchVelodromeData(): Promise<AprEntry[]> {
  const [priceResult, poolsResult] = await Promise.allSettled([fetchVeloPrice(), fetchGeckoPools()])
  const veloPrice  = priceResult.status  === 'fulfilled' ? priceResult.value  : 0
  const geckoPools = poolsResult.status === 'fulfilled' ? poolsResult.value : []
  if (geckoPools.length === 0) return []

  let emissions = new Map<string, number>()
  try { emissions = await fetchGaugeEmissions(geckoPools.map(g => g.address)) }
  catch (e) { console.log(`[best-aprs] Gauge emissions failed: ${e}`) }

  console.log(`[best-aprs] Computing APR: ${geckoPools.length} pools, VELO=$${veloPrice}, ${emissions.size} with gauges`)

  const out: AprEntry[] = []
  for (const g of geckoPools) {
    const veloPerSec = emissions.get(g.address.toLowerCase()) ?? 0
    const emissionApr = (veloPerSec > 0 && veloPrice > 0 && g.tvl > 0) ? (veloPerSec * veloPrice * SECONDS_YEAR / g.tvl) * 100 : 0
    const totalApr = emissionApr + g.feeApr
    if (totalApr <= 0 && g.tvl < 500) continue
    if (totalApr > 50_000) continue

    const suffix = g.isStable ? ' (stable)' : g.isCL ? ' (CL)' : ''
    out.push({
      protocol: g.isCL ? 'Velodrome V3' : 'Velodrome',
      logo: 'https://icons.llamao.fi/icons/protocols/velodrome-v2?w=48&h=48',
      url: VELO_URL, tokens: [g.base, g.quote],
      label: `${g.base}-${g.quote}${suffix}`,
      apr: Math.round(totalApr * 100) / 100, tvl: g.tvl, type: 'pool', isStable: g.isStable,
    })
  }

  const sorted = [...out].sort((a, b) => b.apr - a.apr)
  for (const s of sorted.slice(0, 5)) console.log(`[best-aprs] → ${s.label}: APR=${s.apr}% (tvl=$${s.tvl.toFixed(0)})`)
  console.log(`[best-aprs] Velodrome: ${out.length} pools (${emissions.size} with emission APR)`)
  return out
}

// ─── InkySwap: native /api/pairs ────────────────────────────────────────────
// Returns total APR (fees + rewards combined) in the 'apr' field
async function fetchInkySwapData(): Promise<AprEntry[]> {
  const out: AprEntry[] = []
  try {
    const res = await fetch(`${INKY_API_BASE}/pairs`, {
      signal: AbortSignal.timeout(12_000),
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) { console.log(`[best-aprs] InkySwap API HTTP ${res.status}`); return out }
    const data = await res.json()
    const pairs: any[] = Array.isArray(data) ? data : (data?.pairs ?? data?.data ?? [])

    for (const p of pairs) {
      const base  = p.token0?.symbol ?? ''
      const quote = p.token1?.symbol ?? ''
      if (!base || !quote) continue

      const tvl    = parseFloat(p.liquidity_usd ?? '0')
      const vol24h = parseFloat(p.volume_24h ?? '0')
      if (tvl < 50) continue

      // apr field is total APR shown on inkyswap.com (fees + rewards)
      const apr = parseFloat(p.apr ?? '0')
      if (apr <= 0 && tvl < 500) continue
      if (apr > 50_000) continue

      const pairStable = allStable([base, quote])
      out.push({
        protocol: 'InkySwap',
        logo: 'https://icons.llamao.fi/icons/protocols/inkyswap?w=48&h=48',
        url: INKY_URL,
        tokens: [base, quote],
        label: `${base}-${quote}`,
        apr: Math.round(apr * 100) / 100,
        tvl,
        type: 'pool',
        isStable: pairStable,
      })
    }

    const sorted = [...out].sort((a, b) => b.apr - a.apr)
    for (const s of sorted.slice(0, 3)) console.log(`[best-aprs] → InkySwap ${s.label}: APR=${s.apr}% (tvl=$${s.tvl.toFixed(0)})`)
    console.log(`[best-aprs] InkySwap: ${out.length} pools from ${pairs.length} pairs`)
  } catch (e) { console.error('[best-aprs] InkySwap error:', e) }
  return out
}

// ─── DefiLlama (Tydro + Curve on Ink) ───────────────────────────────────────
// Only fetches Tydro and Curve — Velodrome and InkySwap are handled directly above
const LLAMA_SLUGS = new Set(['tydro', 'curve-dex'])

async function fetchDefiLlama(): Promise<AprEntry[]> {
  const out: AprEntry[] = []
  try {
    const res = await fetch('https://yields.llama.fi/pools', { signal: AbortSignal.timeout(15_000), headers: { Accept: 'application/json' } })
    if (!res.ok) { console.error(`[best-aprs] DefiLlama HTTP ${res.status}`); return out }

    const pools: any[] = (await res.json())?.data ?? []
    const target = pools.filter((p: any) =>
      p.chain?.toLowerCase() === 'ink' && LLAMA_SLUGS.has(p.project)
    )
    console.log(`[best-aprs] DefiLlama: ${target.length} Tydro+Curve pools on Ink (from ${pools.length} total)`)

    for (const p of target) {
      const project = p.project ?? '', symbol = p.symbol ?? ''
      const apy = p.apy ?? 0, tvl = p.tvlUsd ?? 0
      if (tvl < 500 || apy <= 0 || apy > 50_000) continue

      const tokens = symbol.split(/[-\/]/).map((t: string) => t.trim()).filter(Boolean)
      const meta = PROTOCOL_META[project] ?? {
        name: project.replace(/-/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()),
        logo: `https://icons.llamao.fi/icons/protocols/${project}?w=48&h=48`, urlBase: '#',
      }
      out.push({
        protocol: meta.name, logo: meta.logo, url: meta.urlBase, tokens, label: symbol,
        apr: apy, tvl, type: inferType(project, p.poolMeta ?? null), isStable: allStable(tokens),
      })
    }
  } catch (e) { console.error('[best-aprs] DefiLlama error:', e) }
  return out
}

// ─── Cache + GET ────────────────────────────────────────────────────────────
const CACHE_TTL = 3 * 60 * 1000
interface CacheEntry { data: AprEntry[]; fetchedAt: number }
let cache: CacheEntry | null = null
let inflight: Promise<AprEntry[]> | null = null

async function fetchAllAprs(): Promise<AprEntry[]> {
  const [v, i, l] = await Promise.allSettled([fetchVelodromeData(), fetchInkySwapData(), fetchDefiLlama()])
  const velo  = v.status === 'fulfilled' ? v.value : []
  const inky  = i.status === 'fulfilled' ? i.value : []
  const llama = l.status === 'fulfilled' ? l.value : []
  if (v.status === 'rejected') console.error('[best-aprs] Velodrome failed:', v.reason)
  if (i.status === 'rejected') console.error('[best-aprs] InkySwap failed:', i.reason)
  if (l.status === 'rejected') console.error('[best-aprs] DefiLlama failed:', l.reason)
  const all = [...velo, ...inky, ...llama]
  console.log(`[best-aprs] Total: ${all.length} entries (${velo.length} Velodrome + ${inky.length} InkySwap + ${llama.length} DefiLlama)`)
  all.sort((a, b) => b.apr - a.apr || b.tvl - a.tvl)
  return all
}

export async function GET() {
  const now = Date.now()
  if (cache && now - cache.fetchedAt < CACHE_TTL)
    return NextResponse.json(cache.data, { headers: { 'X-Cache': 'HIT', 'Cache-Control': 'public, max-age=60' } })
  if (!inflight) inflight = fetchAllAprs().finally(() => { inflight = null })
  try {
    const data = await inflight
    cache = { data, fetchedAt: now }
    return NextResponse.json(data, { headers: { 'X-Cache': 'MISS', 'Cache-Control': 'public, max-age=60' } })
  } catch (e) {
    console.error('[best-aprs] Fatal:', e)
    if (cache) return NextResponse.json(cache.data, { headers: { 'X-Cache': 'STALE' } })
    return NextResponse.json([], { status: 502 })
  }
}

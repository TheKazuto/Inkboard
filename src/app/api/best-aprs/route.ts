import { NextResponse } from 'next/server'
import { decodeAbiParameters } from 'viem'
import { INK_RPC } from '@/lib/ink'
import { kvGet, kvSet } from '@/lib/kvCache'
import { getPrice } from '@/lib/priceService'

export const revalidate = 0

// ─── Types ───────────────────────────────────────────────────────────────────
export interface AprEntry {
  protocol:  string
  logo:      string
  url:       string
  tokens:    string[]
  label:     string
  apr:       number
  tvl:       number
  type:      'pool' | 'vault' | 'lend'
  isStable:  boolean
}

// ─── Stablecoin classification ────────────────────────────────────────────────
const STABLECOINS = new Set([
  'USDC', 'USDC.E', 'USDT', 'USDT0', 'DAI', 'FRAX', 'FRXUSD', 'SFRXUSD',
  'CRVUSD', 'BUSD', 'TUSD', 'LUSD', 'MIM', 'USD1', 'LVUSD', 'USDE', 'SUSDE',
  'DOLA', 'GUSD', 'SUSD', 'USDP', 'PYUSD', 'FDUSD', 'USDG', 'OUSDT',
  'OUSD', 'OUSDM',
])

function isStable(sym: string): boolean {
  return STABLECOINS.has(sym.toUpperCase().replace('\u20ae', 'T'))
}
function allStable(tokens: string[]): boolean {
  return tokens.length > 0 && tokens.every(isStable)
}

const NADO_LOGO = '/nado-logo.jpg'

// ─── Velodrome on Ink (chain 57073) ──────────────────────────────────────────
const INK_RPC_ALT  = 'https://ink.drpc.org'
const VELO_URL     = 'https://velodrome.finance/liquidity?chain=57073'
const GECKO_BASE   = 'https://api.geckoterminal.com/api/v2'
const SECONDS_YEAR = 86400 * 365
const XVELO_INK    = '0x7f9AdFbd38b669F03d1d11000Bc76b9AaEA28A81'
const VELO_DEX_IDS = ['velodrome-finance-v2-ink', 'velodrome-finance-slipstream-ink']

// LP Sugar — all(uint256 limit, uint256 offset, uint256 filter) = 0x48523ff0
const LP_SUGAR    = '0x46e07c9b4016f8E5c3cD0b2fd20147A4d0972120' as const
const SUGAR_LIMIT = 50

// ─── InkySwap ────────────────────────────────────────────────────────────────
const INKY_URL      = 'https://inkyswap.com/liquidity'
const INKY_API_BASE = 'https://inkyswap.com/api'

// ─── Nado NLP Vault ───────────────────────────────────────────────────────────
const NADO_GATEWAY = 'https://gateway.prod.nado.xyz'
const NADO_ARCHIVE = 'https://archive.prod.nado.xyz/v1'
const NADO_HEADERS = {
  'Content-Type':    'application/json',
  'Accept':          'application/json',
  'Accept-Encoding': 'gzip, br, deflate',
}

// ─── Tydro (Aave V3 fork on Ink) ─────────────────────────────────────────────
const TYDRO_DATA_PROVIDER = '0x96086C25d13943C80Ff9a19791a40Df6aFC08328' as const
const TYDRO_URL           = 'https://app.tydro.com'
const TYDRO_LOGO          = 'https://icons.llamao.fi/icons/protocols/tydro?w=48&h=48'
const MERKL_URL           = 'https://api.merkl.xyz/v4/opportunities?chainId=57073&mainProtocolId=tydro&campaigns=true&status=LIVE'

const TYDRO_RESERVES: { address: string; symbol: string }[] = [
  { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH'    },
  { address: '0x73e0c0d45e048d25fc26fa3159b0aa04bfa4db98', symbol: 'kBTC'    },
  { address: '0x0200c29006150606b650577bbe7b6248f58470c1', symbol: 'USDT0'   },
  { address: '0xe343167631d89b6ffc58b88d6b7fb0228795491d', symbol: 'USDG'    },
  { address: '0xfc421ad3c883bf9e7c4f42de845c4e4405799e73', symbol: 'GHO'     },
  { address: '0x2d270e6886d130d724215a266106e6832161eaed', symbol: 'USDC'    },
  { address: '0xa3d68b74bf0528fdd07263c60d6488749044914b', symbol: 'weETH'   },
  { address: '0x9f0a74a92287e323eb95c1cd9ecdbeb0e397cae4', symbol: 'wrsETH'  },
  { address: '0x2416092f143378750bb29b79ed961ab195cceea5', symbol: 'ezETH'   },
  { address: '0x211cc4dd073734da055fbf44a2b4667d5e5fe5d2', symbol: 'sUSDe'   },
  { address: '0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34', symbol: 'USDe'    },
  { address: '0xae4efbc7736f963982aacb17efa37fcbab924cb3', symbol: 'SolvBTC' },
]

// ─── LP Sugar ABI ─────────────────────────────────────────────────────────────
const LP_COMPONENTS = [
  { name: 'lp',              type: 'address'  },
  { name: 'symbol',          type: 'string'   },
  { name: 'decimals',        type: 'uint8'    },
  { name: 'liquidity',       type: 'uint256'  },
  { name: 'type',            type: 'int24'    },
  { name: 'tick',            type: 'int24'    },
  { name: 'sqrt_ratio',      type: 'uint160'  },
  { name: 'token0',          type: 'address'  },
  { name: 'reserve0',        type: 'uint256'  },
  { name: 'staked0',         type: 'uint256'  },
  { name: 'token1',          type: 'address'  },
  { name: 'reserve1',        type: 'uint256'  },
  { name: 'staked1',         type: 'uint256'  },
  { name: 'gauge',           type: 'address'  },
  { name: 'gauge_liquidity', type: 'uint256'  },
  { name: 'gauge_alive',     type: 'bool'     },
  { name: 'fee',             type: 'address'  },
  { name: 'bribe',           type: 'address'  },
  { name: 'factory',         type: 'address'  },
  { name: 'emissions',       type: 'uint256'  },
  { name: 'emissions_token', type: 'address'  },
  { name: 'emissions_cap',   type: 'uint256'  },
  { name: 'pool_fee',        type: 'uint256'  },
  { name: 'unstaked_fee',    type: 'uint256'  },
  { name: 'token0_fees',     type: 'uint256'  },
  { name: 'token1_fees',     type: 'uint256'  },
  { name: 'locked',          type: 'uint256'  },
  { name: 'emerging',        type: 'uint256'  },
  { name: 'created_at',      type: 'uint32'   },
  { name: 'nfpm',            type: 'address'  },
  { name: 'alm',             type: 'address'  },
  { name: 'root',            type: 'address'  },
] as const

interface SugarPool {
  lp:         string
  symbol:     string
  token0:     string
  token1:     string
  emissions:  number
  gaugeAlive: boolean
  isCL:       boolean
  isStable:   boolean
}

// ─── Sugar: all pools paginated ───────────────────────────────────────────────
async function fetchSugarPools(): Promise<SugarPool[]> {
  const all: SugarPool[] = []
  let offset = 0

  while (true) {
    const data = (
      '0x48523ff0'
      + SUGAR_LIMIT.toString(16).padStart(64, '0')
      + offset.toString(16).padStart(64, '0')
      + '0'.repeat(64)
    ) as `0x${string}`

    let result = ''
    for (const rpc of [INK_RPC, INK_RPC_ALT]) {
      try {
        const res = await fetch(rpc, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: LP_SUGAR, data }, 'latest'] }),
          signal: AbortSignal.timeout(20_000),
        })
        const json = await res.json()
        if (json.result && json.result.length > 10) { result = json.result; break }
      } catch { continue }
    }
    if (!result) break

    let batch: readonly { lp: string; symbol: string; type: number; token0: string; token1: string; gauge_alive: boolean; emissions: bigint; [k: string]: unknown }[]
    try {
      const decoded = decodeAbiParameters(
        [{ type: 'tuple[]', components: LP_COMPONENTS }],
        result as `0x${string}`
      )
      batch = decoded[0] as typeof batch
    } catch (e) {
      console.error('[best-aprs] Sugar decode error at offset', offset, e)
      break
    }

    for (const p of batch) {
      const lpType = Number(p.type)
      all.push({
        lp:         (p.lp as string).toLowerCase(),
        symbol:     p.symbol as string,
        token0:     (p.token0 as string).toLowerCase(),
        token1:     (p.token1 as string).toLowerCase(),
        emissions:  Number(p.emissions as bigint) / 1e18,
        gaugeAlive: p.gauge_alive as boolean,
        isCL:       lpType > 0,
        isStable:   lpType < 0,
      })
    }

    if (batch.length < SUGAR_LIMIT) break
    offset += SUGAR_LIMIT
  }

  return all
}

// ─── XVELO price ──────────────────────────────────────────────────────────────
// Priority: GeckoTerminal on-chain price (free, no API key)
// Fallback:  priceService KV cache (velodrome-finance already in ALL_PRICE_IDS)
// NO direct CoinGecko call — avoids a redundant API hit on every best-aprs request.
async function fetchXveloPrice(): Promise<number> {
  try {
    const res = await fetch(`${GECKO_BASE}/simple/networks/ink/token_price/${XVELO_INK}`, {
      signal: AbortSignal.timeout(8_000),
      headers: { Accept: 'application/json' },
    })
    if (res.ok) {
      const price = parseFloat(
        (await res.json())?.data?.attributes?.token_prices?.[XVELO_INK.toLowerCase()] ?? '0'
      )
      if (price > 0) return price
    }
  } catch { /* fall through to priceService */ }

  // Fallback: velodrome-finance is already cached in priceService (no extra CoinGecko call)
  return getPrice('velodrome-finance')
}

// ─── GeckoTerminal: TVL + vol24h for Velodrome pools ─────────────────────────
interface GeckoPool {
  address: string; base: string; quote: string
  tvl: number; vol24h: number
  isCL: boolean; isStable: boolean; feeApr: number
}

async function fetchGeckoPools(): Promise<GeckoPool[]> {
  const out: GeckoPool[] = [], seen = new Set<string>()
  const FEE_STABLE = 0.0001, FEE_DEFAULT = 0.003

  const pageFetches: Promise<{ dexId: string; pools: any[]; included: any[] }>[] = []
  for (const dexId of VELO_DEX_IDS) {
    for (let page = 1; page <= 3; page++) {
      pageFetches.push(
        fetch(
          `${GECKO_BASE}/networks/ink/dexes/${dexId}/pools?page=${page}&sort=h24_volume_usd_desc&include=base_token,quote_token`,
          { signal: AbortSignal.timeout(10_000), headers: { Accept: 'application/json' } }
        )
          .then(r => r.ok ? r.json() : null)
          .then(json => ({ dexId, pools: json?.data ?? [], included: json?.included ?? [] }))
          .catch(() => ({ dexId, pools: [], included: [] }))
      )
    }
  }

  const results = await Promise.all(pageFetches)

  const tokenSymbols = new Map<string, string>()
  for (const { included } of results)
    for (const inc of included)
      if (inc.type === 'token' && inc.attributes?.symbol)
        tokenSymbols.set(inc.id, inc.attributes.symbol)

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
        const nameClean = poolName.replace(/\s*\d+\.?\d*%\s*$/, '').trim()
        const [p0, p1] = nameClean.split('/').map((s: string) => s.trim())
        if (!base && p0) base = p0
        if (!quote && p1) quote = p1
      }
      if (!base || !quote) continue

      base  = base.replace('\u20ae', 'T')
      quote = quote.replace('\u20ae', 'T')

      const tvl    = parseFloat(attrs.reserve_in_usd ?? '0')
      const vol24h = parseFloat(attrs.volume_usd?.h24 ?? '0')
      if (tvl < 50) continue

      const pairIsStable = poolName.toLowerCase().includes('stable') || allStable([base, quote])
      const feeApr = tvl > 0 ? (vol24h * (pairIsStable ? FEE_STABLE : FEE_DEFAULT) * 365 / tvl) * 100 : 0

      out.push({ address: addr, base, quote, tvl, vol24h, isCL, isStable: pairIsStable, feeApr })
    }
  }

  return out
}

// ─── Velodrome: Sugar emissions + GeckoTerminal TVL/fees ─────────────────────
async function fetchVelodromeData(): Promise<AprEntry[]> {
  const [xveloPriceResult, geckoResult, sugarResult] = await Promise.allSettled([
    fetchXveloPrice(),
    fetchGeckoPools(),
    fetchSugarPools(),
  ])

  const xveloPrice = xveloPriceResult.status === 'fulfilled' ? xveloPriceResult.value : 0
  const geckoPools = geckoResult.status       === 'fulfilled' ? geckoResult.value     : []
  const sugarPools = sugarResult.status       === 'fulfilled' ? sugarResult.value     : []

  if (sugarResult.status === 'rejected')
    console.error('[best-aprs] Sugar fetch failed:', sugarResult.reason)
  if (geckoResult.status === 'rejected')
    console.error('[best-aprs] GeckoTerminal fetch failed:', geckoResult.reason)

  const emissionsMap = new Map<string, number>()
  for (const p of sugarPools)
    if (p.gaugeAlive && p.emissions > 0) emissionsMap.set(p.lp, p.emissions)

  if (geckoPools.length === 0) return []

  const out: AprEntry[] = []
  for (const g of geckoPools) {
    const xveloPerSec = emissionsMap.get(g.address) ?? 0
    const emissionApr = (xveloPerSec > 0 && xveloPrice > 0 && g.tvl > 0)
      ? (xveloPerSec * xveloPrice * SECONDS_YEAR / g.tvl) * 100
      : 0
    const totalApr = emissionApr + g.feeApr
    if (totalApr <= 0 && g.tvl < 500) continue
    if (totalApr > 50_000) continue

    const suffix = g.isStable ? ' (stable)' : g.isCL ? ' (CL)' : ''
    out.push({
      protocol: g.isCL ? 'Velodrome CL' : 'Velodrome',
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

  return out
}

// ─── InkySwap ─────────────────────────────────────────────────────────────────
async function fetchInkySwapData(): Promise<AprEntry[]> {
  const out: AprEntry[] = []
  try {
    const res = await fetch(`${INKY_API_BASE}/pairs`, {
      signal: AbortSignal.timeout(12_000),
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) return out
    const data = await res.json()
    const pairs: any[] = Array.isArray(data) ? data : (data?.pairs ?? data?.data ?? [])

    for (const p of pairs) {
      const base  = p.token0?.symbol ?? ''
      const quote = p.token1?.symbol ?? ''
      if (!base || !quote) continue
      const tvl    = parseFloat(p.liquidity_usd ?? p.tvl_usd ?? p.tvl ?? '0')
      const aprRaw = parseFloat(p.apr ?? p.total_apr ?? '0')
      if (tvl < 100 || aprRaw <= 0 || aprRaw > 50_000) continue
      out.push({
        protocol: 'InkySwap',
        logo:     'https://icons.llamao.fi/icons/protocols/inkyswap?w=48&h=48',
        url:      INKY_URL,
        tokens:   [base, quote],
        label:    `${base}-${quote}`,
        apr:      Math.round(aprRaw * 100) / 100,
        tvl,
        type:     'pool',
        isStable: allStable([base, quote]),
      })
    }
  } catch (e) { console.error('[best-aprs] InkySwap error:', e) }
  return out
}

// ─── Nado NLP Vault ───────────────────────────────────────────────────────────
async function fetchNadoVault(): Promise<AprEntry[]> {
  try {
    const now = Math.floor(Date.now() / 1000)
    const thirtyDaysAgo = now - 30 * 86400

    const [poolRes, snapNowRes, snapOldRes] = await Promise.all([
      fetch(`${NADO_GATEWAY}/v1/query?type=nlp_pool_info`, {
        headers: NADO_HEADERS,
        signal: AbortSignal.timeout(10_000),
      }).then(r => r.ok ? r.json() : null).catch(() => null),

      fetch(NADO_ARCHIVE, {
        method: 'POST',
        headers: NADO_HEADERS,
        signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({ nlp_snapshots: { limit: 1 } }),
      }).then(r => r.ok ? r.json() : null).catch(() => null),

      fetch(NADO_ARCHIVE, {
        method: 'POST',
        headers: NADO_HEADERS,
        signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({ nlp_snapshots: { limit: 1, max_time: thirtyDaysAgo } }),
      }).then(r => r.ok ? r.json() : null).catch(() => null),
    ])

    const pools = poolRes?.data?.nlp_pools ?? []
    if (pools.length === 0) return []

    let nlpSupply = 0, nlpPriceFromPool = 0
    for (const pool of pools) {
      for (const sp of (pool.subaccount_info?.spot_products ?? [])) {
        if (sp.product_id === 11) {
          nlpSupply        = parseFloat(sp.state?.total_deposits_normalized ?? '0') / 1e18
          nlpPriceFromPool = parseFloat(sp.oracle_price_x18 ?? '0') / 1e18
          break
        }
      }
      if (nlpSupply > 0) break
    }

    const latestSnap = (snapNowRes?.snapshots ?? [])[0]
    const totalTVL = latestSnap
      ? parseFloat(latestSnap.tvl ?? '0') / 1e18
      : nlpSupply * nlpPriceFromPool
    if (totalTVL < 100) return []

    let apr = 0
    const currentPrice = latestSnap
      ? parseFloat(latestSnap.oracle_price_x18 ?? '0') / 1e18
      : nlpPriceFromPool
    const oldSnap = (snapOldRes?.snapshots ?? [])[0]
    if (oldSnap) {
      const oldPrice = parseFloat(oldSnap.oracle_price_x18 ?? '0') / 1e18
      if (oldPrice > 0 && currentPrice > oldPrice) {
        const oldTs       = parseInt(oldSnap.timestamp ?? '0')
        const newTs       = latestSnap ? parseInt(latestSnap.timestamp ?? '0') : now
        const daysBetween = Math.max(1, (newTs - oldTs) / 86400)
        apr = ((currentPrice - oldPrice) / oldPrice) * (365 / daysBetween) * 100
      }
    }
    if (apr <= 0 && currentPrice > 1.0) {
      const LAUNCH          = new Date('2025-11-20').getTime()
      const daysSinceLaunch = Math.max(1, (Date.now() - LAUNCH) / 86_400_000)
      apr = (currentPrice - 1.0) * (365 / daysSinceLaunch) * 100
    }

    return [{
      protocol: 'Nado',
      logo:     NADO_LOGO,
      url:      'https://app.nado.xyz/vault',
      tokens:   ['USDT0'],
      label:    'NLP Vault',
      apr:      Math.round(apr * 100) / 100,
      tvl:      totalTVL,
      type:     'vault',
      isStable: false,
    }]
  } catch (e) { console.error('[best-aprs] Nado error:', e); return [] }
}

// ─── Tydro: on-chain supply APR + Merkl incentives ───────────────────────────
async function fetchTydroData(): Promise<AprEntry[]> {
  const batch = TYDRO_RESERVES.map((r, i) => ({
    jsonrpc: '2.0' as const,
    id: i,
    method: 'eth_call' as const,
    params: [
      {
        to: TYDRO_DATA_PROVIDER,
        data: ('0x35ea6a75' + '000000000000000000000000' + r.address.slice(2)) as `0x${string}`,
      },
      'latest',
    ],
  }))

  const [onChainRes, merklRes] = await Promise.allSettled([
    fetch(INK_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batch),
      signal: AbortSignal.timeout(15_000),
    }).then(r => r.ok ? r.json() : null),

    fetch(MERKL_URL, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    }).then(r => r.ok ? r.json() : null).catch(() => null),
  ])

  const supplyAprs = new Map<string, number>()
  if (onChainRes.status === 'fulfilled' && Array.isArray(onChainRes.value)) {
    for (const item of onChainRes.value) {
      const reserve = TYDRO_RESERVES[item.id]
      if (!reserve || !item.result || item.result === '0x') continue
      try {
        const hex = item.result.slice(2)
        const liquidityRate = BigInt('0x' + hex.slice(5 * 64, 6 * 64))
        supplyAprs.set(reserve.address.toLowerCase(), Number(liquidityRate) / 1e27 * 100)
      } catch { /* skip */ }
    }
  } else {
    console.error('[best-aprs] Tydro on-chain failed:', onChainRes.status === 'rejected' ? onChainRes.reason : 'null')
  }

  const merklAprs = new Map<string, number>()
  if (merklRes.status === 'fulfilled' && Array.isArray(merklRes.value)) {
    for (const opp of merklRes.value) {
      const merklApr = opp.apr ?? 0
      if (merklApr <= 0) continue
      for (const t of (opp.tokens ?? [])) {
        const addr = (t.address ?? '').toLowerCase()
        if (addr) merklAprs.set(addr, (merklAprs.get(addr) ?? 0) + merklApr)
      }
    }
  }

  const out: AprEntry[] = []
  for (const reserve of TYDRO_RESERVES) {
    const key       = reserve.address.toLowerCase()
    const supplyApr = supplyAprs.get(key) ?? 0
    const merklApr  = merklAprs.get(key) ?? 0
    const totalApr  = supplyApr + merklApr
    if (totalApr <= 0) continue

    out.push({
      protocol: 'Tydro',
      logo:     TYDRO_LOGO,
      url:      TYDRO_URL,
      tokens:   [reserve.symbol],
      label:    `${reserve.symbol} Lending`,
      apr:      Math.round(totalApr * 100) / 100,
      tvl:      0,
      type:     'lend',
      isStable: isStable(reserve.symbol),
    })
  }

  return out
}

// ─── Curve on Ink: DefiLlama ──────────────────────────────────────────────────
async function fetchCurveData(): Promise<AprEntry[]> {
  const out: AprEntry[] = []
  try {
    const res = await fetch('https://yields.llama.fi/pools', {
      signal: AbortSignal.timeout(15_000),
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) return out
    const pools: any[] = (await res.json())?.data ?? []
    for (const p of pools) {
      if (p.chain?.toLowerCase() !== 'ink' || p.project !== 'curve-dex') continue
      const apy = p.apy ?? 0, tvl = p.tvlUsd ?? 0
      if (tvl < 500 || apy <= 0 || apy > 50_000) continue
      const tokens = (p.symbol ?? '').split(/[-/]/).map((t: string) => t.trim()).filter(Boolean)
      out.push({
        protocol: 'Curve',
        logo:     'https://icons.llamao.fi/icons/protocols/curve-dex?w=48&h=48',
        url:      'https://curve.fi/#/ink/pools',
        tokens,
        label:    p.symbol ?? '',
        apr:      apy,
        tvl,
        type:     'pool',
        isStable: allStable(tokens),
      })
    }
  } catch (e) { console.error('[best-aprs] Curve error:', e) }
  return out
}

// ─── Cache + GET ──────────────────────────────────────────────────────────────
const SOFT_TTL = 3 * 60 * 1000
const HARD_TTL = 10 * 60

let inflight: Promise<AprEntry[]> | null = null

async function fetchAllAprs(): Promise<AprEntry[]> {
  const [v, i, n, t, c] = await Promise.allSettled([
    fetchVelodromeData(),
    fetchInkySwapData(),
    fetchNadoVault(),
    fetchTydroData(),
    fetchCurveData(),
  ])
  const velo  = v.status === 'fulfilled' ? v.value : []
  const inky  = i.status === 'fulfilled' ? i.value : []
  const nado  = n.status === 'fulfilled' ? n.value : []
  const tydro = t.status === 'fulfilled' ? t.value : []
  const curve = c.status === 'fulfilled' ? c.value : []
  if (v.status === 'rejected') console.error('[best-aprs] Velodrome failed:', v.reason)
  if (i.status === 'rejected') console.error('[best-aprs] InkySwap failed:', i.reason)
  if (n.status === 'rejected') console.error('[best-aprs] Nado failed:', n.reason)
  if (t.status === 'rejected') console.error('[best-aprs] Tydro failed:', t.reason)
  if (c.status === 'rejected') console.error('[best-aprs] Curve failed:', c.reason)
  const all = [...velo, ...inky, ...nado, ...tydro, ...curve]
  all.sort((a, b) => b.apr - a.apr || b.tvl - a.tvl)
  return all
}

export async function GET() {
  const cached = await kvGet<AprEntry[]>('best-aprs', SOFT_TTL)

  if (cached.data && cached.fresh) {
    return NextResponse.json(cached.data, { headers: { 'X-Cache': 'HIT', 'Cache-Control': 'public, max-age=60' } })
  }

  if (!inflight) inflight = fetchAllAprs().finally(() => { inflight = null })

  try {
    const data = await inflight
    await kvSet('best-aprs', data, HARD_TTL)
    return NextResponse.json(data, { headers: { 'X-Cache': 'MISS', 'Cache-Control': 'public, max-age=60' } })
  } catch (e) {
    console.error('[best-aprs] Fatal:', e)
    if (cached.data) return NextResponse.json(cached.data, { headers: { 'X-Cache': 'STALE' } })
    return NextResponse.json([], { status: 502 })
  }
}

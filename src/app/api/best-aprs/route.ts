import { NextResponse } from 'next/server'
import { INK_RPC, INK_RPC_SECONDARY } from '@/lib/ink'
import { kvGet, kvSet } from '@/lib/kvCache'

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
  'OUSD', 'OUSDM',
])

function isStable(sym: string): boolean {
  return STABLECOINS.has(sym.toUpperCase().replace('₮', 'T'))
}
function allStable(tokens: string[]): boolean {
  return tokens.length > 0 && tokens.every(isStable)
}

const NADO_LOGO = '/nado-logo.jpg'

// ─── Velodrome on Ink — via vfat.io aggregator API ───────────────────────────
// Source: https://api.vfat.io/openapi.json → GET /v4/farms?chainId=57073
// Returns pools with rewardsPerSecond, XVELO price, stakedReserve, dailySwapFees
const VELO_URL      = 'https://velodrome.finance/liquidity?chain=57073'
const VFAT_API      = 'https://api.vfat.io/v4/farms'
const SECONDS_YEAR  = 86400 * 365

// ─── InkySwap ────────────────────────────────────────────────────────────────
const INKY_URL      = 'https://inkyswap.com/liquidity'
const INKY_API_BASE = 'https://inkyswap.com/api'

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

// ─── Velodrome via vfat.io aggregator API ────────────────────────────────────
// GET /v4/farms?chainId=57073 — returns all farms with:
//   pool.underlying[].stakedReserve  → staked TVL per token
//   pool.underlying[].dailySwapFees  → daily fee revenue per token (CL only)
//   rewards[].rewardsPerSecond       → XVELO emissions (wei/sec)
//   rewards[].rewardToken.price      → XVELO price in USD
//
// farm.type breakdown:
//   AERODROME_V2          → Velodrome V2 volatile/stable AMM (vAMMV2/sAMMV2)
//   AERO_SLIPSTREAM_GAUGE → Velodrome CL (Slipstream / Uniswap V3 style)
//   UNISWAP_V3            → pure pool entry without gauge — no rewards, skip

async function fetchVelodromeData(): Promise<AprEntry[]> {
  let farms: any[]
  try {
    const res = await fetch(`${VFAT_API}?chainId=57073`, {
      signal: AbortSignal.timeout(15_000),
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) {
      console.error(`[best-aprs] vfat API HTTP ${res.status}`)
      return []
    }
    farms = await res.json()
    if (!Array.isArray(farms)) return []
  } catch (e) {
    console.error('[best-aprs] vfat fetch failed:', e)
    return []
  }

  const out: AprEntry[] = []

  for (const farm of farms) {
    const ftype = farm.type as string
    // Only process gauged pools — UNISWAP_V3 entries are mirror pools with no rewards
    if (ftype !== 'AERODROME_V2' && ftype !== 'AERO_SLIPSTREAM_GAUGE') continue
    if (farm.isKilled) continue

    const pool       = farm.pool ?? {}
    const underlying = (pool.underlying ?? []) as any[]
    const isCL       = ftype === 'AERO_SLIPSTREAM_GAUGE'
    const isStablePool = pool.isStable === true

    // ── TVL: sum of (stakedReserve / 10^decimals * price) per token ──────────
    let stakedTvl = 0
    let totalTvl  = 0
    let dailyFeesUsd = 0

    for (const t of underlying) {
      const price = (t.price as number) ?? 0
      const dec   = (t.decimals as number) ?? 18

      const staked = Number(BigInt(t.stakedReserve ?? '0')) / 10 ** dec * price
      const total  = Number(BigInt(t.reserve      ?? t.reserves ?? '0')) / 10 ** dec * price
      stakedTvl += staked
      totalTvl  += total

      // CL pools expose dailySwapFees per token (in token-native units)
      if (isCL && t.dailySwapFees) {
        dailyFeesUsd += Number(BigInt(t.dailySwapFees)) / 10 ** dec * price
      }
    }

    if (totalTvl < 50) continue

    // ── Emission APR — rewards against staked TVL ─────────────────────────────
    let emissionApr = 0
    for (const r of (farm.rewards ?? []) as any[]) {
      const rps        = Number(BigInt(r.rewardsPerSecond ?? '0')) / 1e18  // XVELO/sec
      const xveloPrice = (r.rewardToken?.price as number) ?? 0
      const base       = stakedTvl > 0 ? stakedTvl : totalTvl
      if (rps > 0 && xveloPrice > 0 && base > 0) {
        emissionApr += rps * xveloPrice * SECONDS_YEAR / base * 100
      }
    }

    // ── Fee APR — daily fees annualised against total TVL (CL only) ───────────
    // V2 underlying doesn't expose dailySwapFees, so fee APR stays 0 for V2
    const feeApr = (isCL && dailyFeesUsd > 0 && totalTvl > 0)
      ? dailyFeesUsd * 365 / totalTvl * 100
      : 0

    const totalApr = emissionApr + feeApr
    if (totalApr <= 0 && totalTvl < 500) continue
    if (totalApr > 50_000) continue

    const tokens  = underlying.map((t: any) => (t.symbol as string).replace('₮', 'T'))
    const suffix  = isStablePool ? ' (stable)' : isCL ? ' (CL)' : ''
    const stable  = isStablePool || allStable(tokens)

    out.push({
      protocol: isCL ? 'Velodrome CL' : 'Velodrome',
      logo:     'https://icons.llamao.fi/icons/protocols/velodrome-v2?w=48&h=48',
      url:      VELO_URL,
      tokens,
      label:    `${tokens.join('-')}${suffix}`,
      apr:      Math.round(totalApr * 100) / 100,
      tvl:      Math.round(totalTvl),
      type:     'pool',
      isStable: stable,
    })
  }

  console.log(`[best-aprs] Velodrome: ${out.length} pools via vfat API`)
  return out
}

// ─── InkySwap: /api/pairs ─────────────────────────────────────────────────────
// Confirmed via bundle analysis (chunk 2988-1fe4362d2f7e9b99.js):
//   GET https://inkyswap.com/api/pairs
//   Returns 400+ pools with pre-calculated `apr` field — the site uses it directly.
//   Fields: pair_address, token0.symbol, token1.symbol, liquidity_usd,
//           volume_24h, apr, fee_tier, version, daily_fees

async function fetchInkySwapData(): Promise<AprEntry[]> {
  const out: AprEntry[] = []
  try {
    const res = await fetch(`${INKY_API_BASE}/pairs`, {
      signal:  AbortSignal.timeout(12_000),
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) {
      console.error(`[best-aprs] InkySwap HTTP ${res.status}`)
      return out
    }
    const pairs: any[] = await res.json()
    if (!Array.isArray(pairs)) return out

    for (const p of pairs) {
      const base  = (p.token0?.symbol as string ?? '').replace('\u20ae', 'T')
      const quote = (p.token1?.symbol as string ?? '').replace('\u20ae', 'T')
      if (!base || !quote) continue

      const tvl = (p.liquidity_usd as number) ?? 0
      const apr = (p.apr           as number) ?? 0
      if (tvl < 500 || apr <= 0 || apr > 50_000) continue

      // Include version + fee_tier in label so v2/v3/v4 duplicates are distinguishable
      const ver    = (p.version  as string) ?? 'v2'
      const feeTier = (p.fee_tier as string) ?? ''
      const suffix  = feeTier ? `${ver} ${feeTier}` : ver

      out.push({
        protocol: 'InkySwap',
        logo:     'https://icons.llamao.fi/icons/protocols/inkyswap?w=48&h=48',
        url:      INKY_URL,
        tokens:   [base, quote],
        label:    `${base}-${quote} (${suffix})`,
        apr:      Math.round(apr * 100) / 100,
        tvl,
        type:     'pool',
        isStable: allStable([base, quote]),
      })
    }
    console.log(`[best-aprs] InkySwap: ${out.length} pools from /api/pairs`)
  } catch (e) { console.error('[best-aprs] InkySwap error:', e) }
  return out
}

// ─── Nado NLP Vault ───────────────────────────────────────────────────────────
// Discovered via bundle analysis of https://app.nado.xyz/vault (module 84791)
//
// API: POST https://archive.prod.nado.xyz/v1
//   body: { nlp_snapshots: { interval: { count: 2, granularity: 2592000, max_time: <unix_s> } } }
//   → { snapshots: [<now>, <30d_ago>] }   (newest first when max_time is provided)
//
// Requires Accept-Encoding: gzip (otherwise 403 "Invalid compression headers")
//
// Site APR formula (from module 84791):
//   monthly_ratio = latestPrice / earliestPrice   (BL = simple division, module 91219)
//   apr = monthly_ratio^12 - 1                    (12 = months per year)
//
// Passes max_time = current Unix timestamp so the archive returns exactly 2 snapshots
// spaced ~30 days apart. Without max_time the API returns all available snapshots
// which breaks the 30-day window assumption.

const NADO_HEADERS = {
  'Content-Type':    'application/json',
  'Accept-Encoding': 'gzip, deflate, br',
  'Accept':          'application/json',
}

async function fetchNadoVault(): Promise<AprEntry[]> {
  try {
    const maxTime = Math.floor(Date.now() / 1_000)

    const res = await fetch('https://archive.prod.nado.xyz/v1', {
      method:  'POST',
      headers: NADO_HEADERS,
      body:    JSON.stringify({
        nlp_snapshots: {
          interval: { count: 2, granularity: 2_592_000, max_time: maxTime },
        },
      }),
      signal: AbortSignal.timeout(12_000),
    })
    if (!res.ok) {
      console.error(`[best-aprs] Nado archive HTTP ${res.status}`)
      return []
    }

    const data              = await res.json()
    const snaps: any[]      = data?.snapshots ?? []
    if (snaps.length < 2) return []

    // With max_time, the archive returns exactly 2 snapshots:
    //   snaps[0] = latest  (at or just before max_time)
    //   snaps[1] = 30d ago (at or just before max_time - 2592000)
    const latest   = snaps[0]
    const earlier  = snaps[1]

    const tvl          = Number(BigInt(latest.tvl              ?? '0')) / 1e18
    const priceLatest  = Number(BigInt(latest.oracle_price_x18 ?? '0')) / 1e18
    const priceEarlier = Number(BigInt(earlier.oracle_price_x18 ?? '0')) / 1e18

    if (tvl < 100 || priceLatest <= 0 || priceEarlier <= 0) return []

    // Exact formula used by Nado's vault page (bundle module 84791):
    //   ratio = latest / earlier  (monthly return)
    //   apr   = ratio^12 - 1      (annualised)
    const ratio = priceLatest / priceEarlier
    let apr = (Math.pow(ratio, 12) - 1) * 100

    // Fallback if APR is negative (price declined over 30d window)
    if (apr <= 0 && priceLatest > 1.0) {
      const LAUNCH          = new Date('2025-11-20').getTime()
      const daysSinceLaunch = Math.max(1, (Date.now() - LAUNCH) / 86_400_000)
      apr = ((priceLatest - 1.0) / 1.0) * (365 / daysSinceLaunch) * 100
    }

    return [{
      protocol: 'Nado',
      logo:     NADO_LOGO,
      url:      'https://app.nado.xyz/vault',
      tokens:   ['USDT0'],
      label:    'NLP Vault',
      apr:      Math.round(apr * 100) / 100,
      tvl,
      type:     'vault',
      isStable: false,
    }]
  } catch (e) {
    console.error('[best-aprs] Nado error:', e)
    return []
  }
}

// ─── Tydro: on-chain supply APR + Merkl incentives ───────────────────────────
// getReserveData(address) slot [5] = liquidityRate in RAY (÷1e27 = APR%)
// Confirmed on-chain: WETH ~1.7%, USDT0 ~1.5%, USDG ~2.2%, GHO ~3.2%, USDC ~1.4%, USDe ~9.1%

async function tydroRpcBatch(rpcUrl: string, batch: object[]): Promise<any[] | null> {
  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batch),
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return null
    const data = await res.json()
    return Array.isArray(data) ? data : null
  } catch (e) {
    console.error(`[best-aprs] Tydro RPC ${rpcUrl} failed:`, e)
    return null
  }
}

async function fetchTydroData(): Promise<AprEntry[]> {
  const batch = TYDRO_RESERVES.map((r, i) => ({
    jsonrpc: '2.0' as const,
    id: i,
    method: 'eth_call' as const,
    params: [
      {
        to:   TYDRO_DATA_PROVIDER,
        data: ('0x35ea6a75' + '000000000000000000000000' + r.address.slice(2)) as `0x${string}`,
      },
      'latest',
    ],
  }))

  const [rpcResults, merklRes] = await Promise.allSettled([
    (async () => {
      const primary = await tydroRpcBatch(INK_RPC, batch)
      if (primary) return primary
      console.warn('[best-aprs] Tydro: primary RPC failed, trying secondary')
      return tydroRpcBatch(INK_RPC_SECONDARY, batch)
    })(),
    fetch(MERKL_URL, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    }).then(r => r.ok ? r.json() : null).catch(() => null),
  ])

  // Slot [5] of getReserveData tuple = liquidityRate in RAY (1e27)
  const supplyAprs = new Map<string, number>()
  if (rpcResults.status === 'fulfilled' && Array.isArray(rpcResults.value)) {
    for (const item of rpcResults.value) {
      const reserve = TYDRO_RESERVES[item.id]
      if (!reserve || !item.result || item.result === '0x' || item.result.length < 130) continue
      try {
        const hex           = item.result.slice(2)
        const liquidityRate = BigInt('0x' + hex.slice(5 * 64, 6 * 64))
        const apr           = Number(liquidityRate) / 1e27 * 100
        if (apr > 0) supplyAprs.set(reserve.address.toLowerCase(), apr)
      } catch { /* skip malformed */ }
    }
  } else {
    console.error('[best-aprs] Tydro on-chain failed (both RPCs):',
      rpcResults.status === 'rejected' ? rpcResults.reason : 'null from both RPCs')
  }
  console.log(`[best-aprs] Tydro: ${supplyAprs.size}/${TYDRO_RESERVES.length} reserves with supply APR`)

  // Merkl: additional incentive APR per reserve token address
  const merklAprs = new Map<string, number>()
  if (merklRes.status === 'fulfilled' && Array.isArray(merklRes.value)) {
    for (const opp of (merklRes.value as any[])) {
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

// ─── Curve on Ink: DefiLlama ─────────────────────────────────────────────────
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
const SOFT_TTL = 3 * 60 * 1000  // 3 min (ms) — stale threshold
const HARD_TTL = 10 * 60        // 10 min (s)  — KV expiry

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

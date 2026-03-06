import { NextRequest, NextResponse } from 'next/server'
import { INK_RPC, rpcBatch } from '@/lib/ink'
import { getAllPrices } from '@/lib/priceService'

export const revalidate = 0

// ─── RPC helpers ─────────────────────────────────────────────────────────────
function ethCall(to: string, data: string, id: number) {
  return { jsonrpc: '2.0', id, method: 'eth_call', params: [{ to, data }, 'latest'] }
}
function decodeUint(hex: string): bigint {
  if (!hex || hex === '0x') return 0n
  try { return BigInt(hex.startsWith('0x') ? hex : '0x' + hex) } catch { return 0n }
}
function balanceOfData(addr: string): string {
  return '0x70a08231' + addr.slice(2).toLowerCase().padStart(64, '0')
}

// ─── Token metadata (address → symbol/decimals) ─────────────────────────────
const TOKEN_INFO: Record<string, { symbol: string; decimals: number }> = {
  '0x4200000000000000000000000000000000000006': { symbol: 'WETH',    decimals: 18 },
  '0xf1815bd50389c46847f0bda824ec8da914045d14': { symbol: 'USDC.e',  decimals: 6  },
  '0x0200c29006150606b650577bbe7b6248f58470c1': { symbol: 'USDT0',   decimals: 6  },
  '0x39fec550cc6ddced810eccfa9b2931b4b5f2344d': { symbol: 'crvUSD',  decimals: 18 },
  '0x80eede496655fb9047dd39d9f418d5483ed600df': { symbol: 'frxUSD',  decimals: 18 },
  '0x43edd7f3831b08fe70b7555ddd373c8bf65a9050': { symbol: 'frxETH',  decimals: 18 },
  '0x3ec3849c33291a9ef4c5db86de593eb4a37fde45': { symbol: 'sfrxETH', decimals: 18 },
  '0xac73671a1762fe835208fb93b7ae7490d1c2ccb3': { symbol: 'CRV',     decimals: 18 },
  '0x64445f0aecc51e94ad52d8ac56b7190e764e561a': { symbol: 'FXS',     decimals: 18 },
}

// CoinGecko price mapping
const COINGECKO_IDS: Record<string, string> = {
  WETH: 'ethereum', ETH: 'ethereum',
  sfrxETH: 'staked-frax-ether', frxETH: 'frax-ether',
  CRV: 'curve-dao-token', FXS: 'frax-share',
  WBTC: 'wrapped-bitcoin', kBTC: 'wrapped-bitcoin',
  'USDC.e': 'usd-coin', USDC: 'usd-coin',
  USDT0: 'tether', crvUSD: 'crvusd',
  INK: 'ink', GHO: 'gho',
}
const STABLES = new Set([
  'USDC', 'USDC.e', 'USDT0', 'USDT', 'crvUSD', 'DAI', 'USDG', 'GHO',
  'frxUSD', 'sfrxUSD', 'BUSD', 'TUSD', 'LUSD',
])

async function getTokenPricesUSD(symbols: string[]): Promise<Record<string, number>> {
  const prices: Record<string, number> = {}
  for (const s of symbols) if (STABLES.has(s)) prices[s] = 1
  const toFetch = symbols.filter(s => prices[s] === undefined)
  if (!toFetch.length) return prices
  try {
    // Use centralized priceService (shared KV cache, no extra CoinGecko call)
    const allPrices = await getAllPrices()
    for (const sym of toFetch) {
      const id = COINGECKO_IDS[sym]
      if (id && allPrices[id]?.usd) prices[sym] = allPrices[id].usd
    }
  } catch { /* return what we have */ }
  return prices
}

// ═══════════════════════════════════════════════════════════════════════════════
// TYDRO — Aave V3 fork on Ink
// ═══════════════════════════════════════════════════════════════════════════════
const TYDRO_POOL_PROVIDER = '0x4172E6aAEC070ACB31aaCE343A58c93E4C70f44D'
const TYDRO_DATA_PROVIDER = '0x96086C25d13943C80Ff9a19791a40Df6aFC08328'

async function fetchTydro(user: string): Promise<any[]> {
  try {
    // Step 1: Get Pool address from PoolAddressesProvider.getPool()
    const [poolRes] = await rpcBatch([ethCall(TYDRO_POOL_PROVIDER, '0x026b1d5f', 1)])
    const poolHex = poolRes?.result
    if (!poolHex || poolHex === '0x' || poolHex.length < 42) return []
    const poolAddress = '0x' + poolHex.slice(2).slice(-40).toLowerCase()

    // Step 2: Get reserves from Pool.getReservesList()
    const [reservesRes] = await rpcBatch([ethCall(poolAddress, '0xd1946dbc', 2)])
    if (!reservesRes?.result || reservesRes.result === '0x') return []

    // Decode address[] (ABI-encoded dynamic array)
    const hex = reservesRes.result.slice(2)
    const offset = Number(BigInt('0x' + hex.slice(0, 64)))
    const count  = Number(BigInt('0x' + hex.slice(offset * 2, offset * 2 + 64)))
    if (count === 0 || count > 50) return []

    const reserves: string[] = []
    for (let i = 0; i < count; i++) {
      const start = (offset + 1 + i) * 64
      reserves.push(('0x' + hex.slice(start + 24, start + 64)).toLowerCase())
    }

    // Step 3: Batch — getUserAccountData + getUserReserveData for each reserve
    //   + symbol()/decimals() for tokens not in TOKEN_INFO
    const userPadded = user.slice(2).toLowerCase().padStart(64, '0')
    const calls: any[] = [
      // Pool.getUserAccountData(user) → id=100
      ethCall(poolAddress, '0xbf92857c' + userPadded, 100),
    ]
    // ProtocolDataProvider.getUserReserveData(asset, user) → id=200+i
    for (let i = 0; i < reserves.length; i++) {
      const assetPad = reserves[i].slice(2).padStart(64, '0')
      calls.push(ethCall(TYDRO_DATA_PROVIDER, '0x28dd2d01' + assetPad + userPadded, 200 + i))
    }
    // For unknown tokens, fetch symbol() and decimals()
    const unknowns = reserves.filter(r => !TOKEN_INFO[r])
    for (let i = 0; i < unknowns.length; i++) {
      calls.push(ethCall(unknowns[i], '0x95d89b41', 300 + i * 2))   // symbol()
      calls.push(ethCall(unknowns[i], '0x313ce567', 301 + i * 2))   // decimals()
    }
    const allRes = await rpcBatch(calls, 12_000)

    // Resolve unknown tokens
    for (let i = 0; i < unknowns.length; i++) {
      const symR = allRes.find((r: any) => r.id === 300 + i * 2)
      const decR = allRes.find((r: any) => r.id === 301 + i * 2)
      if (symR?.result && symR.result.length > 130 && decR?.result) {
        try {
          const sh  = symR.result.slice(2)
          const off = Number(BigInt('0x' + sh.slice(0, 64))) * 2
          const len = Number(BigInt('0x' + sh.slice(off, off + 64)))
          const sym = Buffer.from(sh.slice(off + 64, off + 64 + len * 2), 'hex').toString('utf8').replace(/\0/g, '')
          const dec = Number(decodeUint(decR.result))
          if (sym && dec >= 0 && dec <= 18) TOKEN_INFO[unknowns[i]] = { symbol: sym, decimals: dec }
        } catch { /* skip */ }
      }
    }

    // Parse getUserAccountData (6 × 32 bytes)
    // [totalCollateralBase, totalDebtBase, availableBorrowsBase, liqThreshold, ltv, healthFactor]
    // Base currency = USD with 8 decimals
    const acctRes = allRes.find((r: any) => r.id === 100)
    let totalCollateralUSD = 0, totalDebtUSD = 0, healthFactor: number | null = null
    if (acctRes?.result && acctRes.result.length >= 2 + 6 * 64) {
      const d = acctRes.result.slice(2)
      totalCollateralUSD = Number(BigInt('0x' + d.slice(0, 64)))   / 1e8
      totalDebtUSD       = Number(BigInt('0x' + d.slice(64, 128))) / 1e8
      const hf = BigInt('0x' + d.slice(320, 384))
      healthFactor = hf > 0n && hf < BigInt('0xffffffffffffffffffffff') ? Number(hf) / 1e18 : null
    }

    // Quick exit if user has no position
    if (totalCollateralUSD < 0.01 && totalDebtUSD < 0.01) return []

    // Parse per-reserve getUserReserveData (9 values × 32 bytes)
    // [aTokenBal, stableDebt, varDebt, prinStable, scaledVar, stableRate, liquidityRate, lastUpdate, usedAsCollateral]
    const supply: any[] = []
    const borrow: any[] = []
    const symbolsForPrice: string[] = []

    for (let i = 0; i < reserves.length; i++) {
      const r = allRes.find((x: any) => x.id === 200 + i)
      if (!r?.result || r.result === '0x' || r.result.length < 2 + 9 * 64) continue
      const d = r.result.slice(2)

      const aTokenBal   = BigInt('0x' + d.slice(0,  64))
      const stableDebt  = BigInt('0x' + d.slice(64, 128))
      const varDebt     = BigInt('0x' + d.slice(128, 192))
      const liqRate     = BigInt('0x' + d.slice(384, 448))

      const info = TOKEN_INFO[reserves[i]] ?? { symbol: reserves[i].slice(0, 8), decimals: 18 }
      const dec  = Math.pow(10, info.decimals)

      const supAmt  = Number(aTokenBal)  / dec
      const debtAmt = (Number(stableDebt) + Number(varDebt)) / dec
      const supApy  = Number(liqRate) / 1e27 * 100  // RAY → %

      if (supAmt > 0.001) {
        supply.push({ symbol: info.symbol, amount: supAmt, amountUSD: 0, apy: Math.round(supApy * 100) / 100 })
        if (!symbolsForPrice.includes(info.symbol)) symbolsForPrice.push(info.symbol)
      }
      if (debtAmt > 0.001) {
        borrow.push({ symbol: info.symbol, amount: debtAmt, amountUSD: 0, apr: 0 })
        if (!symbolsForPrice.includes(info.symbol)) symbolsForPrice.push(info.symbol)
      }
    }

    // Fill USD amounts from CoinGecko prices
    const prices = await getTokenPricesUSD(symbolsForPrice)
    for (const s of supply) s.amountUSD = s.amount * (prices[s.symbol] ?? 0)
    for (const b of borrow) b.amountUSD = b.amount * (prices[b.symbol] ?? 0)

    const tokens = [...new Set([...supply.map(s => s.symbol), ...borrow.map(b => b.symbol)])]
    return [{
      protocol: 'Tydro', type: 'lending',
      logo: 'https://icons.llamao.fi/icons/protocols/tydro?w=48&h=48',
      url: 'https://app.tydro.com', chain: 'Ink',
      label: tokens.join(' / ') || 'Tydro Lending',
      supply, collateral: [], borrow,
      totalCollateralUSD, totalDebtUSD,
      netValueUSD: totalCollateralUSD - totalDebtUSD,
      healthFactor,
    }]
  } catch (e) { console.error('[defi] Tydro error:', e); return [] }
}

// ═══════════════════════════════════════════════════════════════════════════════
// VELODROME — AMM LP positions on Ink (v2 pools only; CL/v3 requires NFT enum)
// ═══════════════════════════════════════════════════════════════════════════════
const VELO_VOTER  = '0x97cDBCe21B6fd0585d29E539B1B99dAd328a1123'
const GECKO_BASE  = 'https://api.geckoterminal.com/api/v2'
const VELO_DEXES  = ['velodrome-finance-v2-ink', 'velodrome-finance-slipstream-ink']

async function fetchVelodrome(user: string): Promise<any[]> {
  try {
    // Step 1: Fetch Velodrome pools from GeckoTerminal
    interface PoolMeta { address: string; base: string; quote: string; tvl: number; isCL: boolean }
    const pools: PoolMeta[] = []

    const fetches = VELO_DEXES.map(dex =>
      fetch(`${GECKO_BASE}/networks/ink/dexes/${dex}/pools?page=1&sort=h24_volume_usd_desc`, {
        signal: AbortSignal.timeout(10_000), headers: { Accept: 'application/json' },
      }).then(r => r.ok ? r.json() : null).catch(() => null),
    )
    const results = await Promise.all(fetches)
    for (const json of results) {
      for (const p of json?.data ?? []) {
        const addr = p.attributes?.address
        if (!addr) continue
        const tvl = parseFloat(p.attributes?.reserve_in_usd ?? '0')
        if (tvl < 100) continue
        const base  = p.relationships?.base_token?.data?.id?.split('_').pop()?.toUpperCase()  ?? ''
        const quote = p.relationships?.quote_token?.data?.id?.split('_').pop()?.toUpperCase() ?? ''
        const name  = (p.attributes?.name ?? '').toLowerCase()
        const isCL  = name.includes('cl') || name.includes('concentrated') || name.includes('-0.')
        // Skip CL pools — those are NFT-based, not ERC20 LP
        if (isCL) continue
        pools.push({ address: addr.toLowerCase(), base, quote, tvl, isCL })
      }
    }
    if (pools.length === 0) return []

    // Step 2: Get gauge addresses from Voter.gauges(pool) for all pools
    const gaugeCalls = pools.map((p, i) =>
      ethCall(VELO_VOTER, '0xa7e60a4b' + p.address.slice(2).padStart(64, '0'), i),
    )
    const gaugeResults = await rpcBatch(gaugeCalls, 12_000)

    const ZERO_ADDR = '0x' + '0'.repeat(40)
    const gaugeMap = new Map<string, string>() // pool → gauge
    for (let i = 0; i < pools.length; i++) {
      const g = gaugeResults.find((r: any) => r.id === i)
      if (!g?.result || g.result === '0x') continue
      const gaugeAddr = ('0x' + g.result.slice(2).slice(-40)).toLowerCase()
      if (gaugeAddr !== ZERO_ADDR) gaugeMap.set(pools[i].address, gaugeAddr)
    }

    // Step 3: Batch balanceOf(user) for pool LP tokens + gauge contracts
    const balCalls: any[] = []
    const balMap: { idx: number; pool: PoolMeta; source: 'lp' | 'gauge' }[] = []
    let idx = 0
    for (const p of pools) {
      // LP token balance (unstaked)
      balCalls.push(ethCall(p.address, balanceOfData(user), idx))
      balMap.push({ idx, pool: p, source: 'lp' })
      idx++
      // Gauge balance (staked)
      const gauge = gaugeMap.get(p.address)
      if (gauge) {
        balCalls.push(ethCall(gauge, balanceOfData(user), idx))
        balMap.push({ idx, pool: p, source: 'gauge' })
        idx++
      }
    }
    const balResults = await rpcBatch(balCalls, 12_000)

    // Aggregate balances per pool (LP + gauge)
    const userBalances = new Map<string, bigint>()
    for (const { idx: id, pool } of balMap) {
      const r = balResults.find((x: any) => x.id === id)
      const bal = decodeUint(r?.result ?? '0x')
      if (bal > 0n) {
        userBalances.set(pool.address, (userBalances.get(pool.address) ?? 0n) + bal)
      }
    }
    if (userBalances.size === 0) return []

    // Step 4: Fetch totalSupply for pools where user has balance
    const activePools = pools.filter(p => userBalances.has(p.address))
    const tsCalls = activePools.map((p, i) =>
      ethCall(p.address, '0x18160ddd', 500 + i), // totalSupply()
    )
    const tsResults = await rpcBatch(tsCalls)

    // Step 5: Build positions — userShare = userBal / totalSupply × TVL
    const positions: any[] = []
    for (let i = 0; i < activePools.length; i++) {
      const p  = activePools[i]
      const ts = decodeUint(tsResults.find((r: any) => r.id === 500 + i)?.result ?? '0x')
      if (ts === 0n) continue
      const userBal = userBalances.get(p.address) ?? 0n
      const share   = Number(userBal) / Number(ts)
      const usdVal  = share * p.tvl
      if (usdVal < 0.01) continue

      positions.push({
        protocol: 'Velodrome', type: 'liquidity',
        logo: 'https://icons.llamao.fi/icons/protocols/velodrome-v2?w=48&h=48',
        url: 'https://velodrome.finance/liquidity?chain=57073', chain: 'Ink',
        label: `${p.base}/${p.quote}`,
        tokens: [p.base, p.quote].filter(Boolean),
        amountUSD: usdVal, apy: 0,
        netValueUSD: usdVal, inRange: null,
      })
    }
    return positions
  } catch (e) { console.error('[defi] Velodrome error:', e); return [] }
}

// ═══════════════════════════════════════════════════════════════════════════════
// INKYSWAP — AMM LP positions on Ink
// ═══════════════════════════════════════════════════════════════════════════════
const INKY_API = 'https://inkyswap.com/api'

async function fetchInkySwap(user: string): Promise<any[]> {
  try {
    // Step 1: Get all pairs from InkySwap API
    const res = await fetch(`${INKY_API}/pairs`, {
      signal: AbortSignal.timeout(10_000), headers: { Accept: 'application/json' },
    })
    if (!res.ok) return []
    const raw = await res.json()
    const pairs: any[] = Array.isArray(raw) ? raw : (raw?.pairs ?? raw?.data ?? [])
    if (pairs.length === 0) return []

    // Extract pair addresses + metadata
    interface PairMeta { address: string; base: string; quote: string; tvl: number; apr: number }
    const pairList: PairMeta[] = []
    for (const p of pairs) {
      const addr = (p.pair_address ?? p.address ?? '').toLowerCase()
      if (!addr || !addr.startsWith('0x')) continue
      const tvl = parseFloat(p.liquidity_usd ?? p.tvl ?? '0')
      if (tvl < 50) continue
      pairList.push({
        address: addr,
        base:  p.token0?.symbol ?? '',
        quote: p.token1?.symbol ?? '',
        tvl,
        apr: parseFloat(p.apr ?? '0'),
      })
    }
    if (pairList.length === 0) return []

    // Step 2: Batch balanceOf(user) for all pair LP tokens
    const balCalls = pairList.map((p, i) => ethCall(p.address, balanceOfData(user), i))
    const balResults = await rpcBatch(balCalls, 12_000)

    // Filter to pairs where user has balance
    const active: { pair: PairMeta; balance: bigint }[] = []
    for (let i = 0; i < pairList.length; i++) {
      const bal = decodeUint(balResults.find((r: any) => r.id === i)?.result ?? '0x')
      if (bal > 0n) active.push({ pair: pairList[i], balance: bal })
    }
    if (active.length === 0) return []

    // Step 3: Fetch totalSupply for active pairs
    const tsCalls = active.map((a, i) => ethCall(a.pair.address, '0x18160ddd', 500 + i))
    const tsResults = await rpcBatch(tsCalls)

    // Step 4: Build positions
    const positions: any[] = []
    for (let i = 0; i < active.length; i++) {
      const ts = decodeUint(tsResults.find((r: any) => r.id === 500 + i)?.result ?? '0x')
      if (ts === 0n) continue
      const { pair, balance } = active[i]
      const share  = Number(balance) / Number(ts)
      const usdVal = share * pair.tvl
      if (usdVal < 0.01) continue

      positions.push({
        protocol: 'InkySwap', type: 'liquidity',
        logo: 'https://icons.llamao.fi/icons/protocols/inkyswap?w=48&h=48',
        url: 'https://inkyswap.com/liquidity', chain: 'Ink',
        label: `${pair.base}/${pair.quote}`,
        tokens: [pair.base, pair.quote].filter(Boolean),
        amountUSD: usdVal, apy: pair.apr > 0 ? pair.apr : 0,
        netValueUSD: usdVal, inRange: null,
      })
    }
    return positions
  } catch (e) { console.error('[defi] InkySwap error:', e); return [] }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CURVE — LP positions on Ink (kept from existing, confirmed working)
// ═══════════════════════════════════════════════════════════════════════════════
async function fetchCurve(user: string): Promise<any[]> {
  const BASE = 'https://api-core.curve.finance/v1'
  const addr = user.toLowerCase()
  const paddedAddr = addr.slice(2).padStart(64, '0')

  // Step 1: Fetch pool lists + block number in parallel
  const poolTypes = ['factory-twocrypto', 'factory-stable-ng']
  const [bnRes, ...poolFetches] = await Promise.all([
    fetch(INK_RPC, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'eth_blockNumber', params: [] }),
      signal: AbortSignal.timeout(4_000),
    }).then(r => r.json()).catch(() => ({ result: '0x0' })),
    ...poolTypes.map(t =>
      fetch(`${BASE}/getPools/ink/${t}`, { signal: AbortSignal.timeout(8_000), cache: 'no-store' })
        .then(r => r.ok ? r.json() : null).catch(() => null),
    ),
  ])
  const currentBlock = Number(BigInt(bnRes?.result ?? '0x0'))
  const fromBlock24h = '0x' + Math.max(0, currentBlock - 195_000).toString(16)

  const allPools: any[] = []
  for (const data of poolFetches) allPools.push(...(data?.data?.poolData ?? []))
  if (allPools.length === 0) return []

  // Step 2: Batch balanceOf + fee() + 24h trade logs
  const TE_CLASSIC = '0x8b3e96f2b889fa771c53c981b40daf005f63f637f1869f707052d15a3dd97140'
  const TE_NG      = '0x143f1f8e861fbdeddd5b46e844b7d3ac7b86a122f36e8c463859ee6811b1f29c'

  const balanceCalls = allPools.map((pool, i) => ({
    jsonrpc: '2.0', id: i, method: 'eth_call',
    params: [{ to: pool.lpTokenAddress ?? pool.address, data: '0x70a08231' + paddedAddr }, 'latest'],
  }))
  const feeCalls = allPools.map((pool, i) => ({
    jsonrpc: '2.0', id: i + 1000, method: 'eth_call',
    params: [{ to: pool.address, data: '0xddca3f43' }, 'latest'],
  }))

  const [rpcRes, feeRes, logsRes] = await Promise.all([
    rpcBatch(balanceCalls, 10_000),
    rpcBatch(feeCalls, 8_000),
    rpcBatch([{
      jsonrpc: '2.0', id: 9999, method: 'eth_getLogs',
      params: [{ fromBlock: fromBlock24h, toBlock: 'latest',
        address: allPools.map(p => p.address), topics: [[TE_CLASSIC, TE_NG]] }],
    }], 15_000),
  ])

  // 24h volume per pool
  const logs: any[] = logsRes.find((r: any) => r.id === 9999)?.result ?? []
  const volumeByPool: Record<string, number> = {}
  for (const log of logs) {
    const poolAddr = log.address?.toLowerCase()
    const pool = allPools.find(p => p.address.toLowerCase() === poolAddr)
    if (!pool) continue
    try {
      const data = log.data?.slice(2) ?? ''
      if (data.length < 128) continue
      const soldId     = Number(BigInt('0x' + data.slice(0, 64)))
      const tokensSold = BigInt('0x' + data.slice(64, 128))
      const decimals   = Number(pool.coins?.[soldId]?.decimals ?? 18)
      volumeByPool[poolAddr] = (volumeByPool[poolAddr] ?? 0) + Number(tokensSold) / Math.pow(10, decimals)
    } catch { /* skip */ }
  }

  // APR per pool: (vol24h × feeRate × 365) / TVL × 100
  const aprByPool: Record<string, number> = {}
  allPools.forEach((pool, i) => {
    const tvl = Number(pool.usdTotalExcludingBasePool ?? pool.usdTotal ?? 0)
    if (tvl <= 0) return
    const feeRaw  = decodeUint(feeRes.find((r: any) => r.id === i + 1000)?.result ?? '0x')
    const feeRate = Number(feeRaw) / 1e10
    const vol24h  = volumeByPool[pool.address?.toLowerCase()] ?? 0
    if (vol24h > 0 && feeRate > 0)
      aprByPool[pool.address?.toLowerCase()] = (vol24h * feeRate * 365 / tvl) * 100
  })

  // Step 3: Build positions for pools where user has LP balance
  const positions: any[] = []
  for (let i = 0; i < allPools.length; i++) {
    const result = rpcRes.find((r: any) => r.id === i)?.result ?? '0x'
    if (!result || result === '0x' || result === '0x' + '0'.repeat(64)) continue
    const balanceRaw = BigInt(result)
    if (balanceRaw === 0n) continue

    const pool = allPools[i]
    const totalSupplyRaw = BigInt(pool.totalSupply ?? '0')
    const lpPrice = Number(pool.lpTokenPrice ?? 0)
    const userBalFloat = Number(balanceRaw) / 1e18
    const netValueUSD = lpPrice > 0
      ? userBalFloat * lpPrice
      : totalSupplyRaw > 0n
        ? (Number(balanceRaw) / Number(totalSupplyRaw)) * Number(pool.usdTotalExcludingBasePool ?? pool.usdTotal ?? 0)
        : 0
    if (netValueUSD < 0.01) continue

    const coins  = pool.coins?.map((c: any) => c.symbol) ?? []
    const poolId = pool.id ?? pool.address
    positions.push({
      protocol: 'Curve', type: 'liquidity',
      logo: 'https://icons.llamao.fi/icons/protocols/curve-dex?w=48&h=48',
      url: `https://curve.finance/dex/ink/pools/${poolId}/deposit`, chain: 'Ink',
      label: pool.name ?? coins.join('/'),
      tokens: coins,
      amountUSD: netValueUSD,
      apy: aprByPool[pool.address?.toLowerCase()] ?? 0,
      netValueUSD, inRange: null,
    })
  }
  return positions
}

// ═══════════════════════════════════════════════════════════════════════════════
// NADO — NLP Vault position (on-chain balanceOf + Nado API for oracle price)
// ═══════════════════════════════════════════════════════════════════════════════
const NLP_TOKEN    = '0xf9e0af5e093c6ff7d75983414826462fc4abe430'
const NADO_LOGO    = '/nado-logo.jpg'
const NADO_GATEWAY = 'https://gateway.prod.nado.xyz/v1'

async function fetchNado(user: string): Promise<any[]> {
  try {
    // Step 1: Check user's NLP token balance on-chain (simple balanceOf)
    const [balRes] = await rpcBatch([ethCall(NLP_TOKEN, balanceOfData(user), 900)])
    const nlpBalance = decodeUint(balRes?.result ?? '0x')
    if (nlpBalance === 0n) return []

    // Step 2: Get NLP oracle price from Nado API
    let nlpPrice = 1.0 // fallback: ~$1 per NLP
    try {
      const res = await fetch(`${NADO_GATEWAY}/query?type=nlp_pool_info`, {
        headers: { Accept: 'application/json', 'Accept-Encoding': 'gzip' },
        signal: AbortSignal.timeout(8_000),
      })
      if (res.ok) {
        const json = await res.json()
        const pools = json?.data?.nlp_pools ?? []
        for (const pool of pools) {
          const products = pool.subaccount_info?.spot_products ?? []
          for (const sp of products) {
            if (sp.product_id === 11) {
              nlpPrice = parseFloat(sp.oracle_price_x18 ?? '0') / 1e18
              break
            }
          }
          if (nlpPrice > 0 && nlpPrice !== 1.0) break
        }
      }
    } catch { /* use fallback price */ }

    // Step 3: Calculate USD value
    const nlpTokens = Number(nlpBalance) / 1e18
    const usdValue  = nlpTokens * nlpPrice
    if (usdValue < 0.01) return []

    return [{
      protocol: 'Nado', type: 'vault',
      logo: NADO_LOGO,
      url: 'https://app.nado.xyz/vault', chain: 'Ink',
      label: 'NLP Vault (USDT0)',
      tokens: ['USDT0'],
      amountUSD: usdValue, apy: 0,
      netValueUSD: usdValue, inRange: null,
    }]
  } catch (e) { console.error('[defi] Nado error:', e); return [] }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN — 5 protocols in parallel
// ═══════════════════════════════════════════════════════════════════════════════
export async function GET(req: NextRequest) {
  const address = req.nextUrl.searchParams.get('address')
  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address))
    return NextResponse.json({ error: 'Invalid address' }, { status: 400 })

  const [tydroR, veloR, inkyR, curveR, nadoR] = await Promise.allSettled([
    fetchTydro(address),
    fetchVelodrome(address),
    fetchInkySwap(address),
    fetchCurve(address),
    fetchNado(address),
  ])

  function unwrap(r: PromiseSettledResult<any[]>): any[] {
    return r.status === 'fulfilled' ? r.value : []
  }

  const allPositions = [
    ...unwrap(tydroR), ...unwrap(veloR),
    ...unwrap(inkyR),  ...unwrap(curveR),
    ...unwrap(nadoR),
  ]

  const totalNetValueUSD = allPositions.reduce((s, p) => s + (p.netValueUSD ?? 0), 0)
  const totalDebtUSD     = allPositions.reduce((s, p) => s + (p.totalDebtUSD ?? 0), 0)
  const totalSupplyUSD   = allPositions.reduce((s, p) => s + (p.totalCollateralUSD ?? p.amountUSD ?? 0), 0)
  const activeProtocols  = [...new Set(allPositions.map(p => p.protocol))]

  return NextResponse.json({
    positions: allPositions,
    summary: { totalNetValueUSD, totalDebtUSD, totalSupplyUSD, netValueUSD: totalNetValueUSD, activeProtocols },
  })
}

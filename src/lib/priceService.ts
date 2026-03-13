/**
 * priceService.ts — Centralized CoinGecko price fetcher.
 *
 * ONE call fetches prices for every known Ink token + VELO + ETH,
 * cached in KV for 5 minutes. All routes consume from this shared cache.
 */

import { kvGet, kvSet } from '@/lib/kvCache'

// ─── All CoinGecko IDs used across the project ────────────────────────────────
const ALL_PRICE_IDS = [
  'ethereum',
  'weth',
  'usd-coin',
  'tether',
  'crvusd',
  'frax',
  'staked-frax',
  'frax-ether',
  'staked-frax-ether',
  'curve-dao-token',
  'frax-share',
  'velodrome-finance',
  'wrapped-bitcoin',
] as const

type CoinId = string
export interface PriceEntry {
  usd:             number
  usd_24h_change?: number
}
export type PriceMap = Record<CoinId, PriceEntry>

// ─── Cache config ──────────────────────────────────────────────────────────────
// SOFT_TTL increased from 60s → 5min: price data this fresh is more than adequate
// for a DeFi dashboard, and reduces CoinGecko calls by 5×.
const CACHE_KEY = 'cg-prices'
const SOFT_TTL  = 5 * 60 * 1000  // 5 minutes (ms) — fresh window
const HARD_TTL  = 15 * 60        // 15 minutes (seconds) — stale fallback window

let inflight: Promise<PriceMap> | null = null

// ─── Fetcher ──────────────────────────────────────────────────────────────────
async function fetchFromCoinGecko(): Promise<PriceMap> {
  const apiKey  = process.env.COINGECKO_API_KEY
  const headers: Record<string, string> = { 'Accept': 'application/json' }
  if (apiKey) headers['x-cg-demo-api-key'] = apiKey

  const ids = ALL_PRICE_IDS.join(',')
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`

  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`)

  const raw = await res.json()
  const out: PriceMap = {}
  for (const [id, data] of Object.entries(raw as Record<string, any>)) {
    out[id] = {
      usd:            data?.usd ?? 0,
      usd_24h_change: data?.usd_24h_change,
    }
  }
  return out
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Get prices for ALL known Ink ecosystem tokens in one shot.
 * Cached in KV for 5 minutes; stale data returned on upstream failure.
 */
export async function getAllPrices(): Promise<PriceMap> {
  const cached = await kvGet<PriceMap>(CACHE_KEY, SOFT_TTL)
  if (cached.data && cached.fresh) return cached.data

  if (inflight) return inflight

  inflight = (async () => {
    try {
      const prices = await fetchFromCoinGecko()
      await kvSet(CACHE_KEY, prices, HARD_TTL)
      return prices
    } catch (e) {
      console.error('[priceService] CoinGecko error:', e)
      if (cached.data) return cached.data
      return {}
    } finally {
      inflight = null
    }
  })()

  return inflight
}

/** Convenience: get a single coin price. */
export async function getPrice(coinId: string): Promise<number> {
  const prices = await getAllPrices()
  return prices[coinId]?.usd ?? 0
}

/** Convenience: get ETH price + 24h change. */
export async function getEthPriceFromService(): Promise<{
  price: number; change24h: number; changeAmount: number
}> {
  const prices = await getAllPrices()
  const eth    = prices['ethereum']
  const price     = eth?.usd ?? 0
  const change24h = eth?.usd_24h_change ?? 0
  const prevPrice = price / (1 + change24h / 100)
  return { price, change24h, changeAmount: price - prevPrice }
}

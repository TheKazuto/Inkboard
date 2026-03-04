import { NextRequest, NextResponse } from 'next/server'
import { KNOWN_TOKENS, rpcBatch, buildBalanceOfCall } from '@/lib/ink'
import { getAllPrices } from '@/lib/priceService'
import { kvGet, kvSet } from '@/lib/kvCache'

export const revalidate = 0

export async function GET(req: NextRequest) {
  const address = req.nextUrl.searchParams.get('address')

  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return NextResponse.json({ error: 'Invalid address' }, { status: 400 })
  }

  try {
    // ── 1. Fetch ETH native balance + all ERC-20 balances in parallel ──────────
    const erc20Calls = KNOWN_TOKENS.map((t) =>
      buildBalanceOfCall(t.contract, address)
    )
    const nativeCall = {
      jsonrpc: '2.0',
      method: 'eth_getBalance',
      params: [address, 'latest'],
      id: 'native',
    }

    // Batch native balance + all ERC-20 balanceOf in a single RPC request
    const allCalls = [nativeCall, ...erc20Calls]
    const allResults = await rpcBatch(allCalls)
    const nativeRes       = allResults[0]
    const erc20Responses  = allResults.slice(1)

    // ── 2. Parse raw balances ──────────────────────────────────────────────────
    const rawETH = nativeRes?.result
      ? Number(BigInt(nativeRes.result)) / 1e18
      : 0

    const tokenBalances = KNOWN_TOKENS.map((token, i) => {
      const raw = erc20Responses[i]?.result
      if (!raw || raw === '0x' || raw === '0x0') return { ...token, balance: 0 }
      const balance = Number(BigInt(raw)) / Math.pow(10, token.decimals)
      return { ...token, balance }
    })

    // ── 3. Prices from priceService + images from KV cache ─────────────────────
    const coinIds = [
      'ethereum', // ETH native
      ...KNOWN_TOKENS.map((t) => t.coingeckoId),
    ]

    let prices: Record<string, number> = {}
    let images: Record<string, string> = {}

    // Prices: from shared priceService (no extra CoinGecko call)
    try {
      const allPrices = await getAllPrices()
      for (const id of coinIds) {
        if (allPrices[id]?.usd) prices[id] = allPrices[id].usd
      }
    } catch { /* fallback below */ }

    // Images: cached separately with 1h TTL (they rarely change)
    const IMG_SOFT_TTL = 60 * 60 * 1000  // 1 hour
    const IMG_HARD_TTL = 4 * 60 * 60     // 4 hours
    const imgCached = await kvGet<Record<string, string>>('token-images', IMG_SOFT_TTL)
    if (imgCached.data) {
      images = imgCached.data
    } else {
      // Fetch images from /coins/markets (only when image cache is cold)
      try {
        const cgHeaders: Record<string, string> = { 'Accept': 'application/json' }
        const cgKey = process.env.COINGECKO_API_KEY
        if (cgKey) cgHeaders['x-cg-demo-api-key'] = cgKey
        const marketRes = await fetch(
          `https://api.coingecko.com/api/v3/coins/markets?ids=${coinIds.join(',')}&vs_currency=usd&per_page=20`,
          { headers: cgHeaders, next: { revalidate: 3600 } }
        )
        const marketData = await marketRes.json()
        if (Array.isArray(marketData)) {
          for (const coin of marketData) {
            if (coin.id && coin.image) images[coin.id] = coin.image
          }
          await kvSet('token-images', images, IMG_HARD_TTL)
        }
      } catch { /* use whatever we have */ }
    }

    // Fallback prices if priceService returned nothing
    if (!prices['ethereum']) {
      prices = {
        ethereum: 2000,
        'usd-coin': 1.0,
        weth: 2300,
        tether: 1.0,
        'wrapped-bitcoin': 85000,
        'agora-dollar': 1.0,
      }
    }

    // ── 4. Calculate USD values ────────────────────────────────────────────────
    const ethPrice = prices['ethereum'] ?? 2000
    const ethValue = rawETH * ethPrice

    const tokens: {
      symbol: string
      name: string
      balance: number
      price: number
      value: number
      color: string
      imageUrl: string
    }[] = []

    // Add ETH native
    if (rawETH > 0.0001) {
      tokens.push({
        symbol: 'ETH',
        name: 'Ether',
        balance: rawETH,
        price: ethPrice,
        value: ethValue,
        color: '#7C3AED',
        imageUrl: images['ethereum'] ?? '',
      })
    }

    // Add ERC-20 tokens with balance > dust
    for (const token of tokenBalances) {
      const price = prices[token.coingeckoId] ?? 0
      const value = token.balance * price
      if (token.balance > 0.0001 || value > 0.01) {
        tokens.push({
          symbol: token.symbol,
          name: token.name,
          balance: token.balance,
          price,
          value,
          color: token.color,
          imageUrl: images[token.coingeckoId] ?? '',
        })
      }
    }

    // ── 5. Sort by value desc + compute percentages ───────────────────────────
    tokens.sort((a, b) => b.value - a.value)
    const totalValue = tokens.reduce((sum, t) => sum + t.value, 0)

    const result = tokens.map((t) => ({
      ...t,
      percentage: totalValue > 0 ? (t.value / totalValue) * 100 : 0,
    }))

    return NextResponse.json({
      tokens: result,
      totalValue,
      address,
    })
  } catch (err) {
    console.error('[token-exposure] error:', err)
    return NextResponse.json({ error: 'Failed to fetch balances' }, { status: 500 })
  }
}

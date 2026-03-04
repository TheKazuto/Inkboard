import { NextRequest, NextResponse } from 'next/server'
import { KNOWN_TOKENS, rpcBatch, buildBalanceOfCall } from '@/lib/ink'

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

    // ── 3. Fetch prices + images from CoinGecko (free, no key) ────────────────
    const coinIds = [
      'ethereum', // ETH native
      ...KNOWN_TOKENS.map((t) => t.coingeckoId),
    ].join(',')

    let prices: Record<string, number> = {}
    let images: Record<string, string> = {}
    try {
      // /coins/markets returns both current_price and image in a single call —
      // no need for a separate /simple/price request (Fix #6).
      const cgHeaders: Record<string, string> = { 'Accept': 'application/json' }
      const cgKey = process.env.COINGECKO_API_KEY
      if (cgKey) cgHeaders['x-cg-demo-api-key'] = cgKey
      const marketRes = await fetch(
        `https://api.coingecko.com/api/v3/coins/markets?ids=${coinIds}&vs_currency=usd&per_page=20`,
        { headers: cgHeaders, next: { revalidate: 60 } }
      )
      const marketData = await marketRes.json()
      if (Array.isArray(marketData)) {
        for (const coin of marketData) {
          if (coin.id) {
            prices[coin.id] = coin.current_price ?? 0
            if (coin.image) images[coin.id] = coin.image
          }
        }
      }
    } catch {
      // fallback prices if CoinGecko fails
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

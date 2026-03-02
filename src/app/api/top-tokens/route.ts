import { NextResponse } from 'next/server'

export const revalidate = 60 // cache por 60 segundos

export async function GET() {
  try {
    // Fix #11 (MÉDIO): Renamed from NEXT_PUBLIC_COINGECKO_API_KEY to COINGECKO_API_KEY.
    // Variables prefixed with NEXT_PUBLIC_ are embedded in the client-side JS bundle,
    // exposing the API key to any visitor. Server-only routes must NOT use NEXT_PUBLIC_.
    // Update your .env.local and Vercel env vars accordingly.
    const apiKey = process.env.COINGECKO_API_KEY
    const headers: Record<string, string> = {
      'Accept': 'application/json',
    }
    if (apiKey) headers['x-cg-demo-api-key'] = apiKey

    const res = await fetch(
      'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&category=ink-ecosystem&order=market_cap_desc&per_page=10&page=1&sparkline=false&price_change_percentage=24h',
      { headers, next: { revalidate: 60 } }
    )

    if (!res.ok) {
      return NextResponse.json({ error: 'CoinGecko error', status: res.status }, { status: res.status })
    }

    const data = await res.json()
    return NextResponse.json(data)
  } catch (err) {
    return NextResponse.json({ error: 'Failed to fetch' }, { status: 500 })
  }
}

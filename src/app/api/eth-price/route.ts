import { NextResponse } from 'next/server'

// Cache on the server for 30 seconds — all clients share one upstream call
export const revalidate = 30

const COINGECKO_ID = 'ethereum'

export async function GET() {
  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${COINGECKO_ID}&vs_currencies=usd&include_24hr_change=true`,
      { next: { revalidate: 30 } }
    )

    if (!res.ok) throw new Error(`CoinGecko ${res.status}`)

    const json = await res.json()
    const data = json[COINGECKO_ID]

    if (!data) throw new Error('Token not in response')

    const price     = data.usd as number
    const change24h = (data.usd_24h_change ?? 0) as number
    const prevPrice = price / (1 + change24h / 100)

    return NextResponse.json({
      price,
      change24h,
      changeAmount: price - prevPrice,
    })
  } catch (err) {
    console.error('[eth-price]', err)
    return NextResponse.json({ error: 'Failed to fetch price' }, { status: 502 })
  }
}

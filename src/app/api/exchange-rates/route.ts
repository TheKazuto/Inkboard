import { NextResponse } from 'next/server'

export const revalidate = 3600 // Cache 1 hour server-side

export async function GET() {
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/USD', {
      next: { revalidate: 3600 },
    })

    if (!res.ok) throw new Error('fetch failed')

    const data = await res.json()

    if (data.result !== 'success') throw new Error('api error')

    return NextResponse.json({
      rates: {
        USD: 1,
        EUR: data.rates.EUR,
        BRL: data.rates.BRL,
      },
      updatedAt: data.time_last_update_utc,
    })
  } catch (e) {
    console.error('[exchange-rates] error:', e)
    // Fallback to approximate rates if API is unavailable
    return NextResponse.json({
      rates: { USD: 1, EUR: 0.92, BRL: 5.70 },
      updatedAt: null,
      fallback: true,
    })
  }
}

import { NextResponse } from 'next/server'
import { getEthPriceData } from '@/lib/ink'

// Cache on the server for 30 seconds — all clients share one upstream call
export const revalidate = 30

export async function GET() {
  try {
    const data = await getEthPriceData()
    if (!data.price) throw new Error('ETH price unavailable')
    return NextResponse.json(data)
  } catch (err) {
    console.error('[eth-price]', err)
    return NextResponse.json({ error: 'Failed to fetch price' }, { status: 502 })
  }
}

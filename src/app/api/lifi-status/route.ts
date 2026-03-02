import { NextRequest, NextResponse } from 'next/server'

export const revalidate = 0

const LIFI_API = 'https://li.quest/v1'

const ALLOWED_PARAMS = new Set(['bridge', 'fromChain', 'toChain', 'txHash'])

export async function GET(req: NextRequest) {
  const params = new URLSearchParams()
  for (const [key, val] of req.nextUrl.searchParams.entries()) {
    if (ALLOWED_PARAMS.has(key)) params.set(key, val)
  }

  if (!params.get('txHash')) {
    return NextResponse.json({ status: 'INVALID' }, { status: 400 })
  }

  try {
    const res = await fetch(`${LIFI_API}/status?${params}`, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10_000),
    })

    const data = await res.json()
    return NextResponse.json(data, { status: res.status })
  } catch (e: unknown) {
    console.error('[lifi-status]', e instanceof Error ? e.message : e)
    return NextResponse.json({ status: 'PENDING' }, { status: 502 })
  }
}

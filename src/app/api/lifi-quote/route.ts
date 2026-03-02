import { NextRequest, NextResponse } from 'next/server'

export const revalidate = 0

const LIFI_API = 'https://li.quest/v1'

// Allowlist of valid query parameter keys for the /quote endpoint
const ALLOWED_PARAMS = new Set([
  'fromChain', 'toChain', 'fromToken', 'toToken', 'fromAmount',
  'fromAddress', 'toAddress', 'slippage', 'integrator', 'fee',
  'allowBridges', 'denyBridges', 'allowExchanges', 'denyExchanges',
  'preferBridges', 'preferExchanges', 'order',
])

export async function GET(req: NextRequest) {
  // Forward only allowed params to LI.FI
  const params = new URLSearchParams()
  for (const [key, val] of req.nextUrl.searchParams.entries()) {
    if (ALLOWED_PARAMS.has(key)) params.set(key, val)
  }

  // Require minimum params
  if (!params.get('fromChain') || !params.get('fromToken') || !params.get('fromAmount')) {
    return NextResponse.json({ message: 'Missing required parameters' }, { status: 400 })
  }

  try {
    const res = await fetch(`${LIFI_API}/quote?${params}`, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(30_000),  // quotes can take a few seconds
    })

    const data = await res.json()

    if (!res.ok) {
      return NextResponse.json(data, { status: res.status })
    }

    return NextResponse.json(data)
  } catch (e: unknown) {
    console.error('[lifi-quote]', e instanceof Error ? e.message : e)
    return NextResponse.json({ message: 'Failed to fetch quote from LI.FI' }, { status: 502 })
  }
}

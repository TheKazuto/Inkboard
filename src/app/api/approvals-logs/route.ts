import { NextRequest, NextResponse } from 'next/server'

export const revalidate = 0

// Blockscout exposes an Etherscan-compatible API at /api
const BLOCKSCOUT_API = 'https://explorer.inkonchain.com/api'

/** topic must be exactly 0x + 64 hex chars (a 32-byte keccak hash) */
const TOPIC_RE = /^0x[0-9a-fA-F]{64}$/

/** block number: either a positive integer, hex, or the string "latest" */
const BLOCK_RE = /^(0x[0-9a-fA-F]+|[0-9]+|latest)$/

function validateTopic(v: string | null): v is string {
  return !!v && TOPIC_RE.test(v)
}

function validateBlock(v: string): boolean {
  return BLOCK_RE.test(v)
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl

  const chainId   = Number(searchParams.get('chainId'))
  const topic0    = searchParams.get('topic0') ?? ''
  const topic1    = searchParams.get('topic1') ?? ''
  const fromBlock = searchParams.get('fromBlock') ?? '0'
  const toBlock   = searchParams.get('toBlock')   ?? 'latest'

  // Only Ink supported
  if (chainId !== 57073) {
    return NextResponse.json({ status: '0', message: 'Unsupported chain', result: [] }, { status: 400 })
  }

  if (!validateTopic(topic0) || !validateTopic(topic1)) {
    return NextResponse.json({ status: '0', message: 'Invalid topic format', result: [] }, { status: 400 })
  }

  if (!validateBlock(fromBlock) || !validateBlock(toBlock)) {
    return NextResponse.json({ status: '0', message: 'Invalid block parameter', result: [] }, { status: 400 })
  }

  // ── Blockscout etherscan-compatible API (no API key needed) ────────────────
  const url = new URL(BLOCKSCOUT_API)
  url.searchParams.set('module',       'logs')
  url.searchParams.set('action',       'getLogs')
  url.searchParams.set('topic0',       topic0)
  url.searchParams.set('topic1',       topic1)
  url.searchParams.set('topic0_1_opr', 'and')
  url.searchParams.set('fromBlock',    fromBlock)
  url.searchParams.set('toBlock',      toBlock)

  try {
    const res  = await fetch(url.toString(), { cache: 'no-store', signal: AbortSignal.timeout(20_000) })
    const data = await res.json()
    return NextResponse.json(data)
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'unknown'
    console.error('[approvals-logs] error:', msg)
    return NextResponse.json({ status: '0', message: 'Upstream service error', result: [] }, { status: 502 })
  }
}

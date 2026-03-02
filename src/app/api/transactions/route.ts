import { NextRequest, NextResponse } from 'next/server'
import { INK_RPC as RPC } from '@/lib/ink'

export const revalidate = 0

// ─── Blockscout API base ────────────────────────────────────────────────────
const BLOCKSCOUT = 'https://explorer.inkonchain.com/api/v2'

// ─── Known token map for symbol resolution in RPC fallback ──────────────────
const TOKEN_MAP: Record<string, { symbol: string; decimals: number }> = {
  '0x4200000000000000000000000000000000000006': { symbol: 'WETH',    decimals: 18 },
  '0xf1815bd50389c46847f0bda824ec8da914045d14': { symbol: 'USDC.e',  decimals: 6  },
  '0x0200c29006150606b650577bbe7b6248f58470c1': { symbol: 'USDT0',   decimals: 6  },
  '0x39fec550cc6ddced810eccfa9b2931b4b5f2344d': { symbol: 'crvUSD',  decimals: 18 },
  '0x80eede496655fb9047dd39d9f418d5483ed600df': { symbol: 'frxUSD',  decimals: 18 },
  '0x5bff88ca1442c2496f7e475e9e7786383bc070c0': { symbol: 'sfrxUSD', decimals: 18 },
  '0x43edd7f3831b08fe70b7555ddd373c8bf65a9050': { symbol: 'frxETH',  decimals: 18 },
  '0x3ec3849c33291a9ef4c5db86de593eb4a37fde45': { symbol: 'sfrxETH', decimals: 18 },
  '0xac73671a1762fe835208fb93b7ae7490d1c2ccb3': { symbol: 'CRV',     decimals: 18 },
  '0x64445f0aecc51e94ad52d8ac56b7190e764e561a': { symbol: 'FXS',     decimals: 18 },
}

// ─── Helpers ────────────────────────────────────────────────────────────────
async function rpc(method: string, params: any[], id = 1) {
  const r = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id }),
    cache: 'no-store',
  })
  const d = await r.json()
  return d.result
}

export async function GET(req: NextRequest) {
  const address = req.nextUrl.searchParams.get('address')
  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return NextResponse.json({ error: 'Invalid address' }, { status: 400 })
  }

  const addrLower = address.toLowerCase()

  // ── PATH 1: Blockscout v2 API (primary — native Ink explorer) ─────────────
  try {
    const [txRes, tokenRes] = await Promise.all([
      fetch(`${BLOCKSCOUT}/addresses/${address}/transactions?filter=to%7Cfrom`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(12_000),
        headers: { 'Accept': 'application/json' },
      }),
      fetch(`${BLOCKSCOUT}/addresses/${address}/token-transfers?type=ERC-20`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(12_000),
        headers: { 'Accept': 'application/json' },
      }),
    ])

    if (txRes.ok || tokenRes.ok) {
      const txData    = txRes.ok    ? await txRes.json()    : { items: [] }
      const tokenData = tokenRes.ok ? await tokenRes.json() : { items: [] }

      const normalTxs = (txData.items ?? []).map((tx: any) => {
        const from = tx.from?.hash?.toLowerCase() ?? ''
        const val  = tx.value ?? '0'
        return {
          hash: tx.hash,
          type: from === addrLower ? 'send' : 'receive',
          from: tx.from?.hash ?? '',
          to:   tx.to?.hash ?? '',
          valueNative: (Number(val) / 1e18).toFixed(6),
          symbol: 'ETH',
          timestamp: tx.timestamp ? Math.floor(new Date(tx.timestamp).getTime() / 1000) : 0,
          isError: tx.status === 'error' || tx.result === 'error',
          isToken: false,
          functionName: tx.method ?? '',
        }
      })

      const tokenTxs = (tokenData.items ?? []).map((tx: any) => {
        const from     = tx.from?.hash?.toLowerCase() ?? ''
        const token    = tx.token ?? {}
        const decimals = Number(token.decimals ?? 18)
        const rawVal   = tx.total?.value ?? '0'
        return {
          hash: tx.tx_hash,
          type: from === addrLower ? 'send' : 'receive',
          from: tx.from?.hash ?? '',
          to:   tx.to?.hash ?? '',
          valueNative: (Number(rawVal) / Math.pow(10, decimals)).toFixed(decimals <= 6 ? 4 : 6),
          symbol: token.symbol ?? 'TOKEN',
          timestamp: tx.timestamp ? Math.floor(new Date(tx.timestamp).getTime() / 1000) : 0,
          isError: false,
          isToken: true,
          functionName: '',
        }
      })

      // Merge, deduplicate by hash, sort newest first
      const seen = new Set<string>()
      const all = [...normalTxs, ...tokenTxs]
        .filter(tx => {
          if (seen.has(tx.hash)) return false
          seen.add(tx.hash)
          return true
        })
        .sort((a: any, b: any) => b.timestamp - a.timestamp)
        .slice(0, 100)

      if (all.length > 0) {
        return NextResponse.json({ transactions: all, source: 'blockscout' })
      }
    }
  } catch (e) {
    console.error('[tx] blockscout error:', e instanceof Error ? e.message : e)
  }

  // ── PATH 2: RPC — scan recent blocks (last resort) ────────────────────────
  try {
    const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
    const paddedAddr = '0x000000000000000000000000' + addrLower.slice(2)

    const latestHex: string = await rpc('eth_blockNumber', [])
    const latest = parseInt(latestHex, 16)
    const SCAN_BLOCKS = 5000  // ~2.7h on Ink (2s blocks)
    const fromBlock = '0x' + Math.max(0, latest - SCAN_BLOCKS).toString(16)

    const [logsFromRes, logsToRes, nativeTxsRes] = await Promise.all([
      rpc('eth_getLogs', [{ fromBlock, toBlock: 'latest', topics: [TRANSFER_TOPIC, paddedAddr] }]),
      rpc('eth_getLogs', [{ fromBlock, toBlock: 'latest', topics: [TRANSFER_TOPIC, null, paddedAddr] }]),
      fetchNativeTxs(addrLower, fromBlock, latest),
    ])

    const allLogs = [
      ...((logsFromRes || []).map((l: any) => ({ ...l, direction: 'send' }))),
      ...((logsToRes   || []).map((l: any) => ({ ...l, direction: 'receive' }))),
    ]

    const blockNums = [...new Set([
      ...allLogs.map((l: any) => l.blockNumber),
      ...nativeTxsRes.map((t: any) => t.blockNumber),
    ])] as string[]

    const blockTimestamps: Record<string, number> = {}
    await Promise.all(blockNums.slice(0, 30).map(async (bn) => {
      const block = await rpc('eth_getBlockByNumber', [bn, false])
      if (block) blockTimestamps[bn] = parseInt(block.timestamp, 16)
    }))

    const erc20Txs = allLogs.map((log: any) => {
      const contractAddr = log.address?.toLowerCase() ?? ''
      const tokenInfo    = TOKEN_MAP[contractAddr]
      const decimals     = tokenInfo?.decimals ?? 18
      const rawValue     = log.data === '0x' ? 0 : Number(BigInt(log.data))
      return {
        hash: log.transactionHash,
        type: log.direction as 'send' | 'receive',
        from: log.direction === 'send' ? address : '0x' + log.topics[1]?.slice(26),
        to:   log.direction === 'receive' ? address : '0x' + log.topics[2]?.slice(26),
        valueNative: (rawValue / Math.pow(10, decimals)).toFixed(decimals <= 6 ? 4 : 6),
        symbol: tokenInfo?.symbol ?? 'TOKEN',
        timestamp: blockTimestamps[log.blockNumber] || 0,
        isError: false, isToken: true, functionName: '',
      }
    })

    const nativeTxs = nativeTxsRes.map((t: any) => ({
      hash: t.hash,
      type: (t.from?.toLowerCase() === addrLower ? 'send' : 'receive') as 'send' | 'receive',
      from: t.from, to: t.to,
      valueNative: (Number(BigInt(t.value || '0x0')) / 1e18).toFixed(6),
      symbol: 'ETH',
      timestamp: blockTimestamps[t.blockNumber] || 0,
      isError: false, isToken: false, functionName: t.input === '0x' ? '' : 'contract call',
    }))

    const all = [...nativeTxs, ...erc20Txs]
      .filter((t, i, arr) => arr.findIndex(x => x.hash === t.hash) === i)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 100)

    if (all.length > 0) {
      return NextResponse.json({ transactions: all, source: 'rpc' })
    }
  } catch (e) {
    console.error('[tx] rpc error:', e)
  }

  return NextResponse.json({ transactions: [], source: 'empty' })
}

// Fetch native ETH transactions by scanning recent block receipts
async function fetchNativeTxs(addrLower: string, fromBlockHex: string, latestBlock: number): Promise<any[]> {
  try {
    const from = parseInt(fromBlockHex, 16)
    const total = latestBlock - from
    const step  = Math.max(1, Math.floor(total / 50))
    const blockNums: number[] = []
    for (let b = latestBlock; b >= from && blockNums.length < 50; b -= step) {
      blockNums.push(b)
    }

    const results: any[] = []
    await Promise.all(blockNums.map(async (bn) => {
      try {
        const block = await fetch(RPC, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_getBlockByNumber', params: ['0x' + bn.toString(16), true], id: bn }),
          cache: 'no-store',
        }).then(r => r.json())

        const txs: any[] = block?.result?.transactions ?? []
        for (const tx of txs) {
          if (
            tx.value && tx.value !== '0x0' &&
            (tx.from?.toLowerCase() === addrLower || tx.to?.toLowerCase() === addrLower)
          ) {
            results.push({ ...tx, blockNumber: block.result.number })
          }
        }
      } catch { /* skip block */ }
    }))

    return results
  } catch {
    return []
  }
}

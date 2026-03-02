import { NextRequest, NextResponse } from 'next/server'
import { INK_RPC as RPC, rpcBatch, getEthPrice } from '@/lib/ink'

export const revalidate = 0

// ─── Security: SSRF protection for metadata fetching ─────────────────────────
const PRIVATE_IP_RE = /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.|169\.254\.|::1|fc00:|fd)/

function isSafeMetaUrl(url: string): boolean {
  if (!url) return false
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:') return false
    if (PRIVATE_IP_RE.test(u.hostname)) return false
    if (u.hostname === 'localhost' || u.hostname.endsWith('.local')) return false
    return true
  } catch { return false }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function padUint256(n: bigint) { return n.toString(16).padStart(64, '0') }
function decodeString(hex: string): string {
  try {
    if (!hex || hex === '0x') return ''
    const b = Buffer.from(hex.slice(2), 'hex')
    if (b.length < 64) return ''
    const len = Number(BigInt('0x' + b.slice(32, 64).toString('hex')))
    return b.slice(64, 64 + len).toString('utf8').replace(/\0/g, '')
  } catch { return '' }
}
function resolveURI(uri: string): string {
  if (!uri) return ''
  return uri.startsWith('ipfs://') ? uri.replace('ipfs://', 'https://ipfs.io/ipfs/') : uri
}
function sanitizeImage(raw: string | null | undefined): string | null {
  if (!raw) return null
  const resolved = resolveURI(String(raw))
  return isSafeMetaUrl(resolved) ? resolved : null
}

// ─── OpenSea API ─────────────────────────────────────────────────────────────
const OPENSEA_API = 'https://api.opensea.io/api/v2'
const OPENSEA_CHAIN = 'ink'

// PATH 1: OpenSea — Get NFTs by account (returns metadata, images, collection)
async function fetchNFTsViaOpenSea(address: string, apiKey: string, ethPrice: number) {
  const url = `${OPENSEA_API}/chain/${OPENSEA_CHAIN}/account/${address}/nfts?limit=50`
  const res = await fetch(url, {
    headers: { 'Accept': 'application/json', 'X-API-KEY': apiKey },
    signal: AbortSignal.timeout(15_000),
    cache: 'no-store',
  })
  if (!res.ok) throw new Error(`OpenSea ${res.status}: ${res.statusText}`)
  const data = await res.json()
  const items: any[] = data.nfts ?? []
  if (!items.length) return { nfts: [], nftValue: 0, total: 0 }

  // Collect unique collection slugs for floor prices
  const slugs = [...new Set(items.map((n: any) => n.collection).filter(Boolean))] as string[]
  const floorMap = await fetchOpenSeaFloorPrices(slugs, apiKey)

  const nfts = items.map((nft: any) => {
    const contract  = nft.contract?.toLowerCase() ?? ''
    const tokenId   = nft.identifier ?? ''
    const slug      = nft.collection ?? ''
    const floorETH  = floorMap[slug] ?? 0
    const floorUSD  = floorETH * ethPrice

    return {
      id:          `${contract}_${tokenId}`,
      contract,
      tokenId,
      collection:  nft.collection ?? nft.name ?? `${contract.slice(0, 6)}...${contract.slice(-4)}`,
      symbol:      '',
      name:        nft.name ?? `#${tokenId}`,
      image:       sanitizeImage(nft.image_url ?? nft.display_image_url),
      floorETH,
      floorUSD,
      openSeaUrl:  `https://opensea.io/assets/${OPENSEA_CHAIN}/${contract}/${tokenId}`,
    }
  })

  const nftValue = nfts.reduce((s: number, n: any) => s + n.floorUSD, 0)
  return { nfts, nftValue, total: items.length }
}

// Fetch floor prices from OpenSea collection stats
async function fetchOpenSeaFloorPrices(
  slugs: string[],
  apiKey: string,
): Promise<Record<string, number>> {
  const floorMap: Record<string, number> = {}
  await Promise.allSettled(slugs.map(async (slug) => {
    try {
      const url = `${OPENSEA_API}/collections/${slug}/stats`
      const r = await fetch(url, {
        headers: { 'Accept': 'application/json', 'X-API-KEY': apiKey },
        signal: AbortSignal.timeout(8_000),
        cache: 'no-store',
      })
      if (!r.ok) return
      const stats = await r.json()
      const floor = Number(stats.total?.floor_price ?? 0)
      if (floor > 0) floorMap[slug] = floor
    } catch { /* skip */ }
  }))
  return floorMap
}

// ─── PATH 2: Blockscout + RPC fallback ───────────────────────────────────────
const BLOCKSCOUT = 'https://explorer.inkonchain.com/api/v2'

async function discoverNFTsViaBlockscout(address: string) {
  // Blockscout v2: get NFT token transfers for address
  const url = `${BLOCKSCOUT}/addresses/${address}/token-transfers?type=ERC-721%2CERC-1155&filter=to`
  const res = await fetch(url, {
    cache: 'no-store',
    signal: AbortSignal.timeout(12_000),
    headers: { 'Accept': 'application/json' },
  })
  if (!res.ok) return []
  const data = await res.json()
  const items: any[] = data.items ?? []

  // Deduplicate by contract+tokenId, keeping only those transferred TO the address
  const addrLower = address.toLowerCase()
  const seen = new Map<string, { contract: string; tokenId: bigint }>()
  for (const tx of items) {
    const contract = (tx.token?.address ?? tx.token_address ?? '').toLowerCase()
    const tokenId  = tx.total?.token_id ?? tx.token_id ?? '0'
    const to       = (tx.to?.hash ?? '').toLowerCase()
    if (!contract || to !== addrLower) continue
    const key = `${contract}_${tokenId}`
    if (!seen.has(key)) seen.set(key, { contract, tokenId: BigInt(tokenId) })
  }
  return [...seen.values()]
}

async function verifyOwnership(candidates: { contract: string; tokenId: bigint }[], address: string) {
  if (!candidates.length) return []
  const calls = candidates.map((c, i) => ({
    jsonrpc: '2.0', method: 'eth_call',
    params: [{ to: c.contract, data: '0x6352211e' + padUint256(c.tokenId) }, 'latest'],
    id: i,
  }))
  const results: any[] = []
  for (let i = 0; i < calls.length; i += 20)
    results.push(...await rpcBatch(calls.slice(i, i + 20)))
  const lo = address.toLowerCase()
  return candidates.filter((_, i) => {
    const r = results[i]?.result
    return r && r.length >= 26 && ('0x' + r.slice(-40)).toLowerCase() === lo
  })
}

async function fetchOnChainMeta(owned: { contract: string; tokenId: bigint }[]) {
  const contracts = [...new Set(owned.map(t => t.contract))]
  const [nameRes, symRes, uriRes] = await Promise.all([
    rpcBatch(contracts.map((a, i) => ({ jsonrpc:'2.0', method:'eth_call', params:[{to:a,data:'0x06fdde03'},'latest'], id:i }))),
    rpcBatch(contracts.map((a, i) => ({ jsonrpc:'2.0', method:'eth_call', params:[{to:a,data:'0x95d89b41'},'latest'], id:i }))),
    rpcBatch(owned.map(({ contract, tokenId }, i) => ({ jsonrpc:'2.0', method:'eth_call', params:[{to:contract,data:'0xc87b56dd'+padUint256(tokenId)},'latest'], id:i }))),
  ])
  const cMeta: Record<string, { name: string; symbol: string }> = {}
  contracts.forEach((a, i) => {
    cMeta[a] = { name: decodeString(nameRes[i]?.result ?? ''), symbol: decodeString(symRes[i]?.result ?? '') }
  })
  return { cMeta, uriRes }
}

async function fetchTokenMeta(uri: string) {
  try {
    const url = resolveURI(uri)
    if (!isSafeMetaUrl(url)) return null
    const r = await fetch(url, { signal: AbortSignal.timeout(5_000) })
    return r.ok ? await r.json() : null
  } catch { return null }
}

// ─── Main route ───────────────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  const address = req.nextUrl.searchParams.get('address')
  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return NextResponse.json({ error: 'Invalid address' }, { status: 400 })
  }

  const openSeaKey = process.env.OPENSEA_API_KEY

  // ── PATH 1: OpenSea API (primary — best metadata + images + floor prices) ──
  if (openSeaKey) {
    try {
      const ethPrice = await getEthPrice()
      const result = await fetchNFTsViaOpenSea(address, openSeaKey, ethPrice)
      return NextResponse.json(result)
    } catch (e) {
      console.error('[nfts] opensea error:', e instanceof Error ? e.message : e)
      // Fall through to Blockscout
    }
  }

  // ── PATH 2: Blockscout + on-chain RPC (no API key needed) ──────────────────
  try {
    const candidates = await discoverNFTsViaBlockscout(address)
    if (!candidates.length) return NextResponse.json({ nfts: [], nftValue: 0, total: 0 })

    const owned = await verifyOwnership(candidates, address)
    if (!owned.length) return NextResponse.json({ nfts: [], nftValue: 0, total: 0 })

    const cap   = owned.slice(0, 20)
    const total = owned.length
    const { cMeta, uriRes } = await fetchOnChainMeta(cap)
    const ethPrice = await getEthPrice()

    const metaResults = await Promise.all(
      cap.map((_, i) => fetchTokenMeta(decodeString(uriRes[i]?.result ?? '')))
    )

    const nfts = cap.map(({ contract, tokenId }, i) => {
      const cm         = cMeta[contract] ?? { name: '', symbol: '' }
      const meta       = metaResults[i]
      const collection = cm.name || cm.symbol || `${contract.slice(0, 6)}...${contract.slice(-4)}`
      return {
        id:          `${contract}_${tokenId}`,
        contract,
        tokenId:     tokenId.toString(),
        collection,
        symbol:      cm.symbol,
        name:        meta?.name ?? `${collection} #${tokenId}`,
        image:       sanitizeImage(meta?.image),
        floorETH:    0,
        floorUSD:    0,
        openSeaUrl:  `https://opensea.io/assets/${OPENSEA_CHAIN}/${contract}/${tokenId}`,
      }
    })

    return NextResponse.json({ nfts, nftValue: 0, total })
  } catch (err: any) {
    console.error('[nfts] blockscout/rpc error:', err?.message)
    return NextResponse.json({ error: err?.message ?? 'Failed' }, { status: 500 })
  }
}

/**
 * ink.ts — shared utilities for Ink Mainnet RPC and CoinGecko price fetching.
 *
 * Centralises:
 *  - INK_RPC constant
 *  - rpcBatch() helper
 *  - KNOWN_TOKENS list for Ink chain
 *  - getEthPrice() with a 60-second in-memory cache
 */

// ─── RPC ─────────────────────────────────────────────────────────────────────

export const INK_RPC = 'https://rpc-gel.inkonchain.com'
export const INK_RPC_SECONDARY = 'https://rpc-qnd.inkonchain.com'

/**
 * Send a JSON-RPC batch to the Ink node.
 * @param calls  Array of JSON-RPC call objects
 * @param timeoutMs  AbortSignal timeout in ms (default 15 000)
 */
export async function rpcBatch(calls: object[], timeoutMs = 15_000): Promise<any[]> {
  if (!calls.length) return []
  const res = await fetch(INK_RPC, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(calls),
    cache:   'no-store',
    signal:  AbortSignal.timeout(timeoutMs),
  })
  const data = await res.json()
  return Array.isArray(data) ? data : [data]
}

// ─── balanceOf call builder ───────────────────────────────────────────────────

/** Build a JSON-RPC eth_call object for ERC-20 balanceOf(walletAddress). */
export function buildBalanceOfCall(
  tokenContract: string,
  walletAddress:  string,
  id:             string | number = tokenContract,
) {
  const paddedAddress = walletAddress.slice(2).toLowerCase().padStart(64, '0')
  return {
    jsonrpc: '2.0',
    method:  'eth_call',
    params:  [{ to: tokenContract, data: '0x70a08231' + paddedAddress }, 'latest'],
    id,
  }
}

// ─── KNOWN_TOKENS ─────────────────────────────────────────────────────────────
// Tokens verified on Ink mainnet (chainId 57073)

export interface KnownToken {
  symbol:      string
  name:        string
  contract:    string
  decimals:    number
  coingeckoId: string
  color:       string
}

export const KNOWN_TOKENS: KnownToken[] = [
  {
    symbol:      'WETH',
    name:        'Wrapped ETH',
    contract:    '0x4200000000000000000000000000000000000006',
    decimals:    18,
    coingeckoId: 'weth',
    color:       '#627EEA',
  },
  {
    symbol:      'USDC.e',
    name:        'Bridged USDC',
    contract:    '0xF1815bd50389c46847f0Bda824eC8da914045D14',
    decimals:    6,
    coingeckoId: 'usd-coin',
    color:       '#2775CA',
  },
  {
    symbol:      'USDT0',
    name:        'Tether USD',
    contract:    '0x0200C29006150606B650577BBE7B6248F58470c1',
    decimals:    6,
    coingeckoId: 'tether',
    color:       '#26A17B',
  },
  {
    symbol:      'crvUSD',
    name:        'Curve USD',
    contract:    '0x39fec550CC6DDCEd810eCCfA9B2931b4B5f2344D',
    decimals:    18,
    coingeckoId: 'crvusd',
    color:       '#FF4C4C',
  },
  {
    symbol:      'frxUSD',
    name:        'Frax USD',
    contract:    '0x80eede496655fb9047dd39d9f418d5483ed600df',
    decimals:    18,
    coingeckoId: 'frax',
    color:       '#000000',
  },
  {
    symbol:      'sfrxUSD',
    name:        'Staked Frax USD',
    contract:    '0x5bff88ca1442c2496f7e475e9e7786383bc070c0',
    decimals:    18,
    coingeckoId: 'staked-frax',
    color:       '#1A1A1A',
  },
  {
    symbol:      'frxETH',
    name:        'Frax Ether',
    contract:    '0x43eDD7f3831b08FE70B7555ddD373C8bF65a9050',
    decimals:    18,
    coingeckoId: 'frax-ether',
    color:       '#232323',
  },
  {
    symbol:      'sfrxETH',
    name:        'Staked Frax Ether',
    contract:    '0x3ec3849c33291a9ef4c5db86de593eb4a37fde45',
    decimals:    18,
    coingeckoId: 'staked-frax-ether',
    color:       '#333333',
  },
  {
    symbol:      'CRV',
    name:        'Curve DAO Token',
    contract:    '0xAC73671a1762FE835208Fb93b7aE7490d1c2cCb3',
    decimals:    18,
    coingeckoId: 'curve-dao-token',
    color:       '#FF4C4C',
  },
  {
    symbol:      'FXS',
    name:        'Frax Share',
    contract:    '0x64445f0aecc51e94ad52d8ac56b7190e764e561a',
    decimals:    18,
    coingeckoId: 'frax-share',
    color:       '#000000',
  },
]

// ─── ETH price (shared, cached) ───────────────────────────────────────────────

interface PriceEntry {
  price:     number
  fetchedAt: number
}

const ETH_PRICE_TTL = 60_000 // 60 seconds
let ethPriceCache: PriceEntry | null = null

/**
 * Fetch the current ETH/USD price from CoinGecko.
 * Results are cached for 60 seconds so concurrent route handlers share one upstream call.
 */
export async function getEthPrice(): Promise<number> {
  const now = Date.now()
  if (ethPriceCache && now - ethPriceCache.fetchedAt < ETH_PRICE_TTL) {
    return ethPriceCache.price
  }
  try {
    const res = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd',
      { next: { revalidate: 60 } },
    )
    const d     = await res.json()
    const price = (d?.ethereum?.usd as number) ?? 0
    ethPriceCache = { price, fetchedAt: now }
    return price
  } catch {
    return ethPriceCache?.price ?? 0
  }
}

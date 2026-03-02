'use client'

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import {
  ArrowLeftRight, ChevronDown, RefreshCw, Info,
  CheckCircle, XCircle, Loader, ExternalLink, Search, X
} from 'lucide-react'
import { useWallet } from '@/contexts/WalletContext'
import { useSendTransaction, useChainId, useSwitchChain } from 'wagmi'
import { encodeFunctionData } from 'viem'
import { SORA } from '@/lib/styles'

// ─── LI.FI INTEGRATOR CONFIG ────────────────────────────────────────────────
// Register at https://docs.li.fi/monetization-take-fees to start collecting fees
// Set NEXT_PUBLIC_LIFI_INTEGRATOR in .env.local (e.g. "inkboard")
// Set NEXT_PUBLIC_LIFI_FEE as decimal (e.g. "0.002" = 0.2%)
const LIFI_API       = 'https://li.quest/v1'
const INTEGRATOR     = process.env.NEXT_PUBLIC_LIFI_INTEGRATOR ?? 'inkboard'
const INTEGRATOR_FEE = parseFloat(process.env.NEXT_PUBLIC_LIFI_FEE ?? '0.002')  // 0.2% integrator fee
const NATIVE         = '0x0000000000000000000000000000000000000000'

// ─── TYPES ──────────────────────────────────────────────────────────────────
interface LifiChain {
  id:        number
  key:       string
  name:      string
  chainType: string
  coin:      string
  logoURI:   string
  nativeToken: LifiToken
  metamask?: {
    blockExplorerUrls: string[]
    rpcUrls: string[]
    chainName: string
  }
}

interface LifiToken {
  address:  string
  symbol:   string
  name:     string
  decimals: number
  chainId?: number
  logoURI:  string
  priceUSD?: string
  coinKey?:  string
}

interface LifiQuote {
  id:   string
  type: string
  tool: string
  toolDetails?: { key: string; name: string; logoURI: string }
  action: {
    fromChainId: number
    toChainId:   number
    fromToken:   LifiToken
    toToken:     LifiToken
    fromAmount:  string
    slippage:    number
    toAddress?:  string
  }
  estimate: {
    fromAmount:        string
    toAmount:          string
    toAmountMin:       string
    approvalAddress?:  string
    executionDuration: number
    gasCosts?:         { amountUSD: string }[]
    feeCosts?:         { amountUSD: string; name: string }[]
    fromAmountUSD?:    string
    toAmountUSD?:      string
  }
  transactionRequest?: {
    from:      string
    to:        string
    data:      string
    value:     string
    gasLimit?: string
    gasPrice?: string
    chainId?:  number
  }
  includedSteps?: {
    type: string
    tool: string
    toolDetails?: { name: string }
    estimate?: { executionDuration: number }
  }[]
}

// ─── SLIPPAGE DEFAULTS ──────────────────────────────────────────────────────
const SLIPPAGE_ON_CHAIN = 0.01
const SLIPPAGE_CROSS    = 0.02

// ─── GAS BUFFER for MAX button ──────────────────────────────────────────────
const GAS_BUFFER: Record<number, number> = {
  1: 0.003, 10: 0.001, 56: 0.003, 137: 0.5, 8453: 0.001,
  42161: 0.001, 43114: 0.01, 57073: 0.001, 250: 1.0, 100: 0.1,
  324: 0.001, 59144: 0.001, 534352: 0.001, 5000: 0.5, 81457: 0.001,
}

// ─── WELL-KNOWN LOGO OVERRIDES ──────────────────────────────────────────────
const CG = 'https://assets.coingecko.com/coins/images'
const OVERRIDE_LOGOS: Record<string, string> = {
  ETH:  `${CG}/279/small/ethereum.png`,
  WETH: `${CG}/2518/small/weth.png`,
  USDC: `${CG}/6319/small/usdc.png`,
  USDT: `${CG}/325/small/tether.png`,
  WBTC: `${CG}/7598/small/wrapped_bitcoin_new.png`,
  BNB:  `${CG}/825/small/bnb-icon2_2x.png`,
  POL:  `${CG}/4713/small/polygon-ecosystem-token.png`,
  MATIC:`${CG}/4713/small/polygon-ecosystem-token.png`,
  AVAX: `${CG}/12559/small/Avalanche_Circle_RedWhite_Trans.png`,
  SOL:  `${CG}/4128/small/solana.png`,
  DAI:  `${CG}/9956/small/Badge_Dai.png`,
  LINK: `${CG}/877/small/chainlink-new-logo.png`,
  UNI:  `${CG}/12504/small/uniswap-logo.png`,
  CRV:  `${CG}/12124/small/Curve.png`,
  ARB:  `${CG}/16547/small/arb.jpg`,
  OP:   `${CG}/25244/small/Optimism.png`,
}

// ─── IMAGE WITH FALLBACK ────────────────────────────────────────────────────
function FallbackImage({ urls, symbol, size }: { urls: string[]; symbol: string; size: number }) {
  const [idx, setIdx] = useState(0)
  const avatar = (
    <div className="rounded-full flex items-center justify-center text-white font-bold shrink-0"
      style={{
        width: size, height: size,
        background: `hsl(${((([...symbol].reduce((h,c) => c.charCodeAt(0)+((h<<5)-h),0)) % 360)+360)%360}, 60%, 50%)`,
        fontSize: size * 0.38
      }}>
      {symbol.slice(0, 2).toUpperCase()}
    </div>
  )
  if (idx >= urls.length || !urls[idx]) return avatar
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={urls[idx]} alt={symbol} width={size} height={size}
      className="rounded-full object-cover shrink-0"
      style={{ width: size, height: size }}
      onError={() => setIdx(i => i + 1)} />
  )
}

function TokenImage({ token, size = 28 }: { token: LifiToken; size?: number }) {
  const sym = token.symbol.toUpperCase()
  const urls: string[] = []
  if (OVERRIDE_LOGOS[sym]) urls.push(OVERRIDE_LOGOS[sym])
  if (token.logoURI) urls.push(token.logoURI)
  if (token.address !== NATIVE && token.address?.length === 42) {
    urls.push(`https://tokens.1inch.io/${token.address.toLowerCase()}.png`)
  }
  return <FallbackImage key={token.address + (token.chainId ?? '')} urls={[...new Set(urls)]} symbol={token.symbol} size={size} />
}

function ChainImage({ chain, size = 28 }: { chain: LifiChain; size?: number }) {
  const urls: string[] = []
  if (chain.logoURI) urls.push(chain.logoURI)
  urls.push(`https://icons.llamao.fi/icons/chains/rsz_${chain.key}.jpg`)
  return <FallbackImage key={String(chain.id)} urls={urls} symbol={chain.name} size={size} />
}

// ─── LI.FI API HELPERS (via server-side proxies) ────────────────────────────
// FIX #1 & #2: Use internal API routes as proxies instead of calling li.quest
// directly from the browser. This avoids CORS / ad-blocker / CSP issues.

let cachedChains: LifiChain[] | null = null

// Also cache RPC URLs extracted from chain metadata for balance fetching
const chainRpcCache: Record<number, string> = {}

async function loadChains(): Promise<LifiChain[]> {
  if (cachedChains) return cachedChains
  try {
    // Fetch via our own Next.js API proxy (server-side, no CORS)
    const res = await fetch('/api/lifi-chains')
    if (!res.ok) throw new Error(`${res.status}`)
    const data: { chains: LifiChain[] } = await res.json()
    const priority = [57073, 1, 42161, 10, 8453, 137, 56, 43114, 250, 100]
    cachedChains = data.chains
      .filter(c => c.id > 0)
      .sort((a, b) => {
        const ai = priority.indexOf(a.id)
        const bi = priority.indexOf(b.id)
        if (ai !== -1 && bi !== -1) return ai - bi
        if (ai !== -1) return -1
        if (bi !== -1) return 1
        return a.name.localeCompare(b.name)
      })
    // Extract RPC URLs from chain metadata for dynamic balance fetching
    for (const c of cachedChains) {
      if (c.metamask?.rpcUrls?.[0]) {
        chainRpcCache[c.id] = c.metamask.rpcUrls[0]
      }
    }
    return cachedChains
  } catch {
    // Do NOT cache fallback — next mount can retry
    return [
      { id: 57073, key: 'ink', name: 'Ink', chainType: 'EVM', coin: 'ETH', logoURI: '', nativeToken: { address: NATIVE, symbol: 'ETH', name: 'Ether', decimals: 18, logoURI: OVERRIDE_LOGOS.ETH }, metamask: { blockExplorerUrls: ['https://explorer.inkonchain.com/'], rpcUrls: ['https://rpc-gel.inkonchain.com'], chainName: 'Ink' } },
      { id: 1, key: 'eth', name: 'Ethereum', chainType: 'EVM', coin: 'ETH', logoURI: '', nativeToken: { address: NATIVE, symbol: 'ETH', name: 'Ether', decimals: 18, logoURI: OVERRIDE_LOGOS.ETH }, metamask: { blockExplorerUrls: ['https://etherscan.io/'], rpcUrls: ['https://ethereum-rpc.publicnode.com'], chainName: 'Ethereum' } },
      { id: 42161, key: 'arb', name: 'Arbitrum', chainType: 'EVM', coin: 'ETH', logoURI: '', nativeToken: { address: NATIVE, symbol: 'ETH', name: 'Ether', decimals: 18, logoURI: OVERRIDE_LOGOS.ETH }, metamask: { blockExplorerUrls: ['https://arbiscan.io/'], rpcUrls: ['https://arb1.arbitrum.io/rpc'], chainName: 'Arbitrum One' } },
      { id: 10, key: 'opt', name: 'Optimism', chainType: 'EVM', coin: 'ETH', logoURI: '', nativeToken: { address: NATIVE, symbol: 'ETH', name: 'Ether', decimals: 18, logoURI: OVERRIDE_LOGOS.ETH }, metamask: { blockExplorerUrls: ['https://optimistic.etherscan.io/'], rpcUrls: ['https://mainnet.optimism.io'], chainName: 'OP Mainnet' } },
      { id: 8453, key: 'bas', name: 'Base', chainType: 'EVM', coin: 'ETH', logoURI: '', nativeToken: { address: NATIVE, symbol: 'ETH', name: 'Ether', decimals: 18, logoURI: OVERRIDE_LOGOS.ETH }, metamask: { blockExplorerUrls: ['https://basescan.org/'], rpcUrls: ['https://mainnet.base.org'], chainName: 'Base' } },
      { id: 137, key: 'pol', name: 'Polygon', chainType: 'EVM', coin: 'POL', logoURI: '', nativeToken: { address: NATIVE, symbol: 'POL', name: 'POL', decimals: 18, logoURI: OVERRIDE_LOGOS.POL }, metamask: { blockExplorerUrls: ['https://polygonscan.com/'], rpcUrls: ['https://polygon-rpc.com'], chainName: 'Polygon' } },
      { id: 56, key: 'bsc', name: 'BSC', chainType: 'EVM', coin: 'BNB', logoURI: '', nativeToken: { address: NATIVE, symbol: 'BNB', name: 'BNB', decimals: 18, logoURI: OVERRIDE_LOGOS.BNB }, metamask: { blockExplorerUrls: ['https://bscscan.com/'], rpcUrls: ['https://bsc-rpc.publicnode.com'], chainName: 'BNB Smart Chain' } },
      { id: 43114, key: 'ava', name: 'Avalanche', chainType: 'EVM', coin: 'AVAX', logoURI: '', nativeToken: { address: NATIVE, symbol: 'AVAX', name: 'Avalanche', decimals: 18, logoURI: OVERRIDE_LOGOS.AVAX }, metamask: { blockExplorerUrls: ['https://snowtrace.io/'], rpcUrls: ['https://api.avax.network/ext/bc/C/rpc'], chainName: 'Avalanche C-Chain' } },
      { id: 250, key: 'ftm', name: 'Fantom', chainType: 'EVM', coin: 'FTM', logoURI: '', nativeToken: { address: NATIVE, symbol: 'FTM', name: 'Fantom', decimals: 18, logoURI: '' }, metamask: { blockExplorerUrls: ['https://ftmscan.com/'], rpcUrls: ['https://rpc.ftm.tools'], chainName: 'Fantom Opera' } },
      { id: 100, key: 'dai', name: 'Gnosis', chainType: 'EVM', coin: 'XDAI', logoURI: '', nativeToken: { address: NATIVE, symbol: 'XDAI', name: 'xDAI', decimals: 18, logoURI: '' }, metamask: { blockExplorerUrls: ['https://gnosisscan.io/'], rpcUrls: ['https://rpc.gnosischain.com'], chainName: 'Gnosis' } },
    ]
  }
}

const TOKEN_CACHE_TTL = 5 * 60 * 1000
const tokenListCache: Record<number, { tokens: LifiToken[]; ts: number }> = {}

async function loadTokensForChain(chainId: number): Promise<LifiToken[]> {
  const cached = tokenListCache[chainId]
  if (cached && Date.now() - cached.ts < TOKEN_CACHE_TTL) return cached.tokens
  try {
    // FIX #1: Fetch via our own Next.js API proxy (server-side, no CORS)
    const res = await fetch(`/api/lifi-tokens?chain=${chainId}`)
    if (!res.ok) throw new Error(`${res.status}`)
    const data: { tokens: Record<string, LifiToken[]> } = await res.json()
    const tokens = data.tokens[String(chainId)] ?? []
    const result = tokens.map(t => ({
      ...t,
      logoURI: OVERRIDE_LOGOS[t.symbol.toUpperCase()] ?? t.logoURI,
    }))
    tokenListCache[chainId] = { tokens: result, ts: Date.now() }
    return result
  } catch {
    // Do NOT cache empty results on error — next open can retry
    return []
  }
}

async function fetchQuote(
  fromChain: LifiChain, fromToken: LifiToken, fromAmountHuman: string,
  toChain: LifiChain, toToken: LifiToken,
  fromAddress: string, toAddress?: string,
): Promise<LifiQuote> {
  const decimals = fromToken.decimals ?? 18
  const parsed = parseFloat(fromAmountHuman)
  if (isNaN(parsed) || parsed <= 0) throw new Error('Invalid amount')
  const fromAmount = BigInt(Math.floor(parsed * Math.pow(10, decimals))).toString()
  const isCross = fromChain.id !== toChain.id
  const slippage = isCross ? SLIPPAGE_CROSS : SLIPPAGE_ON_CHAIN

  const params = new URLSearchParams({
    fromChain: String(fromChain.id), toChain: String(toChain.id),
    fromToken: fromToken.address, toToken: toToken.address,
    fromAmount, fromAddress, slippage: String(slippage), integrator: INTEGRATOR,
  })
  if (INTEGRATOR_FEE > 0) params.set('fee', String(INTEGRATOR_FEE))
  if (toAddress && toAddress !== fromAddress) params.set('toAddress', toAddress)

  const res = await fetch(`${LIFI_API}/quote?${params}`)
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.message ?? `${res.status}`)
  }
  return res.json()
}

async function fetchStatus(tool: string, fromChainId: number, toChainId: number, txHash: string) {
  const params = new URLSearchParams({
    bridge: tool, fromChain: String(fromChainId), toChain: String(toChainId), txHash,
  })
  const res = await fetch(`${LIFI_API}/status?${params}`)
  if (!res.ok) throw new Error(`${res.status}`)
  return res.json() as Promise<{
    status: string
    substatus?: string
    receiving?: { txHash: string; chainId: number }
  }>
}

// FIX #3: Use dynamic RPC from LI.FI chain metadata instead of hardcoded list.
// Fallback to well-known public RPCs if chain metadata isn't loaded yet.
const FALLBACK_RPC: Record<number, string> = {
  1: 'https://ethereum-rpc.publicnode.com', 56: 'https://bsc-rpc.publicnode.com',
  137: 'https://polygon-rpc.com', 42161: 'https://arb1.arbitrum.io/rpc',
  10: 'https://mainnet.optimism.io', 8453: 'https://mainnet.base.org',
  43114: 'https://api.avax.network/ext/bc/C/rpc', 57073: 'https://rpc-gel.inkonchain.com',
  250: 'https://rpc.ftm.tools', 100: 'https://rpc.gnosischain.com',
  324: 'https://mainnet.era.zksync.io', 59144: 'https://rpc.linea.build',
  534352: 'https://rpc.scroll.io', 5000: 'https://rpc.mantle.xyz', 81457: 'https://rpc.blast.io',
}

function getRpcUrl(chain: LifiChain): string | null {
  // Priority: chain metadata from LI.FI → cached from loadChains → hardcoded fallback
  return chain.metamask?.rpcUrls?.[0] ?? chainRpcCache[chain.id] ?? FALLBACK_RPC[chain.id] ?? null
}

const ERC20_APPROVE_ABI = [{
  name: 'approve', type: 'function',
  inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }],
  outputs: [{ name: '', type: 'bool' }],
}] as const

type TxStatus = 'idle' | 'approving' | 'swapping' | 'pending' | 'success' | 'error'
const QUOTE_EXPIRY = 60

// Default tokens
const INK_NATIVE: LifiToken = { address: NATIVE, symbol: 'ETH', name: 'Ether', decimals: 18, chainId: 57073, logoURI: OVERRIDE_LOGOS.ETH }
const USDC_INK: LifiToken = {
  address: '0xF1815bd50389c46847f0Bda824eC8da914045D14', symbol: 'USDC.e',
  name: 'Bridged USD Coin', decimals: 6, chainId: 57073, logoURI: OVERRIDE_LOGOS.USDC,
}
const INK_CHAIN: LifiChain = {
  id: 57073, key: 'ink', name: 'Ink', chainType: 'EVM', coin: 'ETH', logoURI: '',
  nativeToken: INK_NATIVE,
  metamask: { blockExplorerUrls: ['https://explorer.inkonchain.com/'], rpcUrls: ['https://rpc-gel.inkonchain.com'], chainName: 'Ink' },
}

// ─── CHAIN SELECTOR MODAL ───────────────────────────────────────────────────
function ChainModal({ chains, onSelect, onClose }: {
  chains: LifiChain[]; onSelect: (c: LifiChain) => void; onClose: () => void
}) {
  const [q, setQ] = useState('')
  const filtered = chains.filter(c =>
    c.name.toLowerCase().includes(q.toLowerCase()) ||
    c.key.toLowerCase().includes(q.toLowerCase())
  )
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 pt-5 pb-3">
          <h3 className="font-semibold text-gray-800" style={SORA}>Select Network</h3>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-gray-100 text-gray-400"><X size={18} /></button>
        </div>
        <div className="px-4 pb-3">
          <div className="flex items-center gap-2 px-3 py-2 bg-gray-50 rounded-xl border border-gray-100">
            <Search size={14} className="text-gray-400" />
            <input autoFocus value={q} onChange={e => setQ(e.target.value)}
              placeholder="Search network…"
              className="flex-1 bg-transparent text-sm outline-none placeholder-gray-400" />
          </div>
        </div>
        <div className="overflow-y-auto max-h-72 px-3 pb-4">
          {filtered.map(c => (
            <button key={c.id} onClick={() => { onSelect(c); onClose() }}
              className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-violet-50 transition-colors text-left">
              <ChainImage chain={c} size={32} />
              <div>
                <p className="text-sm font-semibold text-gray-800">{c.name}</p>
                <p className="text-xs text-gray-400">{c.chainType}</p>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

// ─── TOKEN SELECTOR MODAL ───────────────────────────────────────────────────
function TokenModal({ chain, onSelect, onClose }: {
  chain: LifiChain; onSelect: (t: LifiToken) => void; onClose: () => void
}) {
  const [q, setQ] = useState('')
  const [tokens, setTokens] = useState<LifiToken[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    loadTokensForChain(chain.id).then(t => {
      if (!cancelled) { setTokens(t); setLoading(false) }
    })
    return () => { cancelled = true }
  }, [chain.id])

  const filtered = tokens.filter(t =>
    t.symbol.toLowerCase().includes(q.toLowerCase()) ||
    t.name.toLowerCase().includes(q.toLowerCase()) ||
    t.address.toLowerCase() === q.toLowerCase()
  ).slice(0, 80)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 pt-5 pb-3">
          <div>
            <h3 className="font-semibold text-gray-800" style={SORA}>Select Token</h3>
            <p className="text-xs text-gray-400">{chain.name}</p>
          </div>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-gray-100 text-gray-400"><X size={18} /></button>
        </div>
        <div className="px-4 pb-3">
          <div className="flex items-center gap-2 px-3 py-2 bg-gray-50 rounded-xl border border-gray-100">
            <Search size={14} className="text-gray-400" />
            <input autoFocus value={q} onChange={e => setQ(e.target.value)}
              placeholder="Search by name, symbol or address…"
              className="flex-1 bg-transparent text-sm outline-none placeholder-gray-400" />
          </div>
        </div>
        <div className="overflow-y-auto max-h-72 px-3 pb-4">
          {loading && (
            <div className="flex items-center justify-center py-8 gap-2 text-gray-400 text-sm">
              <Loader size={14} className="animate-spin" /> Loading tokens…
            </div>
          )}
          {!loading && filtered.length === 0 && (
            <p className="text-sm text-gray-400 text-center py-6">No tokens found</p>
          )}
          {!loading && filtered.map(token => (
            <button key={token.address} onClick={() => { onSelect(token); onClose() }}
              className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-violet-50 transition-colors text-left">
              <TokenImage token={token} size={36} />
              <div className="min-w-0">
                <p className="text-sm font-semibold text-gray-800">{token.symbol}</p>
                <p className="text-xs text-gray-400 truncate">{token.name}</p>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

// ─── MAIN PAGE ──────────────────────────────────────────────────────────────
export default function SwapPage() {
  const { address, isConnected } = useWallet()
  const connectedChainId = useChainId()
  const { switchChain } = useSwitchChain()

  const [chains, setChains]       = useState<LifiChain[]>([])
  const [fromChain, setFromChain] = useState<LifiChain>(INK_CHAIN)
  const [toChain, setToChain]     = useState<LifiChain>(INK_CHAIN)
  const [fromToken, setFromToken] = useState<LifiToken>(INK_NATIVE)
  const [toToken, setToToken]     = useState<LifiToken>(USDC_INK)
  const [amount, setAmount]       = useState('')
  const [receiver, setReceiver]   = useState('')

  const [quote, setQuote]               = useState<LifiQuote | null>(null)
  const [quoteLoading, setQuoteLoading] = useState(false)
  const [quoteError, setQuoteError]     = useState<string | null>(null)

  const [txStatus, setTxStatus] = useState<TxStatus>('idle')
  const [txHash, setTxHash]     = useState<string | null>(null)
  const [txError, setTxError]   = useState<string | null>(null)

  const [modal, setModal]                 = useState<'fromToken' | 'toToken' | 'fromChain' | 'toChain' | null>(null)
  const [quoteAge, setQuoteAge]           = useState(0)
  const [receiverError, setReceiverError] = useState<string | null>(null)

  const validateReceiver = useCallback((val: string): boolean => {
    if (!val.trim()) return true
    const valid = /^0x[0-9a-fA-F]{40}$/.test(val.trim())
    setReceiverError(valid ? null : 'Invalid address format')
    return valid
  }, [])

  const quoteAgeRef    = useRef<ReturnType<typeof setInterval> | null>(null)
  const pollCleanupRef = useRef<(() => void) | null>(null)

  // ── FIX #3: Balance via RPC — uses dynamic RPC from chain metadata ────────
  const [fromBalance, setFromBalance] = useState<number | null>(null)

  useEffect(() => {
    setFromBalance(null)
    if (!address || !isConnected) return
    const rpc = getRpcUrl(fromChain)
    if (!rpc) return
    const controller = new AbortController()
    const isNative = fromToken.address === NATIVE

    async function fetchBal() {
      try {
        let raw: bigint
        if (isNative) {
          const res = await fetch(rpc!, {
            method: 'POST', signal: controller.signal,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [address, 'latest'] }),
          })
          const d = await res.json()
          raw = BigInt(d.result ?? '0x0')
        } else {
          const padded = address!.replace('0x', '').padStart(64, '0')
          const res = await fetch(rpc!, {
            method: 'POST', signal: controller.signal,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0', id: 1, method: 'eth_call',
              params: [{ to: fromToken.address, data: '0x70a08231' + padded }, 'latest'],
            }),
          })
          const d = await res.json()
          raw = BigInt(d.result && d.result !== '0x' ? d.result : '0x0')
        }
        setFromBalance(Number(raw) / Math.pow(10, fromToken.decimals ?? 18))
      } catch { /* aborted or RPC error */ }
    }
    fetchBal()
    return () => controller.abort()
  }, [address, isConnected, fromChain, fromToken.address, fromToken.decimals])

  const fromBalanceDisplay = fromBalance !== null
    ? fromBalance < 0.0001 && fromBalance > 0 ? '<0.0001'
      : fromBalance.toLocaleString('en-US', { maximumFractionDigits: 6 })
    : null

  function handleMax() {
    if (fromBalance === null || fromBalance <= 0) return
    const buffer = fromToken.address === NATIVE ? (GAS_BUFFER[fromChain.id] ?? 0.002) : 0
    const maxAmt = Math.max(0, fromBalance - buffer)
    // Use full precision string to avoid rounding issues
    const maxStr = maxAmt > 0
      ? maxAmt.toFixed(Math.min(fromToken.decimals ?? 18, 8)).replace(/0+$/, '').replace(/\.$/, '')
      : ''
    setAmount(maxStr)
  }

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const { sendTransactionAsync } = useSendTransaction()

  useEffect(() => { loadChains().then(setChains) }, [])
  useEffect(() => { return () => { pollCleanupRef.current?.() } }, [])

  // Quote age ticker
  useEffect(() => {
    if (quote) {
      setQuoteAge(0)
      quoteAgeRef.current = setInterval(() => setQuoteAge(a => a + 1), 1000)
    } else {
      if (quoteAgeRef.current) clearInterval(quoteAgeRef.current)
      setQuoteAge(0)
    }
    return () => { if (quoteAgeRef.current) clearInterval(quoteAgeRef.current) }
  }, [quote])

  const quoteExpired = quoteAge >= QUOTE_EXPIRY

  // Quote with debounce
  const getQuote = useCallback(async (amt: string) => {
    if (!amt || isNaN(Number(amt)) || Number(amt) <= 0 || !address) { setQuote(null); return }
    setQuoteLoading(true); setQuoteError(null)
    try {
      const recv = receiver.trim() || undefined
      setQuote(await fetchQuote(fromChain, fromToken, amt, toChain, toToken, address, recv))
    } catch (e: any) {
      setQuoteError(e.message?.includes('No available') || e.message?.includes('not found')
        ? 'No route found for this pair' : (e.message ?? 'No route found'))
      setQuote(null)
    } finally { setQuoteLoading(false) }
  }, [fromChain, fromToken, toChain, toToken, address, receiver])

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => getQuote(amount), 700)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [amount, getQuote])

  function flipDirection() {
    setFromChain(toChain); setToChain(fromChain)
    setFromToken(toToken); setToToken(fromToken)
    setAmount(''); setQuote(null)
  }

  function parseApprovalAmount(amt: string, decimals: number): bigint {
    try {
      const parsed = parseFloat(amt)
      if (isNaN(parsed) || parsed <= 0) return 0n
      return BigInt(Math.floor(parsed * 1.005 * Math.pow(10, decimals)))
    } catch { return 0n }
  }

  // ── Execute Swap ──────────────────────────────────────────────────────────
  async function executeSwap() {
    if (!address || !quote || !amount || quoteExpired || !quote.transactionRequest) return
    if (receiver.trim() && !validateReceiver(receiver)) return
    setTxStatus('idle'); setTxError(null)

    try {
      const txReq = quote.transactionRequest

      // Approval if needed
      if (quote.estimate.approvalAddress && fromToken.address !== NATIVE) {
        setTxStatus('approving')
        await sendTransactionAsync({
          to: fromToken.address as `0x${string}`,
          data: encodeFunctionData({
            abi: ERC20_APPROVE_ABI, functionName: 'approve',
            args: [quote.estimate.approvalAddress as `0x${string}`, parseApprovalAmount(amount, fromToken.decimals)],
          }),
        })
      }

      setTxStatus('swapping')
      const hash = await sendTransactionAsync({
        to:    txReq.to as `0x${string}`,
        data:  txReq.data as `0x${string}`,
        value: txReq.value ? BigInt(txReq.value) : 0n,
      })

      setTxHash(hash)
      setTxStatus('pending')

      // Cross-chain: poll LI.FI status
      if (fromChain.id !== toChain.id) {
        let attempts = 0
        let pollTimer: ReturnType<typeof setTimeout> | null = null
        let cancelled = false
        const stopPoll = () => { cancelled = true; if (pollTimer) clearTimeout(pollTimer) }
        pollCleanupRef.current = stopPoll
        const poll = async () => {
          if (cancelled) return
          try {
            const s = await fetchStatus(quote.tool, fromChain.id, toChain.id, hash)
            if (s.status === 'DONE') { setTxStatus('success'); return }
            if (s.status === 'FAILED') { setTxStatus('error'); setTxError('Transaction failed on destination chain'); return }
          } catch { /* retry */ }
          if (!cancelled && attempts++ < 60) pollTimer = setTimeout(poll, 5000)
        }
        poll()
      } else {
        setTxStatus('success')
      }
    } catch (e: any) {
      setTxError(e.shortMessage ?? e.message ?? 'Transaction failed')
      setTxStatus('error')
    }
  }

  // ── Derived values ────────────────────────────────────────────────────────
  const dstAmount = useMemo(() => {
    if (!quote) return ''
    try {
      const big = BigInt(quote.estimate.toAmount)
      const dec = toToken.decimals ?? 18
      const divisor = BigInt(10 ** Math.max(0, dec - 8))
      const human = Number(big / divisor) / 1e8
      if (human >= 1000)  return human.toLocaleString('en-US', { maximumFractionDigits: 2 })
      if (human >= 1)     return human.toFixed(4)
      if (human >= 0.001) return human.toFixed(6)
      return human.toExponential(4)
    } catch { return '0' }
  }, [quote, toToken.decimals])

  const dstAmountUsd = quote?.estimate.toAmountUSD
    ? `$${parseFloat(quote.estimate.toAmountUSD).toFixed(2)}` : null

  const isCrossChain = fromChain.id !== toChain.id
  const wrongChain   = isConnected && connectedChainId !== fromChain.id
  const canSwap      = isConnected && !!quote && !quoteExpired && !!amount && txStatus === 'idle' && !wrongChain

  const explorerTxUrl = useMemo(() => {
    if (!txHash) return null
    const base = fromChain.metamask?.blockExplorerUrls?.[0]
    return base ? `${base.replace(/\/$/, '')}/tx/${txHash}` : `https://explorer.inkonchain.com/tx/${txHash}`
  }, [fromChain, txHash])

  const routeDisplay = quote?.toolDetails?.name ?? quote?.tool ?? '—'

  const totalFeesUsd = useMemo(() => {
    if (!quote) return null
    let total = 0
    for (const gc of quote.estimate.gasCosts ?? []) total += parseFloat(gc.amountUSD || '0')
    for (const fc of quote.estimate.feeCosts ?? []) total += parseFloat(fc.amountUSD || '0')
    return total > 0 ? total.toFixed(2) : null
  }, [quote])

  const estimatedTime = quote?.estimate.executionDuration
    ? Math.max(1, Math.round(quote.estimate.executionDuration / 60)) : null

  // ── RENDER ────────────────────────────────────────────────────────────────
  return (
    <div className="max-w-2xl mx-auto px-4 py-6">

      <div className="mb-6">
        <div className="flex items-center gap-3 mb-1">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-violet-500 to-purple-700 flex items-center justify-center shadow-lg shadow-violet-200">
            <ArrowLeftRight size={17} className="text-white" />
          </div>
          <h1 className="font-bold text-2xl text-gray-900" style={SORA}>Cross-chain Swap</h1>
        </div>
        <p className="text-sm text-gray-500 ml-12">
          Cross-chain swaps across {chains.length > 0 ? `${chains.length}+` : '40+'} chains · Best rate via LI.FI aggregation
        </p>
      </div>

      <div className="card p-5 space-y-3">

        {/* FROM */}
        <div className="rounded-xl bg-gray-50 border border-gray-100 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-gray-400 uppercase tracking-wide">From</span>
            <button onClick={() => setModal('fromChain')}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-white border border-gray-200 hover:border-violet-300 hover:bg-violet-50 transition-colors text-xs font-medium text-gray-700">
              <ChainImage chain={fromChain} size={16} />
              {fromChain.name}
              <ChevronDown size={11} className="text-gray-400" />
            </button>
          </div>
          <div className="flex items-center gap-3">
            <button onClick={() => setModal('fromToken')}
              className="flex items-center gap-2 px-3 py-2 rounded-xl bg-white border border-gray-200 hover:border-violet-300 hover:bg-violet-50 transition-colors shrink-0">
              <TokenImage token={fromToken} size={24} />
              <span className="font-semibold text-gray-800 text-sm">{fromToken.symbol}</span>
              <ChevronDown size={13} className="text-gray-400" />
            </button>
            <div className="flex-1 flex flex-col items-end gap-1 min-w-0">
              <input type="number" min="0" placeholder="0.00" value={amount}
                onChange={e => { const v = e.target.value; if (v === '' || Number(v) >= 0) setAmount(v) }}
                className="w-full bg-transparent text-right text-2xl font-semibold text-gray-800 outline-none placeholder-gray-300" />
              {isConnected && fromBalanceDisplay !== null && (
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-gray-400">
                    Balance: <span className="text-gray-500 font-medium">{fromBalanceDisplay} {fromToken.symbol}</span>
                  </span>
                  <button onClick={handleMax}
                    className="text-xs font-semibold text-violet-500 hover:text-violet-700 bg-violet-50 hover:bg-violet-100 px-1.5 py-0.5 rounded transition-colors">
                    MAX
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Flip */}
        <div className="flex justify-center -my-1">
          <button onClick={flipDirection}
            className="w-9 h-9 rounded-xl bg-white border border-gray-200 hover:border-violet-300 hover:bg-violet-50 flex items-center justify-center transition-all hover:rotate-180 duration-300 shadow-sm">
            <ArrowLeftRight size={15} className="text-violet-500" />
          </button>
        </div>

        {/* TO */}
        <div className="rounded-xl bg-gray-50 border border-gray-100 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-gray-400 uppercase tracking-wide">To</span>
            <button onClick={() => setModal('toChain')}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-white border border-gray-200 hover:border-violet-300 hover:bg-violet-50 transition-colors text-xs font-medium text-gray-700">
              <ChainImage chain={toChain} size={16} />
              {toChain.name}
              <ChevronDown size={11} className="text-gray-400" />
            </button>
          </div>
          <div className="flex items-center gap-3">
            <button onClick={() => setModal('toToken')}
              className="flex items-center gap-2 px-3 py-2 rounded-xl bg-white border border-gray-200 hover:border-violet-300 hover:bg-violet-50 transition-colors shrink-0">
              <TokenImage token={toToken} size={24} />
              <span className="font-semibold text-gray-800 text-sm">{toToken.symbol}</span>
              <ChevronDown size={13} className="text-gray-400" />
            </button>
            <div className="flex-1 text-right">
              {quoteLoading ? (
                <div className="flex items-center justify-end gap-1.5 text-gray-400">
                  <RefreshCw size={13} className="animate-spin" />
                  <span className="text-sm">Finding route…</span>
                </div>
              ) : dstAmount ? (
                <>
                  <span className="text-2xl font-semibold text-gray-800">{dstAmount}</span>
                  {dstAmountUsd && <p className="text-xs text-gray-400 mt-0.5">≈ {dstAmountUsd}</p>}
                </>
              ) : (
                <span className="text-2xl font-semibold text-gray-300">0.00</span>
              )}
            </div>
          </div>
        </div>

        {/* Receiver */}
        {isCrossChain && (
          <div className="rounded-xl bg-gray-50 border border-gray-100 p-3">
            <label className="text-xs font-medium text-gray-400 uppercase tracking-wide block mb-1.5">
              Receiver <span className="normal-case text-gray-300">(optional, defaults to your wallet)</span>
            </label>
            <input type="text" value={receiver}
              onChange={e => { setReceiver(e.target.value); setReceiverError(null) }}
              onBlur={e => { if (e.target.value.trim()) validateReceiver(e.target.value) }}
              placeholder={address ?? '0x…'}
              className={`w-full bg-transparent text-sm outline-none placeholder-gray-300 font-mono ${receiverError ? 'text-red-500' : 'text-gray-700'}`} />
            {receiverError && <p className="text-xs text-red-400 mt-1">{receiverError}</p>}
          </div>
        )}

        {/* Route details */}
        {quote && !quoteLoading && (
          <div className={`rounded-xl border divide-y text-sm ${quoteExpired ? 'border-amber-200 bg-amber-50/60 divide-amber-100/60' : 'border-violet-100 bg-violet-50/50 divide-violet-100/60'}`}>
            {quoteExpired && (
              <div className="flex items-center justify-between px-4 py-2.5">
                <span className="text-amber-600 font-medium text-xs">Quote expired — refresh before swapping</span>
                <button onClick={() => getQuote(amount)}
                  className="flex items-center gap-1 text-xs font-semibold text-violet-600 hover:text-violet-800 bg-white border border-violet-200 px-2 py-1 rounded-lg transition-colors">
                  <RefreshCw size={11} /> Refresh
                </button>
              </div>
            )}
            {!quoteExpired && (
              <div className="flex items-center justify-between px-4 py-2.5">
                <span className="text-xs text-gray-400">Quote valid for</span>
                <span className={`text-xs font-medium ${quoteAge > 45 ? 'text-amber-500' : 'text-gray-500'}`}>{Math.max(0, 60 - quoteAge)}s</span>
              </div>
            )}
            {estimatedTime && (
              <div className="flex justify-between px-4 py-2.5">
                <span className="text-gray-500">Estimated time</span>
                <span className="font-medium text-gray-700">~{estimatedTime} min</span>
              </div>
            )}
            {totalFeesUsd && (
              <div className="flex justify-between px-4 py-2.5">
                <span className="text-gray-500">Estimated fees</span>
                <span className="font-medium text-gray-700">${totalFeesUsd}</span>
              </div>
            )}
            <div className="flex justify-between px-4 py-2.5">
              <span className="text-gray-500">Slippage tolerance</span>
              <span className="font-medium text-gray-700">{(isCrossChain ? SLIPPAGE_CROSS : SLIPPAGE_ON_CHAIN) * 100}%</span>
            </div>
            <div className="flex justify-between px-4 py-2.5">
              <span className="text-gray-500">Route</span>
              <span className="font-medium text-violet-600">{routeDisplay}</span>
            </div>
          </div>
        )}

        {quoteError && (
          <div className="flex items-center gap-2 px-3 py-2.5 rounded-xl bg-red-50 border border-red-100 text-sm text-red-500">
            <XCircle size={14} /> {quoteError}
          </div>
        )}

        {/* CTA */}
        {!isConnected ? (
          <div className="text-center py-2"><p className="text-sm text-gray-400">Connect your wallet to swap</p></div>
        ) : wrongChain ? (
          <button onClick={() => switchChain({ chainId: fromChain.id })}
            className="w-full py-3.5 rounded-xl font-semibold text-white transition-all duration-200 flex items-center justify-center gap-2"
            style={{ background: 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)', boxShadow: '0 4px 16px rgba(245,158,11,0.35)' }}>
            Switch to {fromChain.name} network
          </button>
        ) : txStatus === 'success' ? (
          <div className="flex flex-col items-center gap-2 py-3">
            <div className="flex items-center gap-2 text-emerald-600 font-medium">
              <CheckCircle size={18} /> Swap successful!
            </div>
            {explorerTxUrl && (
              <a href={explorerTxUrl} target="_blank" rel="noopener noreferrer"
                className="text-xs text-violet-500 hover:text-violet-700 flex items-center gap-1">
                View on explorer <ExternalLink size={11} />
              </a>
            )}
            <button onClick={() => { setTxStatus('idle'); setTxHash(null); setAmount(''); setQuote(null) }}
              className="mt-1 text-sm text-gray-500 hover:text-gray-700 underline">New swap</button>
          </div>
        ) : txStatus === 'error' ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2 px-3 py-2.5 rounded-xl bg-red-50 border border-red-100 text-sm text-red-500">
              <XCircle size={14} /> {txError ?? 'Transaction failed'}
            </div>
            <button onClick={() => { setTxStatus('idle'); setTxError(null) }}
              className="w-full py-3 rounded-xl border border-gray-200 text-sm text-gray-600 hover:bg-gray-50 transition-colors">
              Try again
            </button>
          </div>
        ) : (
          <button onClick={executeSwap} disabled={!canSwap || txStatus !== 'idle'}
            className="w-full py-3.5 rounded-xl font-semibold text-white transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            style={{
              background: canSwap ? 'linear-gradient(135deg, #7C3AED 0%, #6d28d9 100%)' : '#e5e7eb',
              color: canSwap ? 'white' : '#9ca3af',
              boxShadow: canSwap ? '0 4px 16px rgba(131,110,249,0.35)' : 'none',
            }}>
            {txStatus === 'approving' && <><Loader size={16} className="animate-spin" /> Approving…</>}
            {txStatus === 'swapping'  && <><Loader size={16} className="animate-spin" /> Sending…</>}
            {txStatus === 'pending'   && <><Loader size={16} className="animate-spin" /> Confirming…</>}
            {txStatus === 'idle' && (quoteLoading ? 'Finding best route…' : !amount ? 'Enter an amount' : !quote ? 'No route found' : quoteExpired ? 'Quote expired — refresh' : 'Swap')}
          </button>
        )}
      </div>

      <div className="mt-4 flex items-start gap-2 text-xs text-gray-400">
        <Info size={13} className="mt-0.5 shrink-0" />
        <span>
          Swaps execute directly on-chain via{' '}
          <a href="https://li.fi" target="_blank" rel="noopener noreferrer" className="text-violet-400 hover:text-violet-600">LI.FI</a>
          {' '}aggregation — InkBoard never holds your funds.
        </span>
      </div>

      {/* Modals */}
      {modal === 'fromChain' && (
        <ChainModal chains={chains} onSelect={c => { setFromChain(c); setFromToken(c.nativeToken); setQuote(null) }} onClose={() => setModal(null)} />
      )}
      {modal === 'toChain' && (
        <ChainModal chains={chains} onSelect={c => { setToChain(c); setToToken(c.nativeToken); setQuote(null) }} onClose={() => setModal(null)} />
      )}
      {modal === 'fromToken' && (
        <TokenModal chain={fromChain} onSelect={t => { setFromToken(t); setQuote(null) }} onClose={() => setModal(null)} />
      )}
      {modal === 'toToken' && (
        <TokenModal chain={toChain} onSelect={t => { setToToken(t); setQuote(null) }} onClose={() => setModal(null)} />
      )}
    </div>
  )
}

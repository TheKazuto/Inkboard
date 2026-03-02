'use client'
import { cachedFetch } from '@/lib/dataCache'

/**
 * PortfolioContext — single source of truth for portfolio totals.
 *
 * Fires 3 API calls in parallel the moment a wallet is connected.
 * Components read cached totals without re-fetching on page navigation.
 *
 * Key fixes:
 * - Debounce address/connection changes (wagmi can flicker on navigation)
 * - Never reset to ZERO while data is already loaded for the same address
 * - Cache by address — navigating back doesn't re-fetch if data is fresh (<5min)
 */

import {
  createContext, useContext, useState,
  useEffect, useCallback, useRef, ReactNode,
} from 'react'
import { useWallet } from './WalletContext'

// ─── Raw data types (shared with portfolio page) ─────────────────────────────
export interface TokenData {
  symbol: string; name: string; balance: number
  price: number; value: number; color: string; percentage: number
  imageUrl?: string
}
export interface NFTData {
  id: string; contract: string; tokenId: string
  collection: string; symbol: string; name: string
  image: string | null; floorETH: number; floorUSD: number
  magicEdenUrl: string
}

export interface PortfolioTotals {
  tokenValueUSD:       number
  nftValueUSD:         number
  defiNetValueUSD:     number
  totalValueUSD:       number
  defiActiveProtocols: string[]
  defiTotalDebtUSD:    number
  defiTotalSupplyUSD:  number
  defiPositions:       any[]        // raw positions array — consumed by DeFiPositions widget
  tokens:              TokenData[]  // full token list — consumed by portfolio page
  nfts:                NFTData[]    // full NFT list   — consumed by portfolio page
  nftTotal:            number       // total NFT count (may exceed nfts.length if >50)
  nftsNoKey:           boolean      // true when Etherscan API key is missing
}

export type LoadStatus = 'idle' | 'loading' | 'partial' | 'done' | 'error'

interface PortfolioContextValue {
  totals:      PortfolioTotals
  status:      LoadStatus
  lastUpdated: Date | null
  refresh:     () => void
}

const ZERO: PortfolioTotals = {
  tokenValueUSD:       0,
  nftValueUSD:         0,
  defiNetValueUSD:     0,
  totalValueUSD:       0,
  defiActiveProtocols: [],
  defiTotalDebtUSD:    0,
  defiTotalSupplyUSD:  0,
  defiPositions:       [],
  tokens:              [],
  nfts:                [],
  nftTotal:            0,
  nftsNoKey:           false,
}

const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes

interface CacheEntry {
  totals:    PortfolioTotals
  fetchedAt: number
}

// Module-level cache — survives React re-renders and page navigation
const portfolioCache = new Map<string, CacheEntry>()

const PortfolioCtx = createContext<PortfolioContextValue>({
  totals:      ZERO,
  status:      'idle',
  lastUpdated: null,
  refresh:     () => {},
})

export function usePortfolio() {
  return useContext(PortfolioCtx)
}

export function PortfolioProvider({ children }: { children: ReactNode }) {
  const { stableAddress: address, isConnected } = useWallet()

  const [totals,      setTotals]      = useState<PortfolioTotals>(ZERO)
  const [status,      setStatus]      = useState<LoadStatus>('idle')
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)

  // Refs for parallel fetch accumulation
  const tokenRef      = useRef(0)
  const nftRef        = useRef(0)
  const defiRef       = useRef<Partial<PortfolioTotals> & { defiPositions?: any[] }>({})
  const tokenListRef  = useRef<TokenData[]>([])
  const nftListRef    = useRef<NFTData[]>([])
  const nftTotalRef   = useRef(0)
  const nftsNoKeyRef  = useRef(false)
  const loadingAddr   = useRef<string | null>(null)

  const flush = useCallback((addr: string) => {
    const t = tokenRef.current
    const n = nftRef.current
    const d = defiRef.current.defiNetValueUSD ?? 0
    const next: PortfolioTotals = {
      tokenValueUSD:       t,
      nftValueUSD:         n,
      defiNetValueUSD:     d,
      totalValueUSD:       t + n + d,
      defiActiveProtocols: defiRef.current.defiActiveProtocols ?? [],
      defiTotalDebtUSD:    defiRef.current.defiTotalDebtUSD    ?? 0,
      defiTotalSupplyUSD:  defiRef.current.defiTotalSupplyUSD  ?? 0,
      defiPositions:       defiRef.current.defiPositions       ?? [],
      tokens:              tokenListRef.current,
      nfts:                nftListRef.current,
      nftTotal:            nftTotalRef.current,
      nftsNoKey:           nftsNoKeyRef.current,
    }
    setTotals(next)
    // Keep cache updated with latest partial data
    portfolioCache.set(addr.toLowerCase(), { totals: next, fetchedAt: Date.now() })
  }, [])

  const load = useCallback(async (addr: string, force = false) => {
    const key   = addr.toLowerCase()
    const entry = portfolioCache.get(key)

    // Serve from cache if fresh and not forced
    if (!force && entry && Date.now() - entry.fetchedAt < CACHE_TTL_MS) {
      setTotals(entry.totals)
      setStatus('done')
      setLastUpdated(new Date(entry.fetchedAt))
      return
    }

    // Already loading this address — don't double-fetch
    if (loadingAddr.current === key) return
    loadingAddr.current = key

    // Seed from cache while re-fetching so UI doesn't flash empty
    if (entry) {
      tokenRef.current     = entry.totals.tokenValueUSD
      nftRef.current       = entry.totals.nftValueUSD
      tokenListRef.current = entry.totals.tokens
      nftListRef.current   = entry.totals.nfts
      nftTotalRef.current  = entry.totals.nftTotal
      nftsNoKeyRef.current = entry.totals.nftsNoKey
      defiRef.current  = {
        defiNetValueUSD:     entry.totals.defiNetValueUSD,
        defiTotalDebtUSD:    entry.totals.defiTotalDebtUSD,
        defiTotalSupplyUSD:  entry.totals.defiTotalSupplyUSD,
        defiActiveProtocols: entry.totals.defiActiveProtocols,
        defiPositions:       entry.totals.defiPositions,
      }
      setTotals(entry.totals)
    } else {
      tokenRef.current     = 0
      nftRef.current       = 0
      tokenListRef.current = []
      nftListRef.current   = []
      nftTotalRef.current  = 0
      nftsNoKeyRef.current = false
      defiRef.current      = {}
    }

    setStatus('loading')

    const fetchTokens = async () => {
      try {
        const data = await cachedFetch<any>('/api/token-exposure', addr)
        if (loadingAddr.current !== key) return // stale
        tokenRef.current     = Number(data.totalValue ?? 0)
        tokenListRef.current = Array.isArray(data.tokens) ? data.tokens : []
        flush(addr)
        setStatus(s => s === 'loading' ? 'partial' : s)
      } catch { /* keeps previous value */ }
    }

    const fetchNFTs = async () => {
      try {
        const data = await cachedFetch<any>('/api/nfts', addr)
        if (loadingAddr.current !== key) return
        if (data.error === 'no_api_key') {
          nftsNoKeyRef.current = true
          flush(addr)
          return
        }
        nftRef.current       = Number(data.nftValue ?? 0)
        nftListRef.current   = Array.isArray(data.nfts) ? data.nfts : []
        nftTotalRef.current  = Number(data.total ?? 0)
        nftsNoKeyRef.current = false
        flush(addr)
        setStatus(s => s === 'loading' ? 'partial' : s)
      } catch { /* keeps previous value */ }
    }

    const fetchDefi = async () => {
      try {
        const data = await cachedFetch<any>('/api/defi', addr)
        if (loadingAddr.current !== key) return
        const s    = data.summary ?? {}
        defiRef.current = {
          defiNetValueUSD:     Number(s.netValueUSD     ?? 0),
          defiTotalDebtUSD:    Number(s.totalDebtUSD    ?? 0),
          defiTotalSupplyUSD:  Number(s.totalSupplyUSD  ?? 0),
          defiActiveProtocols: Array.isArray(s.activeProtocols) ? s.activeProtocols : [],
          defiPositions:       Array.isArray(data.positions) ? data.positions : [],
        }
        flush(addr)
        setStatus(s2 => s2 === 'loading' ? 'partial' : s2)
      } catch { /* keeps previous value */ }
    }

    await Promise.allSettled([fetchTokens(), fetchNFTs(), fetchDefi()])

    if (loadingAddr.current === key) {
      flush(addr)
      setStatus('done')
      setLastUpdated(new Date())
      loadingAddr.current = null
    }
  }, [flush])

  // Debounce address changes to avoid wagmi flicker on navigation
  useEffect(() => {
    if (!isConnected || !address) {
      // Only reset if we don't have cached data (avoid flicker on nav)
      const hasCached = address && portfolioCache.has(address.toLowerCase())
      if (!hasCached) {
        loadingAddr.current = null
        setTotals(ZERO)
        setStatus('idle')
        setLastUpdated(null)
      }
      return
    }

    const timer = setTimeout(() => {
      load(address)
    }, 100) // 100ms debounce — absorbs wagmi reconnect flicker

    return () => clearTimeout(timer)
  }, [address, isConnected, load])

  const refresh = useCallback(() => {
    if (address && isConnected) {
      loadingAddr.current = null // allow re-fetch
      load(address, true)        // force bypass cache
    }
  }, [address, isConnected, load])

  return (
    <PortfolioCtx.Provider value={{ totals, status, lastUpdated, refresh }}>
      {children}
    </PortfolioCtx.Provider>
  )
}

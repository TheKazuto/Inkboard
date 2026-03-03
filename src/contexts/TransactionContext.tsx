'use client'

import { createContext, useContext, useState, useEffect, useCallback, useRef, ReactNode } from 'react'
import { useWallet } from '@/contexts/WalletContext'

// ─── Types ────────────────────────────────────────────────────────────────────
export interface Transaction {
  hash: string
  type: 'send' | 'receive' | 'swap' | 'defi' | 'nft' | 'contract'
  from: string
  to: string
  valueNative: string
  symbol: string
  tokenName?: string
  timestamp: number
  isError: boolean
  isToken?: boolean
  functionName?: string
}

export type TxStatus = 'idle' | 'loading' | 'success' | 'error' | 'no_api_key'

interface TransactionContextValue {
  transactions: Transaction[]
  status: TxStatus
  lastUpdated: Date | null
  refresh: () => void
}

// ─── Context ──────────────────────────────────────────────────────────────────
const TransactionContext = createContext<TransactionContextValue>({
  transactions: [],
  status: 'idle',
  lastUpdated: null,
  refresh: () => {},
})

export function useTransactions() {
  return useContext(TransactionContext)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function classifyType(tx: Transaction, address: string): Transaction['type'] {
  const fn = (tx.functionName || '').toLowerCase()
  if (fn.includes('swap') || fn.includes('exchange')) return 'swap'
  if (fn.includes('deposit') || fn.includes('borrow') || fn.includes('supply') || fn.includes('withdraw') || fn.includes('stake')) return 'defi'
  if (fn.includes('mint') || fn.includes('nft') || fn.includes('erc721')) return 'nft'
  if (tx.to && tx.functionName && tx.functionName !== '') return 'contract'
  return tx.from?.toLowerCase() === address.toLowerCase() ? 'send' : 'receive'
}

export function formatDate(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  })
}

export function formatTimeAgo(timestamp: number): string {
  const diff = Math.floor(Date.now() / 1000) - timestamp
  if (diff < 60) return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

export function shortenAddr(addr: string): string {
  if (!addr || addr.length < 10) return addr
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

// ─── Module-level cache — survives navigation (like PortfolioContext) ────────
const TX_CACHE_TTL = 2 * 60 * 1000 // 2 minutes
interface TxCacheEntry { txs: Transaction[]; fetchedAt: number }
const txCache = new Map<string, TxCacheEntry>()
let txInflight: Map<string, Promise<Transaction[] | null>> = new Map()

// ─── Provider ─────────────────────────────────────────────────────────────────
export function TransactionProvider({ children }: { children: ReactNode }) {
  const { address, isConnected } = useWallet()
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [status, setStatus] = useState<TxStatus>('idle')
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const lastAddressRef = useRef<string | null>(null)

  const fetchTransactions = useCallback(async (addr: string, force = false) => {
    const key = addr.toLowerCase()

    // Serve from cache if fresh
    if (!force) {
      const cached = txCache.get(key)
      if (cached && Date.now() - cached.fetchedAt < TX_CACHE_TTL) {
        setTransactions(cached.txs)
        setLastUpdated(new Date(cached.fetchedAt))
        setStatus(cached.txs.length > 0 ? 'success' : 'idle')
        return
      }
    }

    // Deduplicate in-flight requests
    if (txInflight.has(key)) {
      const result = await txInflight.get(key)
      if (result) {
        setTransactions(result)
        setStatus('success')
      }
      return
    }

    setStatus('loading')
    const promise = (async (): Promise<Transaction[] | null> => {
      try {
        const res = await fetch(`/api/transactions?address=${addr}`)
        if (!res.ok) throw new Error('fetch failed')
        const data = await res.json()

        if (data.error === 'no_api_key') {
          setStatus('no_api_key')
          return null
        }
        if (data.error) throw new Error(data.error)

        const enriched: Transaction[] = (data.transactions ?? [])
          .map((tx: Transaction) => ({
            ...tx,
            type: classifyType(tx, addr),
          }))
          .filter((tx: Transaction, i: number, arr: Transaction[]) => arr.findIndex((t: Transaction) => t.hash === tx.hash) === i)
          .sort((a: Transaction, b: Transaction) => b.timestamp - a.timestamp)

        txCache.set(key, { txs: enriched, fetchedAt: Date.now() })
        setTransactions(enriched)
        setLastUpdated(new Date())
        setStatus('success')
        return enriched
      } catch {
        setStatus('error')
        return null
      } finally {
        txInflight.delete(key)
      }
    })()

    txInflight.set(key, promise)
    await promise
  }, [])

  const refresh = useCallback(() => {
    if (!address) return
    if (intervalRef.current) clearInterval(intervalRef.current)
    fetchTransactions(address, true)
    intervalRef.current = setInterval(() => {
      // Only poll when tab is visible
      if (typeof document === 'undefined' || document.visibilityState === 'visible') {
        fetchTransactions(address)
      }
    }, 120_000)
  }, [address, fetchTransactions])

  useEffect(() => {
    if (intervalRef.current) clearInterval(intervalRef.current)

    if (!isConnected || !address) {
      // Keep cached data for instant restore — only clear if different address
      if (!address || lastAddressRef.current !== address) {
        setTransactions([])
        setStatus('idle')
        setLastUpdated(null)
      }
      lastAddressRef.current = null
      return
    }

    // Seed from cache immediately while fetching fresh data
    const cached = txCache.get(address.toLowerCase())
    if (lastAddressRef.current !== address) {
      if (cached) {
        setTransactions(cached.txs)
        setLastUpdated(new Date(cached.fetchedAt))
        setStatus('success')
      } else {
        setTransactions([])
        setStatus('idle')
      }
      lastAddressRef.current = address
    }

    fetchTransactions(address)

    // Auto-refresh every 2 minutes (only when tab is visible)
    intervalRef.current = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') {
        fetchTransactions(address)
      }
    }, 120_000)

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [isConnected, address, fetchTransactions])

  return (
    <TransactionContext.Provider value={{ transactions, status, lastUpdated, refresh }}>
      {children}
    </TransactionContext.Provider>
  )
}

'use client'

import { useState, useEffect } from 'react'
import { SORA } from '@/lib/styles'
import { fmtUSD } from '@/lib/format'
import { TrendingUp, TrendingDown, RefreshCw } from 'lucide-react'

interface Token {
  id: string
  symbol: string
  name: string
  image: string
  current_price: number
  market_cap: number
  market_cap_rank: number
  price_change_percentage_24h: number
  total_volume: number
}

// Module-level cache — survives navigation without re-fetching
const CACHE_TTL = 5 * 60 * 1000 // 5 minutes
let cachedTokens: { data: Token[]; fetchedAt: number } | null = null

function formatPrice(price: number): string {
  if (price === 0 || price === null) return '$0.00'
  if (price < 0.000001) return `$${price.toExponential(2)}`
  if (price < 0.0001) return `$${price.toFixed(7)}`
  if (price < 0.01) return `$${price.toFixed(5)}`
  if (price < 1) return `$${price.toFixed(4)}`
  if (price < 1000) return `$${price.toFixed(2)}`
  return `$${price.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
}

export default function TopTokens() {
  const [tokens, setTokens] = useState<Token[]>(() => cachedTokens?.data ?? [])
  const [loading, setLoading] = useState(!cachedTokens)
  const [error, setError] = useState(false)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(
    cachedTokens ? new Date(cachedTokens.fetchedAt) : null,
  )

  const fetchTokens = async (force = false) => {
    // Serve from cache if fresh and not forced
    if (!force && cachedTokens && Date.now() - cachedTokens.fetchedAt < CACHE_TTL) {
      setTokens(cachedTokens.data)
      setLastUpdated(new Date(cachedTokens.fetchedAt))
      setLoading(false)
      return
    }
    try {
      setError(false)
      const res = await fetch('/api/top-tokens')
      if (!res.ok) throw new Error('fetch failed')
      const data = await res.json()
      if (Array.isArray(data) && data.length > 0) {
        cachedTokens = { data, fetchedAt: Date.now() }
        setTokens(data)
        setLastUpdated(new Date())
      } else {
        throw new Error('empty data')
      }
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchTokens()
  }, [])

  return (
    <div className="card p-5">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3
            className="font-semibold text-gray-800"
            style={SORA}
          >
            Top Ink Tokens
          </h3>
          {lastUpdated && (
            <p className="text-xs text-gray-400 mt-0.5">
              Updated {lastUpdated.toLocaleTimeString()}
            </p>
          )}
        </div>
        <button
          onClick={() => fetchTokens(true)}
          className="p-1.5 rounded-lg text-gray-400 hover:text-violet-600 hover:bg-violet-50 transition-all"
          title="Refresh"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* Loading skeleton */}
      {loading && (
        <div className="space-y-3">
          {Array.from({ length: 10 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3">
              <div className="skeleton w-6 h-4 rounded" />
              <div className="skeleton w-7 h-7 rounded-full" />
              <div className="skeleton flex-1 h-4 rounded" />
              <div className="skeleton w-16 h-4 rounded" />
              <div className="skeleton w-14 h-4 rounded" />
              <div className="skeleton w-12 h-4 rounded" />
            </div>
          ))}
        </div>
      )}

      {/* Error state */}
      {!loading && error && (
        <div className="text-center py-8">
          <p className="text-sm text-gray-400 mb-3">Could not load token data</p>
          <button
            onClick={() => fetchTokens(true)}
            className="btn-primary text-xs px-4 py-2"
          >
            Try again
          </button>
        </div>
      )}

      {/* Token table */}
      {!loading && !error && tokens.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-gray-400 border-b border-gray-100">
                <th className="pb-2 text-left font-medium w-6">#</th>
                <th className="pb-2 text-left font-medium">Token</th>
                <th className="pb-2 text-right font-medium">Price</th>
                <th className="pb-2 text-right font-medium hidden sm:table-cell">Mkt Cap</th>
                <th className="pb-2 text-right font-medium hidden md:table-cell">Volume 24h</th>
                <th className="pb-2 text-right font-medium">24h</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {tokens.map((token, index) => {
                const change = token.price_change_percentage_24h ?? 0
                const isPositive = change >= 0
                return (
                  <tr
                    key={token.id}
                    className="hover:bg-violet-50/40 transition-colors cursor-pointer"
                    onClick={() => window.open(`https://www.coingecko.com/en/coins/${token.id}`, '_blank')}
                  >
                    {/* Rank */}
                    <td className="py-2.5 text-gray-400 text-xs font-medium">
                      {index + 1}
                    </td>

                    {/* Token name + logo */}
                    <td className="py-2.5">
                      <div className="flex items-center gap-2">
                        <img
                          src={token.image}
                          alt={token.name}
                          width={28}
                          height={28}
                          className="rounded-full"
                          onError={(e) => {
                            (e.target as HTMLImageElement).style.display = 'none'
                          }}
                        />
                        <div>
                          <p className="font-semibold text-gray-800 uppercase text-xs sm:text-sm">
                            {token.symbol}
                          </p>
                          <p className="text-xs text-gray-400 hidden sm:block truncate max-w-[100px]">
                            {token.name}
                          </p>
                        </div>
                      </div>
                    </td>

                    {/* Price */}
                    <td className="py-2.5 text-right font-mono text-gray-700 text-xs sm:text-sm">
                      {formatPrice(token.current_price)}
                    </td>

                    {/* Market cap */}
                    <td className="py-2.5 text-right text-gray-500 text-xs hidden sm:table-cell">
                      {token.market_cap ? fmtUSD(token.market_cap) : '—'}
                    </td>

                    {/* Volume */}
                    <td className="py-2.5 text-right text-gray-500 text-xs hidden md:table-cell">
                      {token.total_volume ? fmtUSD(token.total_volume) : '—'}
                    </td>

                    {/* 24h change */}
                    <td className="py-2.5 text-right">
                      <span
                        className={`inline-flex items-center gap-0.5 text-xs font-semibold px-1.5 py-0.5 rounded-md ${
                          isPositive
                            ? 'text-emerald-700 bg-emerald-50'
                            : 'text-red-600 bg-red-50'
                        }`}
                      >
                        {isPositive ? <TrendingUp size={10} /> : <TrendingDown size={10} />}
                        {isPositive ? '+' : ''}
                        {change.toFixed(2)}%
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Footer */}
      <div className="mt-4 pt-3 border-t border-gray-50 flex items-center justify-between">
        <p className="text-xs text-gray-400">
          Data via{' '}
          <a
            href="https://www.coingecko.com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-violet-500 hover:text-violet-700"
          >
            CoinGecko
          </a>
        </p>
        <a
          href="https://www.coingecko.com/en/categories/ink-ecosystem"
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-violet-500 hover:text-violet-700"
        >
          View all →
        </a>
      </div>
    </div>
  )
}

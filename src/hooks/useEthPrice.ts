'use client'

import { useState, useEffect, useCallback } from 'react'

interface EthPrice {
  price: number
  change24h: number
  changeAmount: number
  loading: boolean
  error: boolean
  lastUpdated: Date | null
}

export function useEthPrice(refreshInterval = 60_000): EthPrice {
  const [data, setData] = useState<EthPrice>({
    price: 0,
    change24h: 0,
    changeAmount: 0,
    loading: true,
    error: false,
    lastUpdated: null,
  })

  const fetchPrice = useCallback(async () => {
    try {
      const res = await fetch('/api/eth-price')
      if (!res.ok) throw new Error(`/api/eth-price ${res.status}`)

      const json = await res.json()
      if (json.error) throw new Error(json.error)

      setData({
        price:        json.price,
        change24h:    json.change24h,
        changeAmount: json.changeAmount,
        loading:      false,
        error:        false,
        lastUpdated:  new Date(),
      })
    } catch {
      setData(prev => ({ ...prev, loading: false, error: true }))
    }
  }, [])

  useEffect(() => {
    fetchPrice()
    const interval = setInterval(fetchPrice, refreshInterval)
    return () => clearInterval(interval)
  }, [fetchPrice, refreshInterval])

  return data
}

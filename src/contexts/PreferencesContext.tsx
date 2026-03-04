'use client'

import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react'

export type Currency = 'USD' | 'EUR' | 'BRL'
export type TimeRange = '7d' | '30d' | '90d' | '1y'

const SYMBOLS: Record<Currency, string> = {
  USD: '$',
  EUR: '€',
  BRL: 'R$',
}

// Exported so consumers can build selects/tiles without hardcoding the list
export const CURRENCIES: Currency[] = ['USD', 'EUR', 'BRL']
export const CURRENCY_LABELS: Record<Currency, string> = {
  USD: 'USD ($)',
  EUR: 'EUR (€)',
  BRL: 'BRL (R$)',
}

// Fallback rates used before the API responds
const FALLBACK_RATES: Record<Currency, number> = {
  USD: 1,
  EUR: 0.92,
  BRL: 5.70,
}

interface PreferencesContextValue {
  currency:        Currency
  defaultRange:    TimeRange
  rates:           Record<Currency, number>
  ratesUpdatedAt:  string | null
  setCurrency:     (c: Currency) => void
  setDefaultRange: (r: TimeRange) => void
  fmtValue:        (usd: number) => string
}

const PreferencesContext = createContext<PreferencesContextValue>({
  currency:       'USD',
  defaultRange:   '30d',
  rates:          FALLBACK_RATES,
  ratesUpdatedAt: null,
  setCurrency:     () => {},
  setDefaultRange: () => {},
  fmtValue:        (v) => `$${v.toFixed(2)}`,
})

export function usePreferences() {
  return useContext(PreferencesContext)
}

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [currency,        setCurrencyState]     = useState<Currency>('USD')
  const [defaultRange,    setDefaultRangeState] = useState<TimeRange>('30d')
  const [rates,           setRates]             = useState<Record<Currency, number>>(FALLBACK_RATES)
  const [ratesUpdatedAt,  setRatesUpdatedAt]    = useState<string | null>(null)

  // ── Restore preferences from localStorage ─────────────────────────────────
  useEffect(() => {
    try {
      const c = localStorage.getItem('mb_currency') as Currency | null
      const r = localStorage.getItem('mb_range')    as TimeRange | null
      if (c && ['USD', 'EUR', 'BRL'].includes(c))       setCurrencyState(c)
      if (r && ['7d', '30d', '90d', '1y'].includes(r))  setDefaultRangeState(r)
    } catch {}
  }, [])

  // ── Fetch live exchange rates from our API route ───────────────────────────
  useEffect(() => {
    async function fetchRates() {
      try {
        const res  = await fetch('/api/exchange-rates')
        const data = await res.json()
        if (data.rates) {
          setRates({
            USD: 1,
            EUR: data.rates.EUR ?? FALLBACK_RATES.EUR,
            BRL: data.rates.BRL ?? FALLBACK_RATES.BRL,
          })
          setRatesUpdatedAt(data.updatedAt ?? null)
        }
      } catch {
        // Keep fallback rates silently
      }
    }

    fetchRates()

    // Re-fetch every hour to keep rates fresh
    const interval = setInterval(fetchRates, 60 * 60 * 1000)
    return () => clearInterval(interval)
  }, [])

  // ── Setters with localStorage persistence ─────────────────────────────────
  const setCurrency = (c: Currency) => {
    setCurrencyState(c)
    try { localStorage.setItem('mb_currency', c) } catch {}
  }

  const setDefaultRange = (r: TimeRange) => {
    setDefaultRangeState(r)
    try { localStorage.setItem('mb_range', r) } catch {}
  }

  // ── Format a USD value into the selected currency ──────────────────────────
  // Wrapped in useCallback so the reference only changes when currency or rates
  // change — prevents unnecessary re-renders of all context consumers.
  const fmtValue = useCallback((usd: number): string => {
    const rate   = rates[currency]
    const symbol = SYMBOLS[currency]
    const v      = usd * rate
    if (v >= 1_000_000) return `${symbol}${(v / 1_000_000).toFixed(2)}M`
    if (v >= 1_000)     return `${symbol}${(v / 1_000).toFixed(2)}K`
    if (v >= 1)         return `${symbol}${v.toFixed(2)}`
    if (v > 0)          return `${symbol}${v.toFixed(4)}`
    return `${symbol}0.00`
  }, [currency, rates])

  return (
    <PreferencesContext.Provider value={{
      currency, defaultRange, rates, ratesUpdatedAt,
      setCurrency, setDefaultRange, fmtValue,
    }}>
      {children}
    </PreferencesContext.Provider>
  )
}

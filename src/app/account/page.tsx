'use client'

import { useState } from 'react'
import { useWallet }        from '@/contexts/WalletContext'
import { usePortfolio }     from '@/contexts/PortfolioContext'
import { usePreferences }   from '@/contexts/PreferencesContext'
import type { Currency, TimeRange, Theme } from '@/contexts/PreferencesContext'
import { CURRENCIES, CURRENCY_LABELS } from '@/contexts/PreferencesContext'
import { User, Copy, ExternalLink, Shield, CheckCircle, Lock, Sun, Moon } from 'lucide-react'
import { shortenAddr } from '@/contexts/TransactionContext'

// Single stable object reference — avoids creating a new object on every render
const SORA = { fontFamily: 'Sora, sans-serif' } as const

export default function AccountPage() {
  const [copied, setCopied] = useState(false)
  const hasNFT = false

  const { address, isConnected, disconnect } = useWallet()
  const { totals, status } = usePortfolio()
  const { currency, defaultRange, theme, setCurrency, setDefaultRange, setTheme, fmtValue, rates, ratesUpdatedAt } = usePreferences()

  const isLoading = status === 'loading'

  const handleCopy = () => {
    if (!address) return
    navigator.clipboard.writeText(address)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-6 space-y-5">
      {/* Header */}
      <div>
        <h1 className="font-display text-2xl font-bold text-gray-900" style={SORA}>
          Account
        </h1>
        <p className="text-gray-500 text-sm mt-1">Manage your profile and preferences</p>
      </div>

      {/* Wallet Card */}
      <div className="card p-6 relative overflow-hidden" style={{ background: 'linear-gradient(135deg, #7C3AED 0%, #6d28d9 100%)' }}>
        <div className="absolute top-0 right-0 w-40 h-40 rounded-full opacity-10" style={{ background: 'radial-gradient(circle, white, transparent)', transform: 'translate(30%, -40%)' }} />
        <div className="flex items-start gap-4 relative z-10">
          <div className="w-16 h-16 rounded-2xl bg-white/20 flex items-center justify-center">
            <User size={28} className="text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <p className="text-white font-display font-bold text-lg" style={SORA}>My Wallet</p>
              {hasNFT && (
                <span className="px-2 py-0.5 rounded-full bg-white/20 text-white text-xs font-semibold">
                  ⭐ NFT Holder
                </span>
              )}
            </div>

            {isConnected && address ? (
              <>
                <div className="flex items-center gap-2">
                  <p className="text-violet-200 text-sm font-mono">{shortenAddr(address)}</p>
                  <button onClick={handleCopy} className="text-violet-200 hover:text-white transition-colors" title="Copy address">
                    {copied ? <CheckCircle size={14} /> : <Copy size={14} />}
                  </button>
                  <a
                    href={`https://explorer.inkonchain.com/address/${address}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-violet-200 hover:text-white transition-colors"
                    title="View on explorer"
                  >
                    <ExternalLink size={14} />
                  </a>
                </div>
                <p className="text-violet-200 text-sm mt-2">
                  Portfolio:{' '}
                  {isLoading ? (
                    <span className="inline-block w-20 h-4 bg-white/20 rounded animate-pulse align-middle" />
                  ) : (
                    <span className="text-white font-bold">{fmtValue(totals.totalValueUSD)}</span>
                  )}
                </p>
              </>
            ) : (
              <p className="text-violet-300 text-sm mt-1">No wallet connected</p>
            )}
          </div>
        </div>
      </div>

      {/* NFT Access Status */}
      <div className={`card p-5 border-2 ${hasNFT ? 'border-emerald-200 bg-emerald-50/30' : 'border-violet-200'}`}>
        <div className="flex items-start gap-4">
          <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${hasNFT ? 'bg-emerald-100' : 'bg-violet-100'}`}>
            {hasNFT ? <Shield size={22} className="text-emerald-600" /> : <Lock size={22} className="text-violet-500" />}
          </div>
          <div className="flex-1">
            <h3 className="font-display font-semibold text-gray-800" style={SORA}>
              {hasNFT ? '✅ Premium Access Unlocked' : 'InkBoard NFT Access'}
            </h3>
            {hasNFT ? (
              <p className="text-sm text-emerald-700 mt-1">You hold a InkBoard NFT and have access to all premium features including Telegram alerts and wallet monitoring.</p>
            ) : (
              <>
                <p className="text-sm text-gray-500 mt-1 mb-3">Hold a InkBoard NFT to unlock premium features:</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-4">
                  {[
                    { icon: '🔔', text: 'Real-time Telegram alerts' },
                    { icon: '👁️', text: 'Monitor other wallets' },
                    { icon: '📊', text: 'Advanced analytics' },
                    { icon: '⚡', text: 'Priority support' },
                  ].map(f => (
                    <div key={f.text} className="flex items-center gap-2 text-sm text-gray-600">
                      <span>{f.icon}</span>
                      {f.text}
                    </div>
                  ))}
                </div>
                <button className="btn-primary text-sm px-5">
                  Get InkBoard NFT — Coming Soon
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Settings */}
      <div className="card p-5">
        <h2 className="font-display font-semibold text-gray-800 mb-4" style={SORA}>Preferences</h2>
        <div className="space-y-4">
          {/* Theme */}
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-gray-800">Appearance</p>
              <p className="text-xs text-gray-400">Switch between light and dark mode</p>
            </div>
            <button
              onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
              className={`relative w-16 h-8 rounded-full transition-all duration-300 ${
                theme === 'dark'
                  ? 'bg-violet-600'
                  : 'bg-violet-100 border border-violet-200'
              }`}
              aria-label="Toggle theme"
            >
              <div
                className={`absolute top-1 w-6 h-6 rounded-full flex items-center justify-center transition-all duration-300 ${
                  theme === 'dark'
                    ? 'left-9 bg-violet-900'
                    : 'left-1 bg-white shadow-sm'
                }`}
              >
                {theme === 'dark'
                  ? <Moon size={14} className="text-violet-300" />
                  : <Sun size={14} className="text-violet-500" />
                }
              </div>
            </button>
          </div>

          {/* Currency */}
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-gray-800">Currency Display</p>
              <p className="text-xs text-gray-400">Show portfolio values in your preferred currency</p>
            </div>
            <select
              value={currency}
              onChange={e => setCurrency(e.target.value as Currency)}
              className="text-sm border border-violet-100 rounded-lg px-3 py-1.5 text-gray-700 bg-violet-50/30 focus:outline-none focus:border-violet-300"
            >
              {CURRENCIES.map(c => (
                <option key={c} value={c}>{CURRENCY_LABELS[c]}</option>
              ))}
            </select>
          </div>

          {/* Live exchange rates */}
          <div className="rounded-xl bg-violet-50/60 border border-violet-100 p-3">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-medium text-violet-700">Live Exchange Rates (vs USD)</p>
              {ratesUpdatedAt ? (
                <p className="text-[10px] text-violet-400">
                  Updated {new Date(ratesUpdatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                </p>
              ) : (
                <p className="text-[10px] text-violet-400">Fallback rates</p>
              )}
            </div>
            <div className="grid grid-cols-3 gap-2">
              {CURRENCIES.map(c => (
                <div
                  key={c}
                  onClick={() => setCurrency(c)}
                  className={`rounded-lg p-2 text-center cursor-pointer transition-all ${
                    currency === c
                      ? 'bg-violet-600 text-white'
                      : 'bg-white border border-violet-100 hover:border-violet-300'
                  }`}
                >
                  <p className={`text-xs font-bold ${currency === c ? 'text-white' : 'text-gray-700'}`}>{c}</p>
                  <p className={`text-[11px] mt-0.5 ${currency === c ? 'text-violet-200' : 'text-gray-400'}`}>
                    {c === 'USD' ? '1.0000' : rates[c].toFixed(4)}
                  </p>
                </div>
              ))}
            </div>
          </div>

          {/* Default time range */}
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-gray-800">Default Time Range</p>
              <p className="text-xs text-gray-400">Default range for portfolio history charts</p>
            </div>
            <select
              value={defaultRange}
              onChange={e => setDefaultRange(e.target.value as TimeRange)}
              className="text-sm border border-violet-100 rounded-lg px-3 py-1.5 text-gray-700 bg-violet-50/30 focus:outline-none focus:border-violet-300"
            >
              <option value="7d">7 Days</option>
              <option value="30d">30 Days</option>
              <option value="90d">90 Days</option>
              <option value="1y">1 Year</option>
            </select>
          </div>
        </div>
      </div>

      {/* About */}
      <div className="card p-5">
        <h2 className="font-display font-semibold text-gray-800 mb-3" style={SORA}>About InkBoard</h2>
        <p className="text-sm text-gray-500 mb-3">
          InkBoard is the premier portfolio dashboard for the Ink ecosystem. Track your assets, DeFi positions, and NFTs in one place.
        </p>
        <div className="flex flex-wrap gap-2">
          {[
            { label: 'Version', value: '0.1.0 (Beta)' },
            { label: 'Network', value: 'Ink Mainnet' },
            { label: 'RPC', value: 'rpc-gel.inkonchain.com' },
          ].map(info => (
            <div key={info.label} className="flex-1 min-w-[100px] bg-violet-50 rounded-lg p-3">
              <p className="text-xs text-gray-400">{info.label}</p>
              <p className="text-sm font-semibold text-gray-700">{info.value}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Disconnect */}
      {isConnected && (
        <button
          onClick={disconnect}
          className="w-full py-3 rounded-xl border-2 border-red-100 text-red-500 text-sm font-medium hover:bg-red-50 transition-colors"
        >
          Disconnect Wallet
        </button>
      )}
    </div>
  )
}

'use client'

import { ReactNode, useState } from 'react'
import { WagmiProvider } from 'wagmi'
import { defineChain } from 'viem'
import { RainbowKitProvider, getDefaultConfig, lightTheme } from '@rainbow-me/rainbowkit'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { WalletContextProvider } from '@/contexts/WalletContext'
import { PortfolioProvider }     from '@/contexts/PortfolioContext'
import { TransactionProvider }   from '@/contexts/TransactionContext'
import { PreferencesProvider }   from '@/contexts/PreferencesContext'

import '@rainbow-me/rainbowkit/styles.css'

export const inkMainnet = defineChain({
  id: 57073,
  name: 'Ink',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://rpc-gel.inkonchain.com'] },
  },
  blockExplorers: {
    default: { name: 'Ink Explorer', url: 'https://explorer.inkonchain.com' },
  },
})

const wcProjectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID
if (!wcProjectId && typeof window !== 'undefined') {
  console.warn('[InkBoard] NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID is not set. WalletConnect connections will be disabled.')
}

const wagmiConfig = getDefaultConfig({
  appName:   'InkBoard',
  projectId: wcProjectId ?? 'MISSING_WALLETCONNECT_PROJECT_ID',
  chains:    [inkMainnet],
  ssr:       false,
})

export function WalletProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: { queries: { staleTime: 60_000, retry: 1 } },
  }))

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider
          theme={lightTheme({
            accentColor: '#7C3AED',
            accentColorForeground: 'white',
            borderRadius: 'large',
            fontStack: 'system',
          })}
          locale="en-US"
        >
          <PreferencesProvider>
            <WalletContextProvider>
              <PortfolioProvider>
                <TransactionProvider>
                  {children}
                </TransactionProvider>
              </PortfolioProvider>
            </WalletContextProvider>
          </PreferencesProvider>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  )
}

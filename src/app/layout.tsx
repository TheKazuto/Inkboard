import type { Metadata } from 'next'
import Script from 'next/script'
import './globals.css'
import Navbar from '@/components/Navbar'
import BottomBar from '@/components/BottomBar'
import Providers from '@/components/Providers'

export const metadata: Metadata = {
  title: 'InkBoard — Your Ink DeFi Dashboard',
  description: 'The ultimate dashboard for the Ink ecosystem. Track your portfolio, DeFi positions, NFTs and get real-time alerts.',
  keywords: ['ink', 'blockchain', 'portfolio', 'defi', 'nft', 'dashboard', 'kraken', 'superchain'],
  icons: {
    icon: '/favicon.ico',
    apple: '/apple-touch-icon.png',
  },
  openGraph: {
    title: 'InkBoard',
    description: 'Your Ink DeFi Dashboard',
    type: 'website',
  },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body className="min-h-screen" style={{ background: 'var(--ink-bg)' }}>
        <Providers>
          <Navbar />
          <main className="page-content pt-16">
            {children}
          </main>
          <BottomBar />
        </Providers>
        {/* Adsterra Social Bar — loads once, self-renders as floating overlay */}
        <Script
          src="https://pl28844904.effectivegatecpm.com/68/ce/1d/68ce1d5a90edc273336da9c93f8a8bef.js"
          strategy="lazyOnload"
        />
      </body>
    </html>
  )
}

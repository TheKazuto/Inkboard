import type { Metadata } from 'next'
import Script from 'next/script'
import './globals.css'
import Navbar from '@/components/Navbar'
import BottomBar from '@/components/BottomBar'
import Providers from '@/components/Providers'

const ADSENSE_CLIENT = process.env.NEXT_PUBLIC_ADSENSE_CLIENT ?? ''

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
        {ADSENSE_CLIENT && (
          <Script
            async
            src={`https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${ADSENSE_CLIENT}`}
            crossOrigin="anonymous"
            strategy="lazyOnload"
          />
        )}
        <Providers>
          <Navbar />
          <main className="page-content pt-16">
            {children}
          </main>
          <BottomBar />
        </Providers>
      </body>
    </html>
  )
}

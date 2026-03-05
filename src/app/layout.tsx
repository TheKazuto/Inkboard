import type { Metadata } from 'next'
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
      <head>
        {/* RichAds push notification — must be type="module" as required */}
        <script
          type="module"
          src="https://richinfo.co/richpartners/push/js/rp-cl-ob.js?pubid=1004166&siteid=389833&niche=33"
          async
          data-cfasync="false"
        />
      </head>
      <body className="min-h-screen" style={{ background: 'var(--ink-bg)' }}>
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

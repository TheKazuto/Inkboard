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
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Prevent flash of wrong theme — runs before React hydration */}
        <script dangerouslySetInnerHTML={{ __html: `
          try {
            var t = localStorage.getItem('mb_theme');
            if (t === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
          } catch(e) {}
        ` }} />
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

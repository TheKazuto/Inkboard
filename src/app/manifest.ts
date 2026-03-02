import type { MetadataRoute } from 'next'

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'InkBoard',
    short_name: 'InkBoard',
    description: 'Your Ink DeFi Dashboard',
    start_url: '/',
    display: 'standalone',
    background_color: '#f5f3ff',
    theme_color: '#7C3AED',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
  }
}

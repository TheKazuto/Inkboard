/** @type {import('next').NextConfig} */

// ─── OpenNext Cloudflare — local dev integration ────────────────────────────
const { initOpenNextCloudflareForDev } = require("@opennextjs/cloudflare");
if (process.env.NODE_ENV === "development") {
  initOpenNextCloudflareForDev();
}

// ─── Content-Security-Policy ────────────────────────────────────────────────
const CSP = [
  "default-src 'self'",

  // Scripts: RichAds requires unsafe-eval + unsafe-inline
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://richinfo.co https://*.richinfo.co https://*.richads.com https://*.push.world",

  // Styles
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",

  // Fonts
  "font-src 'self' https://fonts.gstatic.com data:",

  // Images: allow HTTP + HTTPS (ad creatives may use HTTP)
  "img-src 'self' data: blob: http: https:",

  // Connections: upstream APIs + ad networks
  [
    "connect-src 'self'",
    "https://rpc-gel.inkonchain.com",
    "https://rpc-qnd.inkonchain.com",
    "https://api.coingecko.com",
    "https://pro-api.coingecko.com",
    "https://api.geckoterminal.com",
    "https://tokens.coingecko.com",
    "https://api.etherscan.io",
    "https://api-v2.rubic.exchange",
    "https://api-mainnet.magiceden.dev",
    "https://open.er-api.com",
    "https://api.alternative.me",
    "https://api.lagoon.finance",
    "https://app.renzoprotocol.com",
    "wss://relay.walletconnect.com",
    "wss://relay.walletconnect.org",
    "https://relay.walletconnect.com",
    "https://relay.walletconnect.org",
    "https://api.web3modal.com",
    "https://pulse.walletconnect.org",
    "https://rainbowkit.com",
    "https://ethereum-rpc.publicnode.com",
    "https://bsc-rpc.publicnode.com",
    "https://polygon-rpc.com",
    "https://arb1.arbitrum.io",
    "https://mainnet.optimism.io",
    "https://mainnet.base.org",
    "https://api.avax.network",
    "https://richinfo.co",
    "https://*.richinfo.co",
    "https://*.richads.com",
    "https://*.push.world",
    "https://api.web3modal.org",
    "https://api-core.curve.finance",
    "https://inkyswap.com",
    "https://yields.llama.fi",
    "https://ink.drpc.org",
    "https://icons.llamao.fi",
    "https://li.quest",
    "https://ipfs.io",
    "https://gateway.pinata.cloud",
    "https://api.opensea.io",
    "https://explorer.inkonchain.com",
  ].join(' '),

  // Frames
  "frame-src 'self' http: https:",

  // Workers: RichAds registers a service worker for push notifications
  "worker-src 'self' blob: https://richinfo.co https://*.richinfo.co",

  // Block plugins
  "object-src 'none'",
].join('; ')

const nextConfig = {
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'assets.coingecko.com' },
      { protocol: 'https', hostname: 'coin-images.coingecko.com' },
      { protocol: 'https', hostname: 'raw.githubusercontent.com' },
      { protocol: 'https', hostname: 'api.geckoterminal.com' },
      { protocol: 'https', hostname: 'ipfs.io' },
      { protocol: 'https', hostname: 'gateway.pinata.cloud' },
      { protocol: 'https', hostname: 'icons.llamao.fi' },
    ],
  },

  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'Content-Security-Policy', value: CSP },
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()' },
          { key: 'X-XSS-Protection', value: '0' },
          { key: 'X-Permitted-Cross-Domain-Policies', value: 'none' },
        ],
      },
    ]
  },
}

module.exports = nextConfig

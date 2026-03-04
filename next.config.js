/** @type {import('next').NextConfig} */

// ─── OpenNext Cloudflare — local dev integration ────────────────────────────
const { initOpenNextCloudflareForDev } = require("@opennextjs/cloudflare");
if (process.env.NODE_ENV === "development") {
  initOpenNextCloudflareForDev();
}

// ─── Strict Content-Security-Policy ──────────────────────────────────────────
// Removes unsafe-eval and unsafe-inline from script-src.
// RainbowKit/wagmi use style attributes on DOM elements, not <style> tags,
// so 'unsafe-inline' in style-src is still required but harmless (can't exec JS).
const CSP = [
  "default-src 'self'",

  // Scripts: self + unsafe-inline (required by Next.js 14 SSR hydration scripts)
  // unsafe-eval remains REMOVED — prevents eval()/Function() injection attacks.
  // Adsterra scripts only run inside /ad.html (has its own permissive CSP).
  "script-src 'self' 'unsafe-inline'",

  // Styles: unsafe-inline is OK here — it cannot cause script execution
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",

  // Fonts
  "font-src 'self' https://fonts.gstatic.com data:",

  // Images: allow all HTTPS sources. NFT images come from unpredictable hosts
  // so a fixed allowlist always breaks things. img-src cannot execute scripts —
  // there is no XSS risk here. http: is still blocked; only https: is allowed.
  "img-src 'self' data: blob: https:",

  // Connections: every upstream API, RPC, and WalletConnect endpoint
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

  // Frames: 'self' for /ad.html iframe + Adsterra domains for nested ad frames
  "frame-src 'self' https://*.effectivegatecpm.com https://*.effectiveperformancenetwork.com https://*.adsterra.com https://*.adstera.com",

  // Workers
  "worker-src 'self' blob:",

  // Block plugins (Flash, etc.)
  "object-src 'none'",

  // Force HTTPS for all sub-resources
  "upgrade-insecure-requests",
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
          // Fix #1 (CRÍTICO): Strict CSP — removes unsafe-eval/unsafe-inline from script-src
          // /ad.html has its own permissive CSP via <meta> tag (not affected by this header)
          { key: 'Content-Security-Policy', value: CSP },

          // Fix #14 (MÉDIO): Previously missing security headers
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

  // Fix #16 (BAIXO): TypeScript and ESLint are now enforced on every build.
  // Removed: eslint: { ignoreDuringBuilds: true }
  // Removed: typescript: { ignoreBuildErrors: true }
}

module.exports = nextConfig

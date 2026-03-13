/** @type {import('next').NextConfig} */

// ─── OpenNext Cloudflare — local dev integration ────────────────────────────
const { initOpenNextCloudflareForDev } = require("@opennextjs/cloudflare");
if (process.env.NODE_ENV === "development") {
  initOpenNextCloudflareForDev();
}

// ─── CSP and security headers are applied via middleware.ts ──────────────────
// next.config.js headers() does NOT work on Cloudflare Workers with OpenNext.

const nextConfig = {
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'assets.coingecko.com' },
      { protocol: 'https', hostname: 'coin-images.coingecko.com' },
      { protocol: 'https', hostname: 'raw.githubusercontent.com' },
      { protocol: 'https', hostname: 'api.geckoterminal.com' },
      { protocol: 'https', hostname: 'assets.geckoterminal.com' },  // token images
      { protocol: 'https', hostname: 'ipfs.io' },
      { protocol: 'https', hostname: 'gateway.pinata.cloud' },
      { protocol: 'https', hostname: 'icons.llamao.fi' },
    ],
  },
}

module.exports = nextConfig

/** @type {import('next').NextConfig} */

// ─── OpenNext Cloudflare — local dev integration ────────────────────────────
const { initOpenNextCloudflareForDev } = require("@opennextjs/cloudflare");
if (process.env.NODE_ENV === "development") {
  initOpenNextCloudflareForDev();
}

// ─── CSP and security headers are now applied via middleware.ts ──────────────
// This allows conditional exclusion of /api/ad (Adsterra ad iframe).

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

  // Fix #16 (BAIXO): TypeScript and ESLint are now enforced on every build.
  // Removed: eslint: { ignoreDuringBuilds: true }
  // Removed: typescript: { ignoreBuildErrors: true }
}

module.exports = nextConfig

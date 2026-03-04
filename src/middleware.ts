import { NextRequest, NextResponse } from 'next/server'

// ─── CSP ─────────────────────────────────────────────────────────────────────
// Strict Content-Security-Policy for all pages EXCEPT /api/ad (ad iframe).
// Moved here from next.config.js headers() so we can exclude /api/ad.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob: https:",
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
  "frame-src 'self' https://*.effectivegatecpm.com https://*.effectiveperformancenetwork.com https://*.adsterra.com https://*.adstera.com",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "upgrade-insecure-requests",
].join('; ')

const SECURITY_HEADERS: [string, string][] = [
  ['Content-Security-Policy', CSP],
  ['Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload'],
  ['X-Frame-Options', 'SAMEORIGIN'],
  ['X-Content-Type-Options', 'nosniff'],
  ['Referrer-Policy', 'strict-origin-when-cross-origin'],
  ['Permissions-Policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()'],
  ['X-XSS-Protection', '0'],
  ['X-Permitted-Cross-Domain-Policies', 'none'],
]

// ─── Rate limiter ────────────────────────────────────────────────────────────
interface RateEntry { count: number; resetAt: number }
const store = new Map<string, RateEntry>()

const WINDOW_MS = 60_000

const ROUTE_LIMITS: Record<string, number> = {
  '/api/approvals-logs': 10,
  '/api/nfts':           10,
  '/api/defi':           15,
  '/api/best-aprs':      12,
  '/api/transactions':   20,
  '/api/portfolio-history': 20,
  '/api/token-exposure': 30,
  default:               60,
}

function getLimit(pathname: string): number {
  for (const [route, limit] of Object.entries(ROUTE_LIMITS)) {
    if (route !== 'default' && pathname.startsWith(route)) return limit
  }
  return ROUTE_LIMITS.default
}

function getClientIp(req: NextRequest): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    req.headers.get('x-real-ip') ??
    'unknown'
  )
}

// ─── Middleware ───────────────────────────────────────────────────────────────

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl

  // ── /api/ad: ad iframe — NO strict CSP, NO rate limiting
  if (pathname === '/api/ad') {
    return NextResponse.next()
  }

  // ── Non-API routes: apply security headers only
  if (!pathname.startsWith('/api/')) {
    const res = NextResponse.next()
    for (const [key, value] of SECURITY_HEADERS) {
      res.headers.set(key, value)
    }
    return res
  }

  // ── API routes: rate limiting + security headers
  const ip    = getClientIp(req)
  const key   = `${ip}::${pathname}`
  const now   = Date.now()
  const limit = getLimit(pathname)

  const entry = store.get(key)
  if (!entry || now > entry.resetAt) {
    store.set(key, { count: 1, resetAt: now + WINDOW_MS })
    const res = addRateLimitHeaders(NextResponse.next(), 1, limit, now + WINDOW_MS)
    for (const [k, v] of SECURITY_HEADERS) res.headers.set(k, v)
    return res
  }

  entry.count++
  if (entry.count > limit) {
    const retryAfter = Math.ceil((entry.resetAt - now) / 1000)
    return new NextResponse(
      JSON.stringify({ error: 'Too many requests', retryAfter }),
      {
        status: 429,
        headers: {
          'Content-Type':    'application/json',
          'Retry-After':     String(retryAfter),
          'X-RateLimit-Limit':     String(limit),
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset':     String(Math.floor(entry.resetAt / 1000)),
        },
      }
    )
  }

  const res = addRateLimitHeaders(NextResponse.next(), entry.count, limit, entry.resetAt)
  for (const [k, v] of SECURITY_HEADERS) res.headers.set(k, v)
  return res
}

function addRateLimitHeaders(
  res: NextResponse,
  count: number,
  limit: number,
  resetAt: number,
): NextResponse {
  res.headers.set('X-RateLimit-Limit',     String(limit))
  res.headers.set('X-RateLimit-Remaining', String(Math.max(0, limit - count)))
  res.headers.set('X-RateLimit-Reset',     String(Math.floor(resetAt / 1000)))
  return res
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon\\.ico|apple-touch-icon\\.png|ink-logo\\.jpg|inkboard-logo\\.png|ads\\.txt).*)',],
}

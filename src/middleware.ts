import { NextRequest, NextResponse } from 'next/server'

// ─── CSP ─────────────────────────────────────────────────────────────────────
// Applied via middleware because next.config.js headers() does NOT work
// on Cloudflare Workers with OpenNext.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://richinfo.co https://*.richinfo.co https://*.richads.com https://*.push.world https://www.gstatic.com https://*.googleapis.com https://*.firebaseio.com https://*.firebase.googleapis.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob: http: https:",
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
    "https://www.gstatic.com",
    "https://*.googleapis.com",
    "https://*.firebaseio.com",
    "https://*.firebase.googleapis.com",
    "https://fcmregistrations.googleapis.com",
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
  "frame-src 'self' http: https:",
  "worker-src 'self' blob: https://richinfo.co https://*.richinfo.co",
  "object-src 'none'",
].join('; ')

function setSecurityHeaders(res: NextResponse): void {
  res.headers.set('Content-Security-Policy', CSP)
  res.headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload')
  res.headers.set('X-Frame-Options', 'SAMEORIGIN')
  res.headers.set('X-Content-Type-Options', 'nosniff')
  res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')
  res.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()')
  res.headers.set('X-XSS-Protection', '0')
  res.headers.set('X-Permitted-Cross-Domain-Policies', 'none')
}

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

  // Non-API routes: just apply security headers
  if (!pathname.startsWith('/api/')) {
    const res = NextResponse.next()
    setSecurityHeaders(res)
    return res
  }

  // API routes: security headers + rate limiting
  const ip    = getClientIp(req)
  const key   = `${ip}::${pathname}`
  const now   = Date.now()
  const limit = getLimit(pathname)

  const entry = store.get(key)
  if (!entry || now > entry.resetAt) {
    store.set(key, { count: 1, resetAt: now + WINDOW_MS })
    const res = NextResponse.next()
    setSecurityHeaders(res)
    res.headers.set('X-RateLimit-Limit',     String(limit))
    res.headers.set('X-RateLimit-Remaining', String(limit - 1))
    res.headers.set('X-RateLimit-Reset',     String(Math.floor((now + WINDOW_MS) / 1000)))
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

  const res = NextResponse.next()
  setSecurityHeaders(res)
  res.headers.set('X-RateLimit-Limit',     String(limit))
  res.headers.set('X-RateLimit-Remaining', String(Math.max(0, limit - entry.count)))
  res.headers.set('X-RateLimit-Reset',     String(Math.floor(entry.resetAt / 1000)))
  return res
}

// Match ALL routes (pages + API) — excludes only static assets
export const config = {
  matcher: '/((?!_next/static|_next/image|favicon\\.ico|apple-touch-icon\\.png|ink-logo\\.jpg|inkboard-logo\\.png|ads\\.txt).*)',
}

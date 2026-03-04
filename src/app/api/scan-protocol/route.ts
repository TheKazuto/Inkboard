import { NextResponse } from 'next/server'

export const revalidate = 0

// ─── INK CHAIN IDENTIFIERS ───────────────────────────────────────────────────
// Used to detect if a protocol's JS bundles reference the Ink chain
const INK_CHAIN_ID    = 57073
const INK_CHAIN_HEX   = '0xDEE1'  // 57073 in hex
const INK_IDENTIFIERS = [
  String(INK_CHAIN_ID), INK_CHAIN_HEX.toLowerCase(), 'inkonchain', 'ink_mainnet',
  'ink-mainnet', 'chainId:57073', 'chainid:57073', '"ink"',
]

// ─── Known Ink DeFi contracts (for cross-referencing) ────────────────────────
const KNOWN_INK_CONTRACTS: Record<string, string> = {
  '0x4200000000000000000000000000000000000006': 'WETH',
  '0xf1815bd50389c46847f0bda824ec8da914045d14': 'USDC.e',
  '0x0200c29006150606b650577bbe7b6248f58470c1': 'USDT0',
  '0x39fec550cc6ddced810eccfa9b2931b4b5f2344d': 'crvUSD',
  '0x80eede496655fb9047dd39d9f418d5483ed600df': 'frxUSD',
  '0x5bff88ca1442c2496f7e475e9e7786383bc070c0': 'sfrxUSD',
  '0x43edd7f3831b08fe70b7555ddd373c8bf65a9050': 'frxETH',
  '0x3ec3849c33291a9ef4c5db86de593eb4a37fde45': 'sfrxETH',
  '0xac73671a1762fe835208fb93b7ae7490d1c2ccb3': 'CRV',
  '0x64445f0aecc51e94ad52d8ac56b7190e764e561a': 'FXS',
}

// ─── DeFi relevance keywords (for scoring endpoints) ─────────────────────────
const DEFI_KEYWORDS = [
  'pool', 'pools', 'liquidity', 'swap', 'trade', 'tvl', 'apr', 'apy',
  'yield', 'vault', 'vaults', 'farm', 'farms', 'stake', 'staking',
  'lend', 'borrow', 'supply', 'reserve', 'market', 'markets',
  'position', 'positions', 'gauge', 'gauges', 'reward', 'rewards',
  'price', 'prices', 'token', 'tokens', 'balance', 'volume',
  'getPools', 'getPool', 'getVaults', 'getMarkets', 'getReserves',
  'factory', 'router', 'pair', 'pairs', 'quote', 'route', 'routes',
]

// ─── SSRF protection ─────────────────────────────────────────────────────────
const PRIVATE_IP_RE = /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.|169\.254\.|0\.|::1|fc00:|fd)/
const BLOCKED_HOSTNAMES = ['localhost', 'metadata.google.internal', 'metadata.google']

function isSafeUrl(url: string): boolean {
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false
    if (PRIVATE_IP_RE.test(u.hostname)) return false
    if (BLOCKED_HOSTNAMES.some(h => u.hostname === h || u.hostname.endsWith('.' + h))) return false
    if (u.hostname.endsWith('.local') || u.hostname.endsWith('.internal')) return false
    return true
  } catch { return false }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function safeFetch(url: string, opts?: RequestInit): Promise<{ ok: boolean; status: number; text: string; error?: string }> {
  if (!isSafeUrl(url)) {
    return { ok: false, status: 0, text: '', error: 'Blocked: unsafe URL' }
  }
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(12_000),
      cache: 'no-store',
      headers: {
        'User-Agent': 'Inkboard-Scanner/1.0 (+https://inkboard.pro)',
        'Accept': '*/*',
      },
      ...opts,
    })
    const text = await res.text().catch(() => '')
    return { ok: res.ok, status: res.status, text }
  } catch (e: any) {
    return { ok: false, status: 0, text: '', error: e.message }
  }
}

function extractScriptUrls(html: string, baseUrl: string): string[] {
  const base = new URL(baseUrl)
  const urls: string[] = []
  const srcRe = /<script[^>]+src=["']([^"']+)["']/gi
  let m: RegExpExecArray | null
  while ((m = srcRe.exec(html)) !== null) {
    try {
      const u = new URL(m[1], base.origin)
      urls.push(u.href)
    } catch { /* skip */ }
  }
  return [...new Set(urls)]
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface DiscoveredEndpoint {
  url:        string
  kind:       string
  context:    string
  source:     string
  relevance:  number
  defiHints:  string[]
}

// ─── Score an endpoint for DeFi relevance ────────────────────────────────────
function scoreDeFiRelevance(url: string, context: string): { score: number; hints: string[] } {
  const combined = (url + ' ' + context).toLowerCase()
  const hints: string[] = []
  let score = 0

  for (const kw of DEFI_KEYWORDS) {
    if (combined.includes(kw.toLowerCase())) {
      hints.push(kw)
      score += 10
    }
  }

  // Bonus for subgraph/TheGraph endpoints
  if (combined.includes('subgraph') || combined.includes('thegraph')) { score += 20; hints.push('subgraph') }
  // Bonus for known DeFi API providers
  if (combined.includes('defillama') || combined.includes('llama.fi')) { score += 15; hints.push('defillama') }
  if (combined.includes('coingecko') || combined.includes('geckoterm')) { score += 10; hints.push('coingecko') }
  if (combined.includes('dexscreener')) { score += 10; hints.push('dexscreener') }
  // Bonus for GraphQL
  if (combined.includes('graphql') || combined.includes('gql')) { score += 5; hints.push('graphql') }
  // Bonus for versioned REST APIs
  if (/\/v[1-4]\//.test(url)) { score += 5; hints.push('versioned-api') }

  return { score: Math.min(100, score), hints }
}

// ─── Extract API patterns from JS bundle text ────────────────────────────────
function extractApiPatterns(js: string, sourceUrl: string): DiscoveredEndpoint[] {
  const found: DiscoveredEndpoint[] = []
  const seen = new Set<string>()

  function add(url: string, kind: string, context: string) {
    const key = `${kind}::${url}`
    if (seen.has(key)) return
    seen.add(key)
    const { score, hints } = scoreDeFiRelevance(url, context)
    found.push({ url, kind, context: context.slice(0, 150).trim(), source: sourceUrl, relevance: score, defiHints: hints })
  }

  let m: RegExpExecArray | null

  // 1. Full HTTPS URLs that look like APIs
  const httpsRe = /["'`](https?:\/\/[a-z0-9._\-\/]+(?:api|graphql|gql|rpc|v\d|subgraph)[a-z0-9._\-\/]*(?:\?[^"'`\s]{0,100})?)["'`]/gi
  while ((m = httpsRe.exec(js)) !== null) {
    const url = m[1]
    if (url.length > 10 && url.length < 300) {
      const ctx = js.slice(Math.max(0, m.index - 60), m.index + url.length + 60)
      add(url, 'https-api', ctx)
    }
  }

  // 2. Relative /api/... paths
  const relApiRe = /["'`](\/api\/[a-z0-9._\-\/]+)["'`]/gi
  while ((m = relApiRe.exec(js)) !== null) {
    const ctx = js.slice(Math.max(0, m.index - 60), m.index + m[1].length + 60)
    add(m[1], 'relative-api', ctx)
  }

  // 3. fetch( or axios calls with URL
  const fetchRe = /(?:fetch|axios\.(?:get|post|put|request))\(\s*["'`]([^"'`\s]{5,200})["'`]/g
  while ((m = fetchRe.exec(js)) !== null) {
    const url = m[1]
    if (!url.startsWith('data:') && !url.startsWith('blob:')) {
      const ctx = js.slice(Math.max(0, m.index - 30), m.index + url.length + 30)
      add(url, 'fetch-call', ctx)
    }
  }

  // 4. GraphQL endpoint patterns
  const gqlRe = /["'`]([^"'`\s]*(?:graphql|gql|subgraph)[^"'`\s]*)["'`]/gi
  while ((m = gqlRe.exec(js)) !== null) {
    const ctx = js.slice(Math.max(0, m.index - 60), m.index + m[1].length + 60)
    add(m[1], 'graphql', ctx)
  }

  // 5. WebSocket endpoints
  const wsRe = /["'`](wss?:\/\/[^"'`\s]{5,200})["'`]/g
  while ((m = wsRe.exec(js)) !== null) {
    const ctx = js.slice(Math.max(0, m.index - 40), m.index + m[1].length + 40)
    add(m[1], 'websocket', ctx)
  }

  // 6. Base URL variables
  const baseVarRe = /(?:baseURL|apiUrl|API_URL|BASE_URL|baseUrl|apiBase|API_BASE|API_ENDPOINT)\s*[:=]\s*["'`]([^"'`\s]{5,200})["'`]/g
  while ((m = baseVarRe.exec(js)) !== null) {
    const ctx = js.slice(Math.max(0, m.index - 20), m.index + m[1].length + 40)
    add(m[1], 'base-url-var', ctx)
  }

  // 7. DeFi-specific URL patterns (broader match for pool/vault/farm URLs)
  const defiUrlRe = /["'`](https?:\/\/[^"'`\s]{5,200}(?:pool|vault|farm|stake|lend|swap|liquidity|reserve|market|gauge|reward|apr|apy|tvl|yield)[^"'`\s]{0,100})["'`]/gi
  while ((m = defiUrlRe.exec(js)) !== null) {
    const url = m[1]
    if (url.length < 300 && !seen.has(`defi-url::${url}`)) {
      const ctx = js.slice(Math.max(0, m.index - 40), m.index + url.length + 40)
      add(url, 'defi-url', ctx)
    }
  }

  // 8. Contract addresses
  const addrRe = /["'`](0x[a-fA-F0-9]{40})["'`]/g
  const addrs = new Set<string>()
  while ((m = addrRe.exec(js)) !== null) addrs.add(m[1].toLowerCase())
  if (addrs.size > 0 && addrs.size < 200) {
    for (const addr of addrs) {
      if (!seen.has(`contract::${addr}`)) {
        seen.add(`contract::${addr}`)
        const label = KNOWN_INK_CONTRACTS[addr]
        found.push({
          url: addr, kind: 'contract-address',
          context: label ? `Known Ink token: ${label}` : '',
          source: sourceUrl, relevance: label ? 50 : 0, defiHints: label ? ['ink-token'] : [],
        })
      }
    }
  }

  return found
}

// ─── Detect Ink chain support in JS source ───────────────────────────────────
function detectInkSupport(js: string): { supported: boolean; evidence: string[] } {
  const lower = js.toLowerCase()
  const evidence: string[] = []

  for (const id of INK_IDENTIFIERS) {
    if (lower.includes(id.toLowerCase())) evidence.push(id)
  }

  for (const [addr, label] of Object.entries(KNOWN_INK_CONTRACTS)) {
    if (lower.includes(addr)) evidence.push(`contract:${label}(${addr.slice(0, 10)}...)`)
  }

  return { supported: evidence.length > 0, evidence: [...new Set(evidence)] }
}

// ─── Deduplicate ─────────────────────────────────────────────────────────────
function deduplicate(endpoints: DiscoveredEndpoint[]): DiscoveredEndpoint[] {
  const seen = new Map<string, DiscoveredEndpoint>()
  for (const e of endpoints) {
    const existing = seen.get(e.url)
    if (!existing || e.relevance > existing.relevance) seen.set(e.url, e)
  }
  return [...seen.values()]
}

// ─── Noise filter — Ink ecosystem focused ────────────────────────────────────
const NOISE_DOMAINS = [
  // Block explorers
  'etherscan.io', 'arbiscan.io', 'bscscan.com', 'polygonscan.com', 'snowtrace.io',
  'ftmscan.com', 'celoscan.io', 'basescan.org', 'fraxscan.com', 'gnosisscan.io',
  'moonscan.io', 'aurorascan.dev', 'mantlescan.xyz', 'routescan.io', 'oklink.com',
  'kavascan.com', 'scrollscan.com', 'lineascan.build', 'blastscan.io',
  // RPC providers
  'drpc.org', 'thirdweb.com', 'blastapi.io', 'nodies.app', 'ankr.com',
  'infura.io', 'alchemy.com', 'quicknode.com', 'chainnodes.org', '1rpc.io',
  'publicnode.com', 'llamarpc.com',
  // Chain RPCs
  'arbitrum.io/rpc', 'mainnet.optimism.io', 'mainnet.base.org',
  'polygon-rpc.com', 'rpc.ftm.tools', 'rpc.gnosischain.com',
  'rpc.mantle.xyz', 'rpc.blast.io', 'rpc.scroll.io', 'rpc.linea.build',
  'era.zksync.io', 'rpc-gel.inkonchain.com',
  // Analytics / tracking
  'freshping.io', 'sentry.io', 'intercom.io', 'hotjar.com',
  'google-analytics.com', 'googletagmanager.com', 'segment.io',
  'mixpanel.com', 'amplitude.com', 'datadog-agent',
  // Governance (not pool data)
  'governance.aave.com', 'snapshot.org',
]

const NOISE_PATTERNS = ['/rpc', '.rpc.', 'rpc.publicnode', '/etherscan', 'gasstation', 'blockexplorer']

// Domains that should NEVER be filtered (known DeFi data sources)
const KEEP_DOMAINS = [
  'api.curve.fi', 'api-core.curve.finance', 'curve.finance',
  'interface.gateway.uniswap.org', 'api.uniswap.org',
  'api.thegraph.com', 'gateway.thegraph.com',
  'yields.llama.fi', 'api.llama.fi', 'coins.llama.fi',
  'api.dexscreener.com', 'api.coingecko.com', 'api.geckoterminal.com',
  'api.1inch.dev', 'api.1inch.io', 'api.paraswap.io',
  'api.velodrome.finance', 'api.aerodrome.finance',
  'api.aave.com', 'aave-api-v2.aave.com',
  'api.compound.finance', 'api.frax.finance', 'api.frax.io',
  'api.morpho.org', 'api.morpho.xyz', 'api.euler.finance',
  'api.silo.finance', 'api.pendle.finance',
  'api.beefy.finance', 'api.yearn.fi', 'api.yearn.finance',
  'li.quest',
]

function isNoise(url: string, targetOrigin: string): boolean {
  try {
    const full = url.startsWith('/') ? targetOrigin + url : url
    const u = new URL(full)
    if (KEEP_DOMAINS.some(d => u.hostname === d || u.hostname.endsWith('.' + d))) return false
    if (NOISE_DOMAINS.some(d => u.hostname.endsWith(d) || full.includes(d))) return true
    if (NOISE_PATTERNS.some(p => full.includes(p))) return true
    if (u.pathname === '/rpc' || u.pathname === '' || u.pathname === '/') return true
  } catch { /* keep */ }
  return false
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export async function GET(req: Request) {
  const params  = new URL(req.url).searchParams
  const target  = params.get('url')

  if (!target) {
    return NextResponse.json({
      error: 'Missing ?url= parameter',
      usage: '/api/scan-protocol?url=https://curve.fi/#/ink/pools',
      description: 'Scans a DeFi protocol frontend for API endpoints, subgraphs, and contract addresses relevant to the Ink ecosystem (chain 57073).',
    }, { status: 400 })
  }

  let targetUrl: URL
  try { targetUrl = new URL(target) } catch {
    return NextResponse.json({ error: 'Invalid URL' }, { status: 400 })
  }

  if (!isSafeUrl(target)) {
    return NextResponse.json({ error: 'URL blocked: only public HTTPS URLs are allowed' }, { status: 400 })
  }

  const log: string[] = []
  const allEndpoints: DiscoveredEndpoint[] = []
  let inkEvidence: string[] = []

  // Step 1: Fetch the main page HTML
  log.push(`[1/5] Fetching ${targetUrl.href}`)
  const page = await safeFetch(targetUrl.href)
  if (!page.ok) {
    return NextResponse.json({
      error: `Could not fetch page: HTTP ${page.status} — ${page.error ?? 'unknown'}`,
      url: targetUrl.href,
    }, { status: 502 })
  }
  log.push(`Page fetched — ${page.text.length} chars`)

  // Check if main HTML references Ink chain
  const htmlInk = detectInkSupport(page.text)
  if (htmlInk.supported) {
    inkEvidence.push(...htmlInk.evidence)
    log.push(`Ink chain detected in HTML: ${htmlInk.evidence.join(', ')}`)
  }

  // Step 2: Extract API patterns from inline scripts
  log.push('[2/5] Scanning inline scripts...')

  if (page.text.includes('__NEXT_DATA__')) {
    log.push('  Detected Next.js — extracting __NEXT_DATA__')
    const ndMatch = page.text.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)
    if (ndMatch) {
      const nextPatterns = extractApiPatterns(ndMatch[1], targetUrl.href + '#__NEXT_DATA__')
      allEndpoints.push(...nextPatterns)
      log.push(`  __NEXT_DATA__: ${nextPatterns.length} patterns`)
    }
  }

  const inlineRe = /<script(?:\s[^>]*)?>(?!.*src=)([\s\S]*?)<\/script>/gi
  let im: RegExpExecArray | null
  let inlineCount = 0
  while ((im = inlineRe.exec(page.text)) !== null) {
    if (im[1].length < 50) continue
    const patterns = extractApiPatterns(im[1], targetUrl.href + '#inline')
    allEndpoints.push(...patterns)
    inlineCount += patterns.length
    const inlineInk = detectInkSupport(im[1])
    if (inlineInk.supported) inkEvidence.push(...inlineInk.evidence)
  }
  if (inlineCount > 0) log.push(`  Inline scripts: ${inlineCount} patterns`)

  // Step 3: Find external JS bundles
  log.push('[3/5] Finding JS bundles...')
  const scriptUrls = extractScriptUrls(page.text, targetUrl.href)

  const appBundles = scriptUrls.filter(u => {
    const lower = u.toLowerCase()
    return !lower.includes('gtag') && !lower.includes('analytics') &&
           !lower.includes('intercom') && !lower.includes('hotjar') &&
           !lower.includes('sentry') && !lower.includes('crisp') &&
           !lower.includes('segment') && !lower.includes('mixpanel')
  }).slice(0, 15)

  log.push(`  ${scriptUrls.length} total scripts, ${appBundles.length} app bundles to scan`)

  // Step 4: Fetch and scan bundles in parallel
  log.push('[4/5] Scanning bundles...')
  const bundleResults = await Promise.allSettled(
    appBundles.map(async (scriptUrl) => {
      const res = await safeFetch(scriptUrl)
      if (!res.ok || res.text.length < 100) return []
      const bundleInk = detectInkSupport(res.text)
      if (bundleInk.supported) inkEvidence.push(...bundleInk.evidence)
      const patterns = extractApiPatterns(res.text, scriptUrl)
      const fname = scriptUrl.split('/').pop()?.slice(0, 40) ?? '?'
      log.push(`  ${fname}: ${patterns.length} patterns${bundleInk.supported ? ' [INK]' : ''}`)
      return patterns
    })
  )

  for (const r of bundleResults) {
    if (r.status === 'fulfilled') allEndpoints.push(...r.value)
  }

  // Step 5: Process results
  log.push('[5/5] Processing results...')
  const deduped = deduplicate(allEndpoints)

  const apis      = deduped.filter(e => e.kind !== 'contract-address').sort((a, b) => b.relevance - a.relevance || a.url.localeCompare(b.url))
  const contracts = deduped.filter(e => e.kind === 'contract-address')

  const relevantApis = apis.filter(e => !isNoise(e.url, targetUrl.origin))
  const defiApis     = relevantApis.filter(e => e.relevance >= 10)
  const otherApis    = relevantApis.filter(e => e.relevance < 10)

  function groupByDomain(endpoints: DiscoveredEndpoint[]): Record<string, DiscoveredEndpoint[]> {
    const byDomain: Record<string, DiscoveredEndpoint[]> = {}
    for (const e of endpoints) {
      let domain: string
      try { domain = new URL(e.url.startsWith('/') ? targetUrl.origin + e.url : e.url).hostname } catch { domain = 'relative' }
      if (!byDomain[domain]) byDomain[domain] = []
      byDomain[domain].push(e)
    }
    return byDomain
  }

  const inkContractsFound = contracts
    .filter(c => KNOWN_INK_CONTRACTS[c.url])
    .map(c => ({ address: c.url, token: KNOWN_INK_CONTRACTS[c.url] }))

  inkEvidence = [...new Set(inkEvidence)]

  log.push(`Done — ${defiApis.length} DeFi endpoints, ${otherApis.length} other, ${contracts.length} contracts`)

  return NextResponse.json({
    scanned: targetUrl.href,
    chain: {
      name: 'Ink',
      chainId: INK_CHAIN_ID,
      supported: inkEvidence.length > 0,
      evidence: inkEvidence,
      knownContractsFound: inkContractsFound,
    },
    summary: {
      bundlesScanned:    appBundles.length,
      totalEndpointsRaw: apis.length,
      defiEndpoints:     defiApis.length,
      otherEndpoints:    otherApis.length,
      contractAddresses: contracts.length,
      inkContractsFound: inkContractsFound.length,
    },
    defiEndpoints:  groupByDomain(defiApis),
    otherEndpoints: groupByDomain(otherApis),
    contractAddresses: contracts.map(c => ({
      address:   c.url,
      inkToken:  KNOWN_INK_CONTRACTS[c.url] ?? null,
      source:    c.source.split('/').pop()?.slice(0, 40) ?? '?',
    })),
    log,
  })
}

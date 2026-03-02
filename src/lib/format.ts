/**
 * format.ts — shared number-formatting utilities.
 *
 * Replaces local `formatCurrency`, `fmt`, `fmtUSD` functions that were
 * declared independently in:
 *   - components/TopTokens.tsx
 *   - components/PortfolioHistory.tsx
 *   - app/portfolio/page.tsx
 *   - app/defi/page.tsx
 *   - lib/mockData.ts  (now deleted)
 *   - contexts/PortfolioHistory.tsx  (now deleted)
 */

/**
 * Format a USD value with compact notation.
 * Supports negative values (sign is preserved).
 *
 * Examples:
 *   fmtUSD(1_500_000) → '$1.50M'
 *   fmtUSD(12_847)    → '$12.85K'
 *   fmtUSD(3.14)      → '$3.14'
 *   fmtUSD(0.0005)    → '$0.0005'
 *   fmtUSD(-500)      → '-$500.00K'  (≥1K)
 *   fmtUSD(0)         → '$0.00'
 */
export function fmtUSD(v: number): string {
  if (v === 0) return '$0.00'
  const abs  = Math.abs(v)
  const sign = v < 0 ? '-' : ''
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`
  if (abs >= 1_000)     return `${sign}$${(abs / 1_000).toFixed(2)}K`
  if (abs >= 1)         return `${sign}$${abs.toFixed(2)}`
  if (abs > 0)          return `${sign}$${abs.toFixed(4)}`
  return '$0.00'
}

/**
 * Format a token balance with appropriate precision.
 *
 * Examples:
 *   fmtBalance(12_500, 'USDC')  → '12,500.00 USDC'
 *   fmtBalance(1.5,    'WETH')  → '1.5000 WETH'
 *   fmtBalance(0.0003, 'WBTC')  → '0.000300 WBTC'
 */
export function fmtBalance(b: number, symbol: string): string {
  if (b >= 1_000) return `${b.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${symbol}`
  if (b >= 1)     return `${b.toFixed(4)} ${symbol}`
  return `${b.toFixed(6)} ${symbol}`
}

/**
 * Format a number on the Y-axis of charts (shorter than fmtUSD).
 *
 * Examples:
 *   fmtYAxis(2_000_000) → '$2.0M'
 *   fmtYAxis(15_000)    → '$15.0K'
 *   fmtYAxis(42)        → '$42'
 */
export function fmtYAxis(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`
  if (v >= 1_000)     return `$${(v / 1_000).toFixed(1)}K`
  return `$${v.toFixed(0)}`
}

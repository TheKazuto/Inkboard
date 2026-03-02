# InkBoard — Migration Report (Monad → Ink)

## ✅ Completed Changes

### Phase 1: Core Chain Configuration
All chain config was already partially migrated. Completed remaining items:

| File | Change | Status |
|------|--------|--------|
| `src/components/WalletProvider.tsx` | chainId 57073, Ink RPC, ETH currency, #7C3AED accent | ✅ Already done |
| `src/lib/ink.ts` | INK_RPC, KNOWN_TOKENS (10 Ink tokens), getEthPrice() | ✅ Already done |
| `src/lib/monad.ts` | **Deleted** — nothing imported it | ✅ Removed |
| `src/app/api/eth-price/route.ts` | CoinGecko ID "ethereum" | ✅ Already done |
| `src/hooks/useEthPrice.ts` | ETH price hook | ✅ Already done |
| `src/components/BottomBar.tsx` | ETH price ticker, Shinka Labs links | ✅ Already done |
| `next.config.js` | CSP with Ink RPCs | ✅ Already done |
| `tailwind.config.ts` | `ink.*` color palette | ✅ Already done |
| `src/app/globals.css` | `--ink-purple: #7C3AED` variables | ✅ Already done |

### Phase 2: Branding & UI
| File | Change | Status |
|------|--------|--------|
| `src/app/layout.tsx` | "InkBoard" title, Ink keywords | ✅ Already done |
| `src/app/manifest.ts` | "InkBoard" PWA manifest | ✅ Already done |
| `src/components/Navbar.tsx` | InkBoard logo + name, ink-logo.jpg | ✅ Already done |
| `public/ink-logo.jpg` | **Updated** with user's uploaded logo | ✅ Updated |
| `public/monad-logo.png` | **Deleted** | ✅ Removed |
| `src/app/swap/page.tsx` | REFERRER `monboard.xyz` → `inkboard.xyz` | ✅ Fixed |

### Phase 3: Explorer API
| File | Change | Status |
|------|--------|--------|
| `src/app/api/transactions/route.ts` | Uses Etherscan V2 with chainId 57073 + RPC fallback | ✅ Already done |
| `src/app/api/nfts/route.ts` | Uses Etherscan V2 with chainId 57073 | ✅ Already done |
| `src/app/api/approvals-logs/route.ts` | Supports chainId 57073 | ✅ Already done |
| Comment fix: "Native MON" → "Native ETH" | Fixed in transactions route | ✅ Fixed |

### Phase 4: DeFi Protocol Integration (Best APRs)
| Protocol | Status | Notes |
|----------|--------|-------|
| Curve (Ink) | ✅ Active | factory-twocrypto + factory-stable pools |
| Uniswap V3/V4 (Ink) | ✅ Active | GraphQL for INK chain, V3+V4 pools |
| Velodrome/Slipstream | ⏸ TODO | Awaiting scanner data from user |
| Aave | ⏸ TODO | Awaiting deployment on Ink |
| Frax | ⏸ TODO | Awaiting APR data source |
| InkySwap | ⏸ TODO | Awaiting scanner data |

### Phase 5: DeFi Positions
| Protocol | Status | Notes |
|----------|--------|-------|
| **Removed — Monad-specific:** | | |
| ~~Neverland~~ | ❌ Removed | Replaced with `fetchAave()` placeholder |
| ~~PancakeSwap V3~~ | ❌ Removed | Not deployed on Ink |
| ~~Kintsu (sMON)~~ | ❌ Removed | Monad LST, wrong contract address |
| ~~Magma (gMON)~~ | ❌ Removed | Renamed/merged into Frax frxETH |
| ~~Upshift (earnAUSD)~~ | ❌ Removed | AUSD is Monad-specific |
| **Kept & Working on Ink:** | | |
| Morpho | ✅ Active | GraphQL API with chainId 57073 |
| Uniswap V3 | ✅ Active | NFT Position Manager on Ink |
| Curve | ✅ Active | Full on-chain position detection |
| Gearbox | ✅ Active | Permissionless API for Ink |
| Frax frxETH | ✅ Active | Balance detection at correct Ink address |
| Frax sfrxETH | ✅ Active | Balance detection at correct Ink address |
| Lagoon Finance | ✅ Active | API + on-chain vault balances |
| Kuru | ✅ Active | ERC4626 vault LP detection |
| Curvance | ✅ Active | cToken collateral + debt detection |
| Euler V2 | ✅ Active | GraphQL API with chainId 57073 |
| Midas | ⏸ Placeholder | Waiting for correct contract addresses |
| Renzo | ⏸ Placeholder | Not yet deployed on Ink |
| **UI Protocol List** | ✅ Updated | Removed PancakeSwap, deduplicated Frax/Uniswap |

---

## ⏸ Remaining Work (For Gradual Implementation)

### Priority 1 — Protocol Scanners Needed
These protocols are confirmed active on Ink but need scanner data to integrate:

1. **Velodrome/Slipstream** — Primary DEX on Ink (~largest TVL)
   - Needs: Pool contract addresses, gauge rewards API, Sugar subgraph
   - Files: `api/best-aprs/route.ts` (add `fetchVelodrome()`), `api/defi/route.ts` (position detection)

2. **Aave V3** — Coming to Ink (mentioned by official Ink team)
   - Needs: Pool proxy address, aToken/debtToken addresses
   - Files: `api/defi/route.ts` (replace `fetchAave()` placeholder)

3. **InkySwap** — Native Ink DEX
   - Needs: Factory/router addresses, pool list API
   - Files: `api/best-aprs/route.ts`, `api/defi/route.ts`

4. **Frax APR data** — sfrxUSD/sfrxETH yield rates
   - Needs: Frax API endpoint for yield data
   - Files: `api/best-aprs/route.ts` (add `fetchFrax()`)

### Priority 2 — Optional Enhancements
- **Midas RWA**: Find correct mTBILL/mBASIS contract addresses on Ink
- **Blockscout API integration**: Currently using Etherscan V2 (works but Blockscout is native explorer)
- **Upshift on Ink**: Check if they deploy Ink-specific vaults

### Priority 3 — Cosmetic
- **PWA icons**: Generate 192x192 and 512x512 from the Ink logo
- **Favicon/apple-icon**: Update `src/app/favicon.ico` and `apple-icon.png`

---

## Files Changed Summary

| Action | Count | Details |
|--------|-------|---------|
| Modified | 4 | `api/defi/route.ts`, `api/transactions/route.ts`, `app/swap/page.tsx`, `app/defi/page.tsx` |
| Deleted | 2 | `src/lib/monad.ts`, `public/monad-logo.png` |
| Updated assets | 2 | `public/ink-logo.jpg`, `src/app/ink-logo.jpg` |
| No changes needed | 25+ | Already migrated in previous session |

## Verified Token Addresses on Ink (chainId 57073)

| Token | Contract | Decimals |
|-------|----------|----------|
| WETH | `0x4200000000000000000000000000000000000006` | 18 |
| USDC.e | `0xF1815bd50389c46847f0Bda824eC8da914045D14` | 6 |
| USDT0 | `0x0200C29006150606B650577BBE7B6248F58470c1` | 6 |
| crvUSD | `0x39fec550CC6DDCEd810eCCfA9B2931b4B5f2344D` | 18 |
| frxUSD | `0x80eede496655fb9047dd39d9f418d5483ed600df` | 18 |
| sfrxUSD | `0x5bff88ca1442c2496f7e475e9e7786383bc070c0` | 18 |
| frxETH | `0x43eDD7f3831b08FE70B7555ddD373C8bF65a9050` | 18 |
| sfrxETH | `0x3ec3849c33291a9ef4c5db86de593eb4a37fde45` | 18 |
| CRV | `0xAC73671a1762FE835208Fb93b7aE7490d1c2cCb3` | 18 |
| FXS | `0x64445f0aecc51e94ad52d8ac56b7190e764e561a` | 18 |

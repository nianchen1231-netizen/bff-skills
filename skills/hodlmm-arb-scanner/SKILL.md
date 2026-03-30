---
name: hodlmm-arb-scanner
description: "HODLMM cross-pool arbitrage scanner — detects price discrepancies between Bitflow HODLMM and XYK/StableSwap pools, calculates profitable swap routes, and optionally executes arbitrage trades. HODLMM integration for $1K bonus."
metadata:
  author: "nianchen1231-netizen"
  author-agent: "Arb Hawk"
  user-invocable: "false"
  arguments: "doctor | scan | execute | history"
  entry: "hodlmm-arb-scanner/hodlmm-arb-scanner.ts"
  requires: "wallet, signing, settings"
  tags: "l2, defi, write, mainnet-only, requires-funds"
---

# HODLMM Arb Scanner

Detects price arbitrage opportunities between Bitflow **HODLMM (DLMM)** pools and traditional **XYK / StableSwap** pools. When a spread exceeding the configured threshold is found, the skill can execute the arbitrage swap automatically.

## How It Works

1. **Fetch HODLMM pools** from Bitflow's HODLMM API and derive the effective price from each pool's active bin.
2. **Fetch XYK/StableSwap pools** for the same token pairs and derive the effective price from the reserves ratio.
3. **Compare prices** between pool types for each overlapping pair.
4. **Calculate spread** as a percentage and estimate gross/net profit accounting for fees.
5. **Optionally execute** the arbitrage: buy on the cheaper pool, sell on the more expensive one, via Bitflow's swap routing API.

## Commands

| Command | Description |
|---------|-------------|
| `doctor` | Verify Bitflow API connectivity, list available HODLMM pools and their status |
| `scan` | Scan all HODLMM pools, compare against XYK pools, report arbitrage opportunities |
| `execute --pool-id <id> --amount <sats>` | Execute an arb swap when spread exceeds threshold |
| `history` | Show recently detected arbitrage opportunities (persisted locally) |

## Scan Output

```json
{
  "ok": true,
  "opportunities": [
    {
      "pair": "STX/aBTC",
      "hodlmmPoolId": "...",
      "xykPoolId": "...",
      "hodlmmPrice": 0.00001234,
      "xykPrice": 0.00001256,
      "spreadPct": 1.78,
      "direction": "buy_hodlmm_sell_xyk",
      "estimatedProfitBps": 128
    }
  ],
  "scannedAt": "2026-03-29T12:00:00Z"
}
```

## Risk Disclaimer

Arbitrage execution involves real funds. Price spreads may close between detection and execution. Gas fees, slippage, and pool fees reduce realized profit. Always verify opportunities manually before enabling automated execution.

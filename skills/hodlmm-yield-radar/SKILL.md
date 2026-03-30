---
name: hodlmm-yield-radar
description: "HODLMM pool yield scanner, position health monitor, and optimal entry recommender for Bitflow concentrated liquidity on Stacks."
metadata:
  author: "nianchen1231-netizen"
  author-agent: "Atomic Tortoise"
  user-invocable: "false"
  arguments: "doctor | status | run analyze | run position | run entry"
  entry: "hodlmm-yield-radar/hodlmm-yield-radar.ts"
  requires: "wallet"
  tags: "defi, read-only, l2"
---

# HODLMM Yield Radar

## What it does

Scans all Bitflow pools for real-time yield rates via the Ticker API, filters junk pools (APY > 1000%, liquidity < $10K), and ranks opportunities by risk-adjusted score. Monitors existing positions and generates entry parameters without submitting any transaction.

## Why agents need it

Any AIBTC agent holding sBTC or STX needs to know which pool offers the highest fee yield at the lowest current risk before committing capital. This skill centralizes the scan, ranks pools by risk-adjusted yield (fee APY / spread volatility), and surfaces actionable entry parameters.

## Safety notes

- All operations are read-only. No transaction is ever submitted to chain.
- The `run entry` command generates recommended parameters as JSON — it does not execute.
- Wallet address is used only for position lookups. No signing or key access.
- Yield figures are point-in-time estimates based on 24h volume × fee rate. Past volume does not guarantee future yield.

## Commands

### doctor

Checks connectivity to the Bitflow API.

```bash
bun run hodlmm-yield-radar/hodlmm-yield-radar.ts doctor
```

### status

Returns a live summary of all pools: pool ID, name, fee APY, liquidity, volume, and prices.

```bash
bun run hodlmm-yield-radar/hodlmm-yield-radar.ts status
```

### run analyze

Ranks pools by risk-adjusted yield score and projects returns for a given capital amount.

```bash
bun run hodlmm-yield-radar/hodlmm-yield-radar.ts run analyze --amount <usd_value>
```

### run position

Checks position status for a given wallet address.

```bash
bun run hodlmm-yield-radar/hodlmm-yield-radar.ts run position --address <stx_address>
```

### run entry

Generates optimal entry parameters for a given pool and capital amount.

```bash
bun run hodlmm-yield-radar/hodlmm-yield-radar.ts run entry --pool <pool_id> --amount <usd_value>
```

## Output contract

All commands return a unified JSON envelope:

### Success (status)

```json
{
  "status": "success",
  "action": "status",
  "data": {
    "pools": [
      {
        "pool_id": "SPQC38PW542EQJ5M11CR25P7BS1CA6QT4TBXR7CV.dlmm-stx-sbtc",
        "name": "STX-sBTC",
        "liquidity_usd": 214000,
        "volume_24h": 18500,
        "fee_apy_pct": 18.4,
        "last_price": 0.00001234
      }
    ],
    "protocol": { "name": "Bitflow", "tvl_usd": 5200000 },
    "prices": { "stx_usd": 0.82, "btc_usd": 67500 },
    "meta": { "total_tickers": 45, "filtered_pools": 8, "min_liquidity_filter_usd": 10000 },
    "timestamp": "2026-03-28T10:00:00.000Z"
  }
}
```

### Success (analyze)

```json
{
  "status": "success",
  "action": "analyze",
  "data": {
    "amount_usd": 500,
    "note": "APY estimated from 24h volume × 0.3% fee × 365 / liquidity.",
    "recommendations": [
      {
        "rank": 1,
        "pool_id": "SPQC38PW542EQJ5M11CR25P7BS1CA6QT4TBXR7CV.dlmm-stx-sbtc",
        "name": "STX-sBTC",
        "liquidity_usd": 214000,
        "fee_apy_pct": 18.4,
        "spread_volatility_pct": 2.1,
        "risk_adjusted_score": 5.93,
        "projected_yields": {
          "amount_usd": 500,
          "daily_usd": 0.25,
          "weekly_usd": 1.76,
          "monthly_usd": 7.67
        }
      }
    ]
  }
}
```

### Error

```json
{
  "status": "error",
  "action": "analyze",
  "data": {},
  "error": "No qualifying pools after filtering (APY ≤ 1000%, liquidity ≥ $10k, volume > 0)."
}
```

## Known constraints

- Requires Bitflow Ticker API connectivity.
- Queries the general Bitflow ticker endpoint, not HODLMM DLMM bin-level data directly.
- Fee APY is computed as: 24h volume × 0.3% fee rate × 365 / pool liquidity.
- Pools with APY > 1000%, liquidity < $10K, or zero 24h volume are filtered out.
- Risk-adjusted score = fee APY / (spread volatility + 1).
- `run entry` does not simulate slippage or validate token balances.

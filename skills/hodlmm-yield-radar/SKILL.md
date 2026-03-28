---
name: hodlmm-yield-radar
description: "HODLMM pool yield scanner, position health monitor, and optimal entry recommender for Bitflow concentrated liquidity on Stacks."
metadata:
  author: "nianchen1231-netizen"
  author-agent: "Atomic Tortoise"
  user-invocable: "true"
  arguments: "doctor | status | run analyze | run position | run entry"
  entry: "hodlmm-yield-radar/hodlmm-yield-radar.ts"
  requires: "wallet"
  tags: "defi, read-only, l2"
---

# HODLMM Yield Radar

## What it does

Scans all Bitflow HODLMM pools for real-time yield rates, monitors LP position health, and recommends optimal entry strategies for concentrated liquidity provision on Stacks L2. Aggregates fee APR, bin utilization, and reserve depth across pools to rank opportunities. Tracks existing positions for drift, out-of-range status, and estimated IL. Generates entry parameters (bin range, allocation split, price bounds) without submitting any transaction.

## Why agents need it

Any AIBTC agent holding sBTC or STX needs to know which HODLMM pool offers the highest fee yield at the lowest current risk before committing capital. Without this skill, agents must query each pool independently and manually compare metrics. This skill centralizes that scan, ranks pools by risk-adjusted yield, and surfaces actionable entry parameters — enabling agents to make LP decisions confidently and without guesswork.

## Safety notes

- All operations are read-only. No transaction is ever submitted to chain.
- The `run entry` command generates recommended entry parameters (bin range, amounts, price bounds) as a JSON payload for the agent to review — it does not execute the transaction.
- Wallet address is used only for position lookups. No signing is required and no keys are accessed.
- Pool yield figures are point-in-time estimates based on recent fee data and current bin distribution. Past fee rates do not guarantee future yield.

## Commands

### doctor

Checks connectivity to the Bitflow API and verifies that HODLMM pool data is reachable. Safe to run anytime — read-only, no wallet required.

```bash
bun run hodlmm-yield-radar/hodlmm-yield-radar.ts doctor
```

Verifies:
- Bitflow API endpoint is reachable
- At least one HODLMM pool returns valid data
- Wallet address (if configured) is a valid Stacks address format

### status

Returns a live summary of all HODLMM pools: pool ID, active bin, fee tier, estimated 24h fee APR, total liquidity, and reserve imbalance ratio. Sorted by fee APR descending.

```bash
bun run hodlmm-yield-radar/hodlmm-yield-radar.ts status
```

Output:
```json
{
  "status": "success",
  "action": "Pool scan complete — 4 pools found",
  "data": {
    "pools": [
      {
        "poolId": "dlmm_3",
        "tokenX": "sBTC",
        "tokenY": "STX",
        "feeTierBps": 30,
        "activeBinId": 447,
        "feeApr24h": 18.4,
        "totalLiquidityUsd": 214000,
        "reserveImbalanceRatio": 0.45
      }
    ],
    "scanTimestamp": "2026-03-28T10:00:00.000Z"
  },
  "error": null
}
```

### run analyze

Performs a deep yield analysis on a specific pool: fee APR over 1h/24h/7d windows, bin concentration, liquidity depth around the active bin, and a composite yield score (0–100).

```bash
bun run hodlmm-yield-radar/hodlmm-yield-radar.ts run analyze --pool-id <pool_id>
```

Options:
- `--pool-id` (required) — HODLMM pool identifier (e.g. `dlmm_3`)

Output:
```json
{
  "status": "success",
  "action": "Analysis complete for dlmm_3",
  "data": {
    "poolId": "dlmm_3",
    "tokenX": "sBTC",
    "tokenY": "STX",
    "feeApr": {
      "1h": 21.2,
      "24h": 18.4,
      "7d": 14.7
    },
    "activeBinId": 447,
    "binConcentrationScore": 72,
    "liquidityDepthBins": 8,
    "compositeYieldScore": 68,
    "yieldLabel": "attractive",
    "timestamp": "2026-03-28T10:00:00.000Z"
  },
  "error": null
}
```

### run position

Checks the health of an existing LP position for a given wallet address in a specific pool. Returns in-range status, drift distance from active bin, estimated IL, and a hold/rebalance/exit recommendation.

```bash
bun run hodlmm-yield-radar/hodlmm-yield-radar.ts run position --pool-id <pool_id> --address <stx_address>
```

Options:
- `--pool-id` (required) — HODLMM pool identifier
- `--address` (required) — Stacks address to check

Output:
```json
{
  "status": "success",
  "action": "Position health check complete",
  "data": {
    "poolId": "dlmm_3",
    "address": "SP2...",
    "inRange": true,
    "positionBins": 3,
    "activeBinId": 447,
    "nearestBinOffset": 1,
    "avgBinOffset": 2.3,
    "estimatedIlPct": 0.18,
    "feeEarnedEstimate24hUsd": 4.2,
    "recommendation": "hold",
    "timestamp": "2026-03-28T10:00:00.000Z"
  },
  "error": null
}
```

### run entry

Generates optimal entry parameters for a given pool and intended capital amount. Outputs recommended bin range, token allocation split, and price bounds — ready for the agent to pass to a transaction-executing skill. Does not submit any transaction.

```bash
bun run hodlmm-yield-radar/hodlmm-yield-radar.ts run entry --pool-id <pool_id> --amount-usd <amount>
```

Options:
- `--pool-id` (required) — HODLMM pool identifier
- `--amount-usd` (required) — intended capital in USD equivalent (e.g. `500`)
- `--strategy` (optional) — `tight` (default) | `wide` — bin range width strategy

Output:
```json
{
  "status": "success",
  "action": "Entry parameters generated — review before executing",
  "data": {
    "poolId": "dlmm_3",
    "strategy": "tight",
    "activeBinId": 447,
    "recommendedBinRange": { "lower": 444, "upper": 450 },
    "tokenXAmountSats": 25000,
    "tokenYAmountUstx": 1820000000,
    "priceBounds": {
      "lowerUsd": 84200,
      "upperUsd": 86800
    },
    "estimatedFeeApr24h": 18.4,
    "note": "Parameters only — no transaction submitted. Pass to a write skill to execute."
  },
  "error": null
}
```

## Output contract

All commands return a unified JSON envelope to stdout:

```json
{
  "status": "success | error | blocked",
  "action": "human-readable summary of result or next step",
  "data": {},
  "error": null
}
```

On error:
```json
{
  "status": "error",
  "action": "Check Bitflow API connectivity and retry",
  "data": {},
  "error": "descriptive error message"
}
```

`status` field routing:
- `success` — data is valid, agent may proceed
- `error` — something failed, surface to user
- `blocked` — pre-condition not met (e.g. address has no position for `run position`)

## Known constraints

- Requires Bitflow API connectivity. If the API is unreachable, all commands except `doctor` will return `error`.
- HODLMM pool data may have up to 60 seconds of delay relative to on-chain state.
- Fee APR estimates are computed from recent swap fee volume and may not reflect sudden pool activity changes.
- `compositeYieldScore` weights: fee APR 24h (50%), bin concentration (30%), liquidity depth (20%).
- `yieldLabel` thresholds: 0–30 = `low`, 31–60 = `moderate`, 61–80 = `attractive`, 81–100 = `high`.
- `run entry` generates parameters for the tight strategy using ±3 bins around the active bin; wide strategy uses ±7 bins.
- `run entry` does not simulate slippage or validate that sufficient token balances exist — pair with a pre-flight check in the executing skill.
- Pools with fewer than 5 active bins of liquidity depth will return a `low` yield label regardless of fee APR.

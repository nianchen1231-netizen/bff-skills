---
name: hodlmm-arb-scanner
description: "HODLMM cross-pool arbitrage scanner — detects price discrepancies between Bitflow HODLMM and XYK/StableSwap pools, calculates profitable swap routes, and optionally executes arbitrage trades. HODLMM integration for $1K bonus."
metadata:
  author: "nianchen1231-netizen"
  author-agent: "Atomic Tortoise"
  user-invocable: "false"
  arguments: "doctor | scan | execute | history"
  entry: "hodlmm-arb-scanner/hodlmm-arb-scanner.ts"
  requires: "wallet, signing, settings"
  tags: "l2, defi, write, mainnet-only, requires-funds"
---

# HODLMM Arb Scanner

Detects price arbitrage opportunities between Bitflow **HODLMM (DLMM)** pools and traditional **XYK / StableSwap** pools. When a spread exceeding the configured threshold is found, the skill can execute the arbitrage swap automatically.

## What it does

Scans all Bitflow HODLMM concentrated-liquidity pools and compares their effective prices against XYK and StableSwap pools for the same token pairs. When a price discrepancy (spread) exceeds a configurable threshold (default 50 bps), it reports the opportunity with direction, estimated profit, and fee breakdown. Optionally executes the arbitrage trade via Bitflow's swap routing API.

## Why agents need it

Autonomous agents managing DeFi portfolios on Stacks need real-time visibility into cross-pool pricing inefficiencies. Without this skill, agents cannot detect when the same token pair is priced differently across HODLMM vs XYK vs StableSwap pools — leaving arbitrage profit on the table. This skill turns passive portfolio management into active alpha capture by providing structured, actionable spread data that agents can act on programmatically.

## Safety notes

- **Writes to chain**: Yes — the `execute` command submits swap transactions on Stacks mainnet.
- **Moves funds**: Yes — arbitrage execution swaps tokens between pools using the agent's wallet.
- **Mainnet only**: Yes — all pool data and execution targets are Stacks mainnet contracts.
- **Irreversible**: Swap transactions are final once confirmed on-chain. There is no undo.
- **Risk**: Price spreads may close between detection and execution. Gas fees, slippage, and pool fees reduce realized profit. Never enable auto-execute without setting a conservative `maxAmountSats` limit.

## Commands

| Command | Description |
|---------|-------------|
| `doctor` | Verify Bitflow API connectivity, list available HODLMM pools and their status |
| `scan` | Scan all HODLMM pools, compare against XYK/StableSwap pools, report arbitrage opportunities |
| `execute --pool-id <id> --amount <sats>` | Execute an arb swap when spread exceeds threshold |
| `history` | Show recently detected arbitrage opportunities (persisted locally) |

## Output contract

### Success (scan)

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

### Error

```json
{
  "ok": false,
  "error": "HODLMM API unreachable after 3 retries"
}
```

---
name: alex-swap-executor
description: "Autonomous swap executor for ALEX DEX — quotes, routes, executes token swaps with slippage protection and multi-hop routing on Stacks."
metadata:
  author: "nianchen1231-netizen"
  author-agent: "Mystic Lock"
  user-invocable: "false"
  arguments: "doctor | status | quote | swap | auto | history"
  entry: "alex-swap-executor/alex-swap-executor.ts"
  requires: "wallet, signing, settings"
  tags: "defi, write, mainnet-only, requires-funds, l2"
---

# ALEX Swap Executor

## What it does
Executes token swaps on ALEX DEX, the largest decentralized exchange on Stacks. Fetches real-time quotes across all ALEX liquidity pools, computes optimal routes (including multi-hop paths), applies slippage protection, and executes swaps via on-chain contract calls. Supports autonomous mode that monitors price conditions and executes when targets are met.

## Why agents need it
ALEX DEX handles the majority of Stacks trading volume. Agents holding STX, sBTC, ALEX, or stSTX need a way to rebalance portfolios, take profits, or convert between assets without manual intervention. No existing BFF skill covers ALEX — agents currently have no automated swap capability on the largest Stacks DEX. This skill fills that gap with production-grade execution: quote comparison, route optimization, slippage gates, and full tx verification.

## Safety notes
- **Writes to chain**: Executes real token swaps. Funds leave your wallet.
- **Slippage cap**: Default 1% max slippage. Swap aborts if quoted output drops below threshold.
- **Spend cap**: Maximum 100,000 sats equivalent per swap. Configurable via settings.
- **Cooldown**: 5-minute minimum between swaps on the same pair to prevent rapid trading.
- **--confirm gate**: The `swap` command requires explicit `--confirm` flag. Without it, only a dry-run quote is shown.
- **Quote freshness**: Quotes expire after 30 seconds. Stale quotes are re-fetched before execution.
- **Gas cap**: 10 STX maximum gas per transaction. Aborts if estimate exceeds cap.
- **Route validation**: Multi-hop routes are validated for token continuity before execution.
- **Mainnet only**: ALEX liquidity pools are mainnet-only.

## Commands
| Command | Description |
|---------|------------|
| `doctor` | Check wallet balance, ALEX API access, MCP tool availability |
| `status` | Show wallet token balances and recent ALEX pool stats |
| `quote --from STX --to sBTC --amount 100` | Get swap quote with route and expected output |
| `swap --from STX --to sBTC --amount 100 --confirm` | Execute swap on-chain |
| `auto --from STX --to sBTC --target-price 0.000014 --amount 50 --confirm` | Autonomous: monitor and execute when price target hit |
| `history` | Show past swap execution log |

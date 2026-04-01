---
name: hodlmm-dca-executor
description: "Dollar-cost averages STX into sBTC via Bitflow swap, then deposits into HODLMM concentrated liquidity pools at the active bin for automated fee capture."
metadata:
  author: "nianchen1231-netizen"
  author-agent: "Atomic Tortoise"
  user-invocable: "false"
  arguments: "doctor | quote --address --amount | execute --address --amount [--slippage] [--pool] [--confirm] | position --address | withdraw --address [--pool] [--confirm]"
  entry: "hodlmm-dca-executor/hodlmm-dca-executor.ts"
  requires: "bun, commander"
  tags: "defi, write, mainnet-only, requires-funds"
---

## What it does

HODLMM DCA Executor automates the full STX-to-HODLMM-yield pipeline. It swaps STX into sBTC via Bitflow's XYK pool, then deposits the sBTC into a HODLMM concentrated liquidity pool centered on the current active bin. This gives agents a one-command path from holding idle STX to earning trading fees in Bitflow's highest-APR pools.

## Why agents need it

Agents earning STX from stacking, bounties, or service payments have no automated way to put that capital to work in HODLMM pools. The manual flow requires three steps (swap, choose bins, deposit) across two protocols. This skill collapses that into a single `execute` command with built-in price quoting, slippage protection, and position tracking — letting agents DCA into yield-bearing positions on a schedule without human intervention.

## Safety notes

- **Writes to chain.** The `execute` and `withdraw` commands submit transactions that move funds.
- **Requires funds.** Wallet must hold STX to swap and pay gas.
- **Mainnet only.** All contract addresses are Stacks mainnet.
- **--confirm required.** All write operations default to dry-run preview. Must pass `--confirm` to execute.
- **Irreversible swaps.** Once a swap executes on-chain, it cannot be reversed. Slippage protection limits downside.

Hardcoded guardrails (not configurable):

| Rule | Value |
|------|-------|
| Max swap per tx | 50 STX |
| Min swap | 0.1 STX |
| Max slippage | 200 bps (2%) |
| STX gas reserve | 0.5 STX (never swapped) |
| Max bin range | ±5 around active bin |
| Daily swap limit | 5 per day |
| Swap cooldown | 30 min between swaps |
| Lifetime cap | 500 STX cumulative |
| Post-conditions | `deny` mode: STX sent capped, min sBTC enforced |

## Commands

### doctor

Checks Stacks API, HODLMM pool API, bin data, and price feeds. Safe to run anytime.

```bash
bun run hodlmm-dca-executor/hodlmm-dca-executor.ts doctor
```

### quote

Get a swap estimate without executing. Shows expected sBTC output, pool APR, and wallet balance.

```bash
bun run hodlmm-dca-executor/hodlmm-dca-executor.ts quote --address SP... --amount 2
```

### execute

Swap STX → sBTC and deposit into HODLMM pool. Defaults to dry-run.

```bash
bun run hodlmm-dca-executor/hodlmm-dca-executor.ts execute --address SP... --amount 2 --confirm
```

### position

Check wallet balances (STX, sBTC) and active HODLMM positions.

```bash
bun run hodlmm-dca-executor/hodlmm-dca-executor.ts position --address SP...
```

### withdraw

Remove liquidity from a HODLMM pool. Defaults to dry-run.

```bash
bun run hodlmm-dca-executor/hodlmm-dca-executor.ts withdraw --address SP... --pool dlmm_6 --confirm
```

## Output contract

All commands output JSON to stdout:

```json
{
  "status": "success | error | degraded",
  "action": "doctor | quote | execute | execute_preview | position | withdraw | withdraw_preview | error",
  "data": { },
  "error": null | { "code": "...", "message": "...", "next": "..." }
}
```

The `execute` action returns MCP commands for the agent to submit:

```json
{
  "commands": [
    { "step": 1, "tool": "call_contract", "description": "Swap 2.00 STX → sBTC via Bitflow XYK pool", "params": { } },
    { "step": 2, "tool": "bitflow_hodlmm_add_liquidity", "description": "Deposit sBTC into HODLMM dlmm_6 at active bin 8421 ±3", "params": { } }
  ]
}
```

## Known constraints

- Swap uses Bitflow XYK pool (STX/sBTC), not DLMM router, for simpler execution and proven reliability.
- Estimated sBTC output is calculated from on-chain XYK pool reserves via Clarity `get-pool` read-only call (constant product formula with 0.3% fee). Actual output may differ slightly due to concurrent swaps.
- State updates (daily counter, cooldown, cumulative cap) are optimistic — counters increment before MCP execution completes. Run `position` to reconcile if a transaction fails.
- Position tracking is local (file-based state); clearing the state file resets DCA history but does not affect on-chain positions.
- The skill does not auto-compound fees; use `withdraw` to exit and `execute` to re-enter at the current active bin.
- Maximum 8 HODLMM pools available on Bitflow mainnet.

---
name: hodlmm-auto-compounder
description: "Claims uncollected HODLMM LP fees and redeposits them into the active bin for autonomous compound growth."
metadata:
  author: "nianchen1231-netizen"
  author-agent: "Atomic Tortoise"
  user-invocable: "false"
  arguments: "doctor | scan --address | compound --address [--pool] [--min-sats] [--confirm] | history --address"
  entry: "hodlmm-auto-compounder/hodlmm-auto-compounder.ts"
  requires: "bun, commander"
  tags: "defi, write, mainnet-only, requires-funds"
---

## What it does

HODLMM Auto-Compounder harvests uncollected trading fees from Bitflow HODLMM concentrated liquidity positions and redeposits them at the current active bin. This turns idle fee accrual into compound yield — fees earn more fees — without the agent needing to manually withdraw, track bin drift, or time redeposits.

## Why agents need it

HODLMM pools accumulate trading fees in each LP bin, but those fees sit idle until explicitly claimed. An agent with a DCA executor or manual deposit has no automated way to roll fees back into the pool. Over time, uncollected fees represent a growing drag on effective APR. This skill closes the loop: scan for claimable fees across all pools, claim them on-chain, and redeposit in a single pipeline — giving agents true set-and-forget compound yield.

## Safety notes

- **Writes to chain.** The `compound` command claims fees and redeposits (two on-chain transactions).
- **Requires funds.** Wallet must hold ≥0.5 STX for gas (claim + deposit = 2 txs).
- **Mainnet only.** All contract addresses are Stacks mainnet.
- **--confirm required.** All write operations default to dry-run preview.
- **Irreversible claims.** Once fees are claimed on-chain, the action cannot be reversed.

Hardcoded guardrails (not configurable):

| Rule | Value |
|------|-------|
| Min compound threshold | 100 sats (skip dust) |
| Max compound per tx | 50,000 sats (0.0005 BTC) |
| STX gas reserve | 0.5 STX (never touched) |
| Max bin range | ±5 around active bin |
| Compound cooldown | 60 min between compounds |
| Daily compound limit | 10 per day |
| Post-conditions | `deny` mode: claimed amount capped |

## Commands

### doctor

Checks Stacks API, HODLMM pool API, and fee-claim contract readiness. Safe to run anytime.

```bash
bun run hodlmm-auto-compounder/hodlmm-auto-compounder.ts doctor
```

### scan

Scan all HODLMM pools for uncollected fees on a given address. Read-only.

```bash
bun run hodlmm-auto-compounder/hodlmm-auto-compounder.ts scan --address SP...
```

### compound

Claim uncollected fees from a HODLMM pool and redeposit at the active bin. Defaults to dry-run.

```bash
bun run hodlmm-auto-compounder/hodlmm-auto-compounder.ts compound --address SP... --pool dlmm_6 --confirm
```

### history

Show compounding history and cumulative stats.

```bash
bun run hodlmm-auto-compounder/hodlmm-auto-compounder.ts history --address SP...
```

## Output contract

All commands output JSON to stdout:

```json
{
  "status": "success | error | degraded",
  "action": "doctor | scan | compound | compound_preview | history | error",
  "data": { },
  "error": null | { "code": "...", "message": "...", "next": "..." }
}
```

The `compound` action returns MCP commands for the agent to submit:

```json
{
  "commands": [
    { "step": 1, "tool": "bitflow_hodlmm_claim_fees", "description": "Claim 1,250 sats from dlmm_6 bins [8419..8423]", "params": { } },
    { "step": 2, "tool": "bitflow_hodlmm_add_liquidity", "description": "Redeposit 1,250 sats into dlmm_6 at active bin 8421 ±5", "params": { } }
  ]
}
```

## Known constraints

- Fee amounts are estimated from the HODLMM API bin data. Actual claimed amount may differ slightly due to concurrent trades.
- Compound is only worthwhile when accumulated fees exceed the gas cost (~0.01 STX per tx). The 100-sat minimum threshold prevents value-destructive compounds.
- State is local (file-based); clearing the state file resets history but does not affect on-chain positions.
- The skill does not rebalance bin positions — use hodlmm-position-guardian for drift migration.
- Redeposit targets the current active bin, which may differ from the original deposit bin if the price has moved.

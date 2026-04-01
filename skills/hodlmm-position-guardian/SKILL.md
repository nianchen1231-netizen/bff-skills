---
name: hodlmm-position-guardian
description: Monitors HODLMM LP positions for bin drift and migrates out-of-range liquidity to current active bins, compounding earned fees for optimal capital efficiency.
metadata:
  author: "0xChenxiao"
  author-agent: "Atomic Tortoise"
  user-invocable: "false"
  arguments: "--address <stacks-address> [--confirm]"
  entry: "skills/hodlmm-position-guardian/hodlmm-position-guardian.ts"
  requires: "bun, commander"
  tags: "hodlmm, defi, lp-management, write, mainnet-only, requires-funds"
---

## What it does

HODLMM Position Guardian continuously monitors LP positions across all 8 Bitflow HODLMM pools and takes action when positions drift out of the active bin range. It:

1. **Scans** every HODLMM pool for user positions, computing bin drift (distance between position center and current active bin), estimated USD value, and pro-rata fee earnings.
2. **Migrates** out-of-range positions by generating MCP commands to remove liquidity from stale bins and re-add it centered on the current active bin.
3. **Compounds** earned fees back into in-range positions when accumulated fees exceed the minimum threshold.
4. **Tracks** historical drift patterns to surface pools that require frequent rebalancing.

## Why agents need it

Concentrated liquidity in HODLMM pools only earns fees when the active bin overlaps with the LP's deposited bins. Price movement causes bin drift — once the active bin leaves the position range, the LP earns **zero fees** while still bearing impermanent loss. Manual monitoring across 8 pools is impractical for autonomous agents managing multiple positions.

Position Guardian closes the loop: detect drift → remove → re-add → compound. Without it, an agent's capital sits idle in out-of-range bins indefinitely.

## Safety notes

All guardrails are **hardcoded in the source** (not configurable via arguments):

- **$5,000 max migration** — refuses to migrate positions exceeding this value in a single operation
- **2-bin minimum drift** — ignores minor fluctuations to avoid unnecessary gas spend
- **±10 bin max range** — caps the re-add spread to prevent thin liquidity across too many bins
- **$1.00 minimum compound** — skips compounding when fees are dust
- **150,000 uSTX gas floor** — blocks execution if wallet lacks sufficient gas
- **--confirm required** — all write operations default to dry-run preview; must explicitly pass `--confirm`
- **No borrowing** — never opens leveraged positions; only manages existing LP
- **Stateless execution** — each run reads fresh on-chain state; no stale cache risk

## Output contract

Every command returns a single JSON object to stdout:

```json
{
  "status": "success | error | degraded",
  "action": "doctor | scan | migrate | migrate_preview | compound | compound_preview | history | error",
  "data": { ... },
  "error": null | { "code": "...", "message": "...", "next": "..." }
}
```

### `scan` data shape

```json
{
  "address": "SP...",
  "positionsFound": 2,
  "totalValueUsd": 1250.50,
  "summary": { "hold": 1, "migrate": 1, "compound": 0, "exit": 0 },
  "positions": [
    {
      "poolId": "dlmm_1",
      "pair": "sBTC/USDCx",
      "activeBinId": 529,
      "positionCenter": 522,
      "drift": 7,
      "inRange": false,
      "userBins": [520, 521, 522, 523, 524],
      "estimatedValueUsd": 800.00,
      "feesEarned1dUsd": 0.00,
      "feesEarned7dUsd": 0.00,
      "recommendation": "MIGRATE",
      "reason": "Active bin 529 drifted 7 bins from position center 522..."
    }
  ]
}
```

### `migrate` / `compound` data shape

```json
{
  "execute": true,
  "migrations": [
    {
      "poolId": "dlmm_1",
      "pair": "sBTC/USDCx",
      "commands": [
        { "step": 1, "tool": "bitflow_hodlmm_remove_liquidity", "description": "...", "params": { "poolId": "dlmm_1", "binIds": [520, 521, 522, 523, 524] } },
        { "step": 2, "tool": "bitflow_hodlmm_add_liquidity", "description": "...", "params": { "poolId": "dlmm_1", "targetBinId": 529, "binRange": 2 } }
      ]
    }
  ]
}
```

## Commands

| Command | Description | Flags |
|---------|-------------|-------|
| `doctor` | Verify API connectivity and display guardrail config | — |
| `scan --address <SP...>` | Scan all pools for positions, report health | `--address` (required) |
| `migrate --address <SP...>` | Preview migration plan for out-of-range positions | `--address` (required), `--confirm` (optional) |
| `compound --address <SP...>` | Preview fee compounding for in-range positions | `--address` (required), `--confirm` (optional) |
| `history` | Show drift history and per-pool migration trends | — |

## Data sources

| Source | URL | Purpose |
|--------|-----|---------|
| Bitflow HODLMM Pools | `https://bff.bitflowapis.finance/api/app/v1/pools` | Pool metadata, TVL, fees, APR |
| Bitflow HODLMM Bins | `https://bff.bitflowapis.finance/api/quotes/v1/bins/{poolId}` | Active bin, bin reserves |
| Bitflow User Positions | `https://bff.bitflowapis.finance/api/app/v1/users/{addr}/positions/{poolId}/bins` | User liquidity per bin |
| Hiro Stacks API | `https://api.mainnet.hiro.so` | STX balance for gas check |

## Known constraints

- Position value estimation uses current bin reserves and token prices; actual withdrawal value depends on slippage at execution time.
- Fee earnings are estimated from pool-level daily/weekly fees pro-rated by user's liquidity share; per-position fee accounting is not available via API.
- The tool does not handle partial migrations — it removes and re-adds the full position.
- Maximum 8 HODLMM pools are scanned (all currently deployed on Bitflow mainnet).

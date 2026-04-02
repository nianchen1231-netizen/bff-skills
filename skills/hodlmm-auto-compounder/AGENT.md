---
name: Atomic Tortoise
skill: hodlmm-auto-compounder
description: "Autonomous compounder that harvests HODLMM LP fees and redeposits them at the active bin for compound yield growth."
---

## Decision order

1. Run `doctor` to confirm all APIs are healthy.
2. Run `scan --address <wallet>` to find pools with uncollected fees.
3. For each pool with claimable fees above the minimum threshold (100 sats), run `compound --address <wallet> --pool <id>` to preview.
4. Inspect the dry-run output. Verify the fee amount, target bin, and gas cost.
5. Run `compound --address <wallet> --pool <id> --confirm` to execute.
6. After execution, run `scan` again to verify fees were claimed and redeposited.
7. Run `history` to track cumulative compound stats.

## Guardrails

| Rule | Value | Rationale |
|------|-------|-----------|
| Min compound | 100 sats | Avoids dust claims that waste gas |
| Max compound | 50,000 sats | Limits single-tx exposure |
| Gas reserve | 0.5 STX | Ensures wallet can always broadcast |
| Max bin range | ±5 bins | Prevents thin liquidity spread |
| Daily limit | 10 compounds | Rate-limits to avoid spam |
| Cooldown | 60 min | Allows fees to accumulate between claims |
| --confirm required | All writes | No accidental execution |

**Hard limits (never override):**

- Never compound if claimable fees are below 100 sats.
- Never proceed if `doctor` reports degraded status.
- Never skip the dry-run preview step.
- Never expose private keys in arguments or logs.

## Polling cadence

| Condition | Interval |
|-----------|----------|
| Normal compounding | Every 6 hours |
| After a compound | Verify with `scan` 5 minutes later |
| Low fee accrual (<100 sats over 24h) | Extend to every 12 hours |
| High volume (pool APR spike) | Shorten to every 2 hours |
| Low STX balance (<0.5 STX) | Stop compounding, alert for gas funding |

## Signal-to-action matrix

| Signal | Action | Auto-execute? |
|--------|--------|---------------|
| Claimable fees > 100 sats | Run `compound --confirm` | No — requires --confirm |
| Claimable fees < 100 sats | Skip, wait for accumulation | Automatic |
| Position out of range | Log warning, recommend position-guardian | Automatic |
| Daily limit reached | Skip, wait until tomorrow | Automatic |
| Gas too low | Alert operator | Automatic |
| API degraded | Skip, retry next cycle | Automatic |

## Error handling

| Error code | Cause | Recovery |
|------------|-------|----------|
| `NO_POSITION` | No LP position in the specified pool | Deposit first via dca-executor |
| `DUST_FEES` | Fees below 100 sats minimum | Wait for more fee accrual |
| `COOLDOWN` | Less than 60 min since last compound | Wait for cooldown |
| `DAILY_LIMIT` | 10 compounds already today | Wait until tomorrow |
| `GAS_LOW` | STX balance below 0.5 STX reserve | Fund wallet with STX |
| `API_DOWN` | HODLMM or Stacks API unreachable | Check network, retry later |

## Composability

Auto-Compounder works in a pipeline with other HODLMM skills:

1. **hodlmm-dca-executor** → initial swap + deposit into pool
2. **hodlmm-auto-compounder** (this skill) → harvest fees, redeposit for compound growth
3. **hodlmm-position-guardian** → monitor for bin drift, migrate if out of range
4. **hodlmm-pulse** → detect fee velocity changes to optimize compound timing
5. **hodlmm-risk** → assess volatility before compounding in high-risk conditions

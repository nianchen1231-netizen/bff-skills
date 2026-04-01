---
name: Atomic Tortoise
skill: hodlmm-dca-executor
description: "Autonomous DCA agent that converts idle STX into sBTC and deposits into HODLMM pools for concentrated liquidity fee capture."
---

## Decision order

1. Run `doctor` to confirm all APIs are healthy.
2. Run `position --address <wallet>` to check current balances and existing HODLMM positions.
3. If STX balance exceeds the gas reserve (0.5 STX), run `quote --address <wallet> --amount <stx>` to preview the swap.
4. Review the quote. If the estimated output and pool APR are acceptable, run `execute --address <wallet> --amount <stx>` to preview the full pipeline.
5. Inspect the dry-run MCP commands. Only proceed with `--confirm` when the swap amount, slippage, and target bin are correct.
6. After execution, run `position` again to verify the deposit landed.
7. To exit, run `withdraw --address <wallet> --pool <id>` to preview, then `--confirm`.

## Guardrails

| Rule | Value | Rationale |
|------|-------|-----------|
| Max swap | 50 STX | Limits single-trade exposure |
| Min swap | 0.1 STX | Avoids dust transactions |
| Max slippage | 200 bps | Protects against bad fills |
| Gas reserve | 0.5 STX | Ensures wallet can always broadcast |
| Max bin range | ±5 bins | Prevents thin liquidity spread |
| Daily limit | 5 swaps | Rate-limits to avoid overtrading |
| --confirm required | All writes | No accidental execution |

**Hard limits (never override):**

- Never swap more than 50 STX in a single transaction.
- Never proceed if `doctor` reports degraded status.
- Never skip the dry-run preview step.
- Never expose private keys in arguments or logs.

## Polling cadence

| Condition | Interval |
|-----------|----------|
| Normal DCA schedule | Every 24 hours |
| After a swap | Verify position 5 minutes later |
| High volatility (price moved >5%) | Pause DCA, alert operator |
| Low STX balance (<1 STX) | Stop DCA, alert for funding |

## Signal-to-action matrix

| Signal | Action | Auto-execute? |
|--------|--------|---------------|
| STX balance > threshold | Run `quote`, then `execute --confirm` | No — requires --confirm |
| Position out of range | Run `withdraw --confirm`, then `execute --confirm` at new bin | No |
| Daily limit reached | Skip, log, wait until tomorrow | Automatic |
| Insufficient balance | Alert operator, stop DCA | Automatic |
| API degraded | Skip execution, retry next cycle | Automatic |

## Error handling

| Error code | Cause | Recovery |
|------------|-------|----------|
| `BAD_ADDRESS` | Invalid Stacks address | Fix --address parameter |
| `TOO_SMALL` / `TOO_LARGE` | Amount outside guardrails | Adjust --amount |
| `INSUFFICIENT` | Not enough STX after gas reserve | Fund wallet or reduce amount |
| `SLIPPAGE_HIGH` | Slippage exceeds 200 bps | Lower --slippage or accept default |
| `DAILY_LIMIT` | 5 swaps already today | Wait until tomorrow |
| `DOCTOR_FAIL` | API unreachable | Check network, retry later |

## Composability

DCA Executor works in a pipeline with other HODLMM skills:

1. **hodlmm-pulse** → detect fee velocity spike (entry timing signal)
2. **hodlmm-dca-executor** (this skill) → swap + deposit at active bin
3. **hodlmm-position-guardian** → monitor for drift, migrate if needed
4. **hodlmm-bin-guardian** → verify bin placement post-deposit
5. **hodlmm-risk** → assess volatility before next DCA cycle

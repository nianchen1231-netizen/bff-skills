---
name: Atomic Tortoise
skill: hodlmm-position-guardian
description: Autonomous HODLMM LP position manager that detects bin drift, migrates out-of-range liquidity, and compounds earned fees across all Bitflow HODLMM pools.
---

## Decision order

1. Run `doctor` to confirm API health before any operation.
2. Run `scan --address <wallet>` to assess all active positions.
3. If any position shows `recommendation: "MIGRATE"`, run `migrate --address <wallet>` to preview the plan.
4. Review the dry-run output. Only proceed with `migrate --address <wallet> --confirm` when the migration size and target bins are acceptable.
5. If any position shows `recommendation: "COMPOUND"`, run `compound --address <wallet>` to preview, then `--confirm`.
6. If any position shows `recommendation: "EXIT"`, remove liquidity immediately and investigate the pool.
7. Run `history` periodically to identify pools that drift frequently — consider wider bin ranges or different pools for future deposits.

## Guardrails

| Rule | Value | Rationale |
|------|-------|-----------|
| Max single migration value | $5,000 | Limits blast radius of a bad migration |
| Min drift to trigger migrate | 2 bins | Avoids gas waste on minor fluctuations |
| Max re-add bin range | ±10 bins | Prevents thin liquidity across too many bins |
| Min fees to compound | $1.00 | Ignores dust amounts |
| Min STX gas balance | 150,000 uSTX | Ensures tx can be broadcast |
| Write confirmation | `--confirm` flag | All writes are dry-run by default |

**Hard limits (never override):**
- Never migrate a position worth more than $5,000 without manual approval.
- Never borrow or open leveraged positions.
- Never execute without `--confirm`.
- If `doctor` reports degraded status, do not proceed with write operations.

## Polling cadence

| Condition | Interval |
|-----------|----------|
| Normal (all in range) | Every 30 minutes |
| One position out of range | Every 10 minutes |
| Post-migration verification | Single check 5 minutes after execution |
| Low-activity hours (00:00–06:00 UTC) | Every 60 minutes |

## Signal-to-action matrix

| Signal | Action | Auto-execute? |
|--------|--------|---------------|
| `recommendation: "HOLD"` | No action, log scan result | — |
| `recommendation: "MIGRATE"` | Preview migration plan, await confirmation | No — requires `--confirm` |
| `recommendation: "COMPOUND"` | Preview compound plan, await confirmation | No — requires `--confirm` |
| `recommendation: "EXIT"` | Remove all liquidity immediately | No — requires `--confirm` |
| `doctor` returns `degraded` | Skip all write operations, alert operator | — |
| STX balance < 150,000 uSTX | Block all writes, alert for funding | — |

## Error handling

| Error code | Cause | Recovery |
|------------|-------|----------|
| `INVALID_ADDRESS` | Missing or malformed address | Re-run with valid `--address SP...` |
| `INSUFFICIENT_GAS` | STX balance below 150k uSTX | Fund wallet before retrying |
| `VALUE_EXCEEDS_CAP` | Position > $5,000 | Split position manually or adjust cap in source |
| `SCAN_FAIL` | API timeout or connectivity | Retry after 60 seconds; check `doctor` |
| `MIGRATE_FAIL` | Transaction build or broadcast error | Review dry-run output; check nonce conflicts |

## Composability

Position Guardian works best in a pipeline with other HODLMM skills:

1. **hodlmm-pulse** (timing) → detect fee velocity spike
2. **hodlmm-position-guardian** (this skill) → scan + migrate to capture the spike
3. **hodlmm-bin-guardian** (monitoring) → verify post-migration bin placement
4. **hodlmm-risk** (risk) → confirm volatility is within acceptable range

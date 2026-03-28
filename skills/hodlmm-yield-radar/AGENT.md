---
name: hodlmm-yield-radar-agent
skill: hodlmm-yield-radar
description: "Monitors HODLMM pools for yield opportunities, tracks position health, and recommends optimal entry strategies for concentrated liquidity provision on Bitflow."
---

# Agent Behavior — HODLMM Yield Radar

## Decision order

1. Run `doctor` first to verify Bitflow API connectivity. If connectivity fails, surface the error and halt — all subsequent commands depend on it.
2. Run `status` to get a live pool overview. Identify the top-ranked pool by fee APR.
3. If an existing position needs checking, run `run position --pool-id <id> --address <addr>` and route on `recommendation`:
   - `hold` — position is healthy and in range, no action needed
   - `rebalance` — position has drifted, agent should flag for rebalancing via a write skill
   - `exit` — position is significantly out of range, surface to user for withdrawal decision
4. If evaluating a new entry, run `run analyze --pool-id <id>` on the top candidate to confirm the composite yield score before proceeding.
5. If `compositeYieldScore >= 50` and the user or upstream agent intends to enter, run `run entry --pool-id <id> --amount-usd <amount>` to generate parameters.
6. Pass the `run entry` output to a write skill for transaction execution — never execute transactions directly.

## Guardrails

- This skill is read-only. Never submit transactions or move funds from within this skill.
- Never expose wallet private keys or mnemonics in command arguments or logs.
- Default to read-only behavior when intent is ambiguous — prefer `status` or `run analyze` over `run entry`.
- Never act on a pool where `doctor` has not returned a successful connectivity check in the current session.
- Do not pass `run entry` parameters directly to a write skill without surfacing them to the user first. The user or orchestrating agent must review the bin range and allocation before execution.
- If `reserveImbalanceRatio > 0.7` on the target pool, flag the imbalance to the user before recommending entry.

## Output contract

All commands return a unified JSON envelope:

```json
{
  "status": "success | error | blocked",
  "action": "human-readable summary or next step",
  "data": {},
  "error": null
}
```

Route on `status`:
- `success` — data is valid, proceed per decision order
- `error` — surface the `error` field to the user, do not silently retry
- `blocked` — a pre-condition was not met (e.g. no position found); surface the `action` field guidance

## On error

- If Bitflow API is unreachable (`doctor` fails): surface "Bitflow API unavailable — skip yield operations this cycle" and halt.
- If pool data is stale or returns empty bins: surface "Pool data unavailable — retry after 60s".
- If `run position` returns no position for address: return `blocked` — do not treat as an error requiring retry.
- If `run entry` returns `error`: do not pass partial parameters to a write skill. Surface the error to the user.
- Do not retry silently. Always surface the `action` field guidance to the user or orchestrating agent.

## On success

- After `status`: report the top pool by fee APR and its `yieldLabel`.
- After `run analyze`: report `compositeYieldScore`, `yieldLabel`, and 24h fee APR. Recommend proceeding to `run entry` only if score >= 50.
- After `run position`: report `inRange` status, `recommendation`, and `estimatedIlPct`. If `recommendation` is `rebalance` or `exit`, include the bin offset distance.
- After `run entry`: surface the full entry parameter payload to the user before handing off to a write skill. Confirm pool ID, bin range, token amounts, and price bounds are as expected.
- Always include `timestamp` from the data payload for staleness tracking.

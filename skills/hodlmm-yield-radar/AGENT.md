---
name: hodlmm-yield-radar-agent
skill: hodlmm-yield-radar
description: "Monitors Bitflow pools for yield opportunities, tracks LP token holdings, and generates entry parameters for liquidity provision on Stacks."
---

# Agent Behavior — HODLMM Yield Radar

## Decision order

1. Run `doctor` first to verify Bitflow API and Hiro API connectivity. If connectivity fails, surface the error and halt — all subsequent commands depend on it.
2. Run `status` to get a live pool overview. Identify the top-ranked pool by `fee_apy_pct`.
3. If an existing position needs checking, run `run position --address <stx_address>` to list LP token holdings for the wallet.
4. If evaluating a new entry, run `run analyze --amount <usd_value>` to get the top 3 pools ranked by risk-adjusted score with projected yields.
5. If a specific pool looks attractive, run `run entry --pool <pool_id> --amount <usd_value>` to generate entry parameters and safety checks.
6. Pass the `run entry` output to a write skill for transaction execution — never execute transactions directly.

## Guardrails

- This skill is read-only. Never submit transactions or move funds from within this skill.
- Never expose wallet private keys or mnemonics in command arguments or logs.
- Default to read-only behavior when intent is ambiguous — prefer `status` or `run analyze` over `run entry`.
- Never act on a pool where `doctor` has not returned a successful connectivity check in the current session.
- Do not pass `run entry` parameters directly to a write skill without surfacing them to the user first. The user or orchestrating agent must review token amounts and safety checks before execution.
- If `run entry` safety checks show `position_size` as not ok (deposit > 10% of pool TVL), flag this to the user before proceeding.

## Output contract

All commands return a unified JSON envelope:

```json
{
  "status": "success | ready | error",
  "action": "command name or human-readable summary",
  "data": {},
  "error": null
}
```

Route on `status`:
- `success` / `ready` — data is valid, proceed per decision order
- `error` — surface the `error` field to the user, do not silently retry

## On error

- If Bitflow API is unreachable (`doctor` fails): surface "Bitflow API unavailable — skip yield operations this cycle" and halt.
- If pool data returns empty: surface "No qualifying pools found — retry later".
- If `run position` returns no LP tokens: report "No Bitflow LP tokens found" — do not treat as an error requiring retry.
- If `run entry` returns `error`: do not pass partial parameters to a write skill. Surface the error to the user.
- Do not retry silently. Always surface the `action` field guidance to the user or orchestrating agent.

## On success

- After `status`: report the top pool by `fee_apy_pct`, its liquidity, and 24h volume.
- After `run analyze`: report the top recommendation's `risk_adjusted_score`, `fee_apy_pct`, and projected daily/weekly yields.
- After `run position`: report LP token holdings found and their matched pools.
- After `run entry`: surface the full entry parameter payload including `safetyChecks` and `mcpCommand` to the user before handing off to a write skill. Confirm pool ID, token amounts, and slippage settings.
- Always include `timestamp` from the data payload for staleness tracking.

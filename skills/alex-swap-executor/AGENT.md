---
name: alex-swap-executor-agent
skill: alex-swap-executor
description: "Agent behavior rules for ALEX Swap Executor — autonomous token swap execution on ALEX DEX."
---

# Agent Behavior — ALEX Swap Executor

## Decision order
1. Run `doctor` to verify wallet connectivity, token balances, and ALEX API access.
2. Run `status` to check current holdings and ALEX pool liquidity/prices.
3. When a swap is needed:
   a. Run `quote --from <token> --to <token> --amount <n>` to preview the trade.
   b. Verify the quoted output meets expectations (check slippage, route hops).
   c. Run `swap --from <token> --to <token> --amount <n> --confirm` to execute.
4. For limit-order behavior, use `auto --target-price <p> --confirm` to wait and execute.
5. After any swap, verify the transaction on-chain via `history`.

## Guardrails
- **NEVER swap without --confirm.** The flag is a safety gate on real fund movement.
- **NEVER exceed the spend cap.** Default 100,000 sats per swap. If the agent needs more, a human must adjust settings.
- **NEVER ignore slippage warnings.** If quoted output is >1% worse than expected, abort and re-quote.
- **NEVER swap into unknown tokens.** Only trade tokens in the approved list: STX, sBTC, ALEX, stSTX, USDA, xBTC.
- **ALWAYS verify tx confirmation** before reporting success. A broadcast is not a confirmation.
- **ALWAYS log every swap** to the local ledger for audit trail.
- **Cooldown is mandatory.** 5-minute minimum between same-pair swaps prevents panic trading.
- **Route transparency.** Before executing a multi-hop swap, display the full route to the user. Hidden intermediate tokens are not acceptable.

## When NOT to swap
- Gas fees exceed 5% of swap value — not economical.
- ALEX API is unreachable or returning stale data (>60s old).
- Wallet balance insufficient for swap amount + gas.
- Token pair has <$1,000 pool liquidity — slippage risk too high.

## Autonomous mode rules
- `auto` mode polls every 60 seconds for price conditions.
- Maximum 3 executions per auto session.
- Auto mode exits after 1 hour if target not reached.
- All auto executions still enforce slippage cap and spend cap.

#!/usr/bin/env bun

/**
 * HODLMM DCA Executor
 *
 * Dollar-cost averages STX into sBTC via Bitflow, then deposits into
 * HODLMM concentrated liquidity pools around the active bin.
 * Full execution loop: swap → deposit → monitor → compound.
 *
 * Commands: doctor | quote | execute | position | withdraw
 */

import { Command } from "commander";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { deserializeCV, cvToJSON } from "@stacks/transactions";

// ─── Constants ───────────────────────────────────────────────────────────────

const HODLMM_API = "https://bff.bitflowapis.finance/api";
const STACKS_API = "https://api.mainnet.hiro.so";
const API_TIMEOUT = 15_000;

// Bitflow contracts (mainnet)
const CONTRACTS = {
  xykCore: "SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-core-v-1-2",
  xykPoolSbtcStx: "SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-pool-sbtc-stx-v-1-1",
  dlmmRouter: "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-swap-router-v-1-2",
  dlmmPoolStxSbtc: "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-stx-sbtc-v-1-bps-15",
  tokenStx: "SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.token-stx-v-1-2",
  sbtcToken: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token",
};

// Hardcoded safety guardrails
const MAX_SWAP_STX = 50_000_000; // 50 STX max per swap
const MIN_SWAP_STX = 100_000;   // 0.1 STX minimum
const MAX_SLIPPAGE_BPS = 200;   // 2% max slippage
const DEFAULT_SLIPPAGE_BPS = 100; // 1% default
const MIN_STX_RESERVE = 500_000; // keep 0.5 STX for gas
const MAX_BIN_RANGE = 5;        // ±5 bins around active
const MIN_DEPOSIT_SBTC = 10;    // 10 sats minimum deposit
const MAX_DAILY_SWAPS = 5;      // rate limit
const MIN_SWAP_INTERVAL_MS = 30 * 60 * 1000; // 30-min cooldown between swaps
const MAX_CUMULATIVE_STX = 500_000_000; // 500 STX lifetime cap

const STATE_DIR = join(process.env.HOME ?? "/tmp", ".hodlmm-dca");
const STATE_FILE = join(STATE_DIR, "state.json");

// ─── Types ───────────────────────────────────────────────────────────────────

interface McpCommand {
  step: number;
  tool: string;
  description: string;
  params: Record<string, unknown>;
}

interface DcaState {
  totalSwappedStx: number;
  swapCount: number;
  lastSwapDate: string;
  lastSwapTime: number; // epoch ms for cooldown
  dailySwapCount: number;
  deposits: { poolId: string; binIds: number[]; date: string }[];
}

// Input validation helper
function validateAmount(val: number): number {
  if (!Number.isFinite(val) || val <= 0) throw new Error("Invalid amount: must be a positive number");
  return val;
}
function validateSlippage(val: number): number {
  if (!Number.isFinite(val) || val < 0) throw new Error("Invalid slippage: must be >= 0");
  return val;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function out(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}

function errOut(code: string, message: string, next: string): void {
  out({ status: "error", action: "error", data: null, error: { code, message, next } });
}

async function fetchJson(url: string): Promise<any> {
  const resp = await fetch(url, { signal: AbortSignal.timeout(API_TIMEOUT) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

function loadState(): DcaState {
  try {
    if (!existsSync(STATE_FILE)) return { totalSwappedStx: 0, swapCount: 0, lastSwapDate: "", lastSwapTime: 0, dailySwapCount: 0, deposits: [] };
    const s = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
    const today = new Date().toISOString().slice(0, 10);
    if (s.lastSwapDate !== today) { s.dailySwapCount = 0; s.lastSwapDate = today; }
    return s;
  } catch { return { totalSwappedStx: 0, swapCount: 0, lastSwapDate: "", lastSwapTime: 0, dailySwapCount: 0, deposits: [] }; }
}

function saveState(s: DcaState): void {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

// ─── API Layer ───────────────────────────────────────────────────────────────

async function getStxBalance(address: string): Promise<number> {
  const d = await fetchJson(`${STACKS_API}/extended/v1/address/${address}/stx`);
  return Number(d.balance ?? 0);
}

async function getSbtcBalance(address: string): Promise<number> {
  const d = await fetchJson(`${STACKS_API}/extended/v1/address/${address}/balances`);
  const ft = d.fungible_tokens ?? {};
  const sbtcKey = Object.keys(ft).find(k => k.includes("sbtc-token"));
  return sbtcKey ? Number(ft[sbtcKey].balance ?? 0) : 0;
}

async function getBtcPrice(): Promise<number> {
  const d = await fetchJson("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd");
  return d?.bitcoin?.usd ?? 0;
}

async function getStxPrice(): Promise<number> {
  const d = await fetchJson("https://api.coingecko.com/api/v3/simple/price?ids=stacks&vs_currencies=usd");
  return d?.stacks?.usd ?? 0;
}

async function getHodlmmPool(poolId: string): Promise<any> {
  const resp = await fetchJson(`${HODLMM_API}/app/v1/pools`);
  const pools = resp?.data ?? (Array.isArray(resp) ? resp : []);
  return pools.find((p: any) => (p.poolId ?? p.pool_id) === poolId);
}

// DLMM pool contract mapping for on-chain reads
const DLMM_CONTRACTS: Record<string, string> = {
  dlmm_1: "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-sbtc-usdcx-v-1-bps-10",
  dlmm_2: "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-sbtc-usdcx-v-1-bps-1",
  dlmm_3: "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-stx-usdcx-v-1-bps-10",
  dlmm_4: "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-stx-usdcx-v-1-bps-4",
  dlmm_5: "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-stx-usdcx-v-1-bps-1",
  dlmm_6: "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-stx-sbtc-v-1-bps-15",
  dlmm_7: "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-aeusdc-usdcx-v-1-bps-1",
  dlmm_8: "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-usdh-usdcx-v-1-bps-1",
};

// Pools compatible with STX→sBTC swap output (must contain sBTC as token X or Y)
const SBTC_COMPATIBLE_POOLS = ["dlmm_1", "dlmm_2", "dlmm_6"];

// On-chain read: get active bin ID directly from DLMM pool contract
async function getActiveBinOnChain(poolId: string): Promise<number> {
  const contract = DLMM_CONTRACTS[poolId];
  if (!contract) throw new Error(`Unknown pool contract for ${poolId}`);
  const [addr, name] = contract.split(".");
  const resp = await fetch(`${STACKS_API}/v2/contracts/call-read/${addr}/${name}/get-active-bin-id`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sender: "SP000000000000000000002Q6VF78", arguments: [] }),
    signal: AbortSignal.timeout(API_TIMEOUT),
  });
  if (!resp.ok) throw new Error(`Active bin read failed: HTTP ${resp.status}`);
  const data = await resp.json() as any;
  if (!data?.okay) throw new Error("Active bin call failed");
  const json = cvToJSON(deserializeCV(data.result)) as any;
  return Number(json.value?.value ?? json.value ?? 0);
}

// On-chain read-only contract call: get XYK pool reserves for accurate swap pricing
// Uses @stacks/transactions deserializeCV for robust Clarity value decoding
async function getPoolReserves(): Promise<{ reserveStx: number; reserveSbtc: number }> {
  const url = `${STACKS_API}/v2/contracts/call-read/SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR/xyk-pool-sbtc-stx-v-1-1/get-pool`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sender: "SP000000000000000000002Q6VF78", arguments: [] }),
    signal: AbortSignal.timeout(API_TIMEOUT),
  });
  if (!resp.ok) throw new Error(`Pool reserves API returned HTTP ${resp.status}`);

  const data = await resp.json() as any;
  if (!data?.okay || !data.result) throw new Error("Pool reserves call failed: " + (data?.cause ?? "no result"));

  // Decode Clarity value using @stacks/transactions (robust, handles all CV types)
  const cv = deserializeCV(data.result);
  const json = cvToJSON(cv) as any;

  // Structure: (ok (tuple ...)) → json.value.value["x-balance"].value
  const tuple = json.value?.value ?? json.value;
  if (!tuple?.["x-balance"] || !tuple?.["y-balance"]) {
    throw new Error("Pool tuple missing x-balance or y-balance");
  }

  const reserveSbtc = Number(tuple["x-balance"].value);
  const reserveStx = Number(tuple["y-balance"].value);

  if (reserveSbtc <= 0 || reserveStx <= 0) throw new Error(`Invalid reserves: STX=${reserveStx}, sBTC=${reserveSbtc}`);

  return { reserveStx, reserveSbtc };
}

// Estimate swap output from pool reserves (constant product: dy = y * dx / (x + dx))
function estimateSwapOutput(amountStx: number, reserveStx: number, reserveSbtc: number, feeBps: number = 30): number {
  if (reserveStx <= 0 || reserveSbtc <= 0) return 0;
  const amountAfterFee = amountStx * (1 - feeBps / 10_000);
  return Math.floor(reserveSbtc * amountAfterFee / (reserveStx + amountAfterFee));
}

// ─── MCP Command Builders ────────────────────────────────────────────────────

function buildSwapCommand(amountStx: number, slippageBps: number, estimatedSbtc: number): McpCommand[] {
  // Enforce slippage at contract level via min-dx parameter
  const minSbtcOut = Math.max(1, Math.floor(estimatedSbtc * (1 - slippageBps / 10_000)));
  return [
    {
      step: 1,
      tool: "call_contract",
      description: `Swap ${(amountStx / 1e6).toFixed(2)} STX → sBTC via Bitflow XYK (min output: ${minSbtcOut} sats, slippage: ${slippageBps}bps)`,
      params: {
        contract_address: "SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR",
        contract_name: "xyk-core-v-1-2",
        function_name: "swap-y-for-x",
        function_args: [
          { type: "trait_reference", value: CONTRACTS.xykPoolSbtcStx },
          { type: "trait_reference", value: CONTRACTS.sbtcToken },
          { type: "trait_reference", value: CONTRACTS.tokenStx },
          { type: "uint128", value: amountStx },
          { type: "uint128", value: minSbtcOut },
        ],
        post_condition_mode: "deny",
        post_conditions: [
          {
            type: "stx",
            principal: "origin",
            condition: "sent_less_than_or_equal",
            amount: amountStx,
          },
        ],
      },
    },
  ];
}

function buildDepositCommand(poolId: string, activeBinId: number, binRange: number): McpCommand[] {
  return [
    {
      step: 2,
      tool: "bitflow_hodlmm_add_liquidity",
      description: `Deposit sBTC into HODLMM ${poolId} at active bin ${activeBinId} ±${binRange}`,
      params: {
        poolId,
        targetBinId: activeBinId,
        binRange,
      },
    },
  ];
}

function buildWithdrawCommand(poolId: string, binIds: number[]): McpCommand[] {
  return [
    {
      step: 1,
      tool: "bitflow_hodlmm_remove_liquidity",
      description: `Withdraw all liquidity from HODLMM ${poolId} bins [${binIds.join(", ")}]`,
      params: {
        poolId,
        binIds,
      },
    },
  ];
}

// ─── Commands ────────────────────────────────────────────────────────────────

async function cmdDoctor(): Promise<void> {
  const checks: Record<string, string> = {};

  try {
    await fetchJson(`${STACKS_API}/v2/info`);
    checks["stacks_api"] = "ok";
  } catch (e: any) { checks["stacks_api"] = `fail: ${e.message}`; }

  try {
    const pools = await fetchJson(`${HODLMM_API}/app/v1/pools`);
    const list = pools?.data ?? (Array.isArray(pools) ? pools : []);
    checks["hodlmm_api"] = `ok (${list.length} pools)`;
  } catch (e: any) { checks["hodlmm_api"] = `fail: ${e.message}`; }

  try {
    const activeBin = await getActiveBinOnChain("dlmm_6");
    checks["hodlmm_active_bin"] = `ok (on-chain active_bin: ${activeBin})`;
  } catch (e: any) { checks["hodlmm_bins"] = `fail: ${e.message}`; }

  try {
    const reserves = await getPoolReserves();
    const rate = (reserves.reserveSbtc / reserves.reserveStx * 1e6).toFixed(0);
    checks["xyk_pool_reserves"] = `ok (1 STX = ${rate} sats, STX: ${(reserves.reserveStx / 1e6).toFixed(0)}, sBTC: ${reserves.reserveSbtc})`;
  } catch (e: any) { checks["xyk_pool_reserves"] = `fail: ${e.message}`; }

  try {
    await getBtcPrice();
    checks["price_feed"] = "ok";
  } catch (e: any) { checks["price_feed"] = `fail: ${e.message}`; }

  const allOk = Object.values(checks).every(v => v.startsWith("ok"));
  out({
    status: allOk ? "success" : "degraded",
    action: "doctor",
    data: {
      checks,
      contracts: CONTRACTS,
      guardrails: {
        max_swap_stx: MAX_SWAP_STX / 1e6,
        min_swap_stx: MIN_SWAP_STX / 1e6,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
        max_daily_swaps: MAX_DAILY_SWAPS,
        min_stx_reserve: MIN_STX_RESERVE / 1e6,
        max_bin_range: MAX_BIN_RANGE,
        min_deposit_sbtc: MIN_DEPOSIT_SBTC,
      },
    },
    error: null,
  });
}

async function cmdQuote(address: string, amountStx: number): Promise<void> {
  if (!address?.startsWith("SP") && !address?.startsWith("SM")) { errOut("BAD_ADDRESS", "Need a valid Stacks address (SP.../SM...)", "--address SP..."); return; }

  try { amountStx = validateAmount(amountStx); } catch { errOut("BAD_AMOUNT", "Amount must be a positive number", "--amount 2"); return; }
  const amountUstx = Math.round(amountStx * 1e6);
  if (amountUstx < MIN_SWAP_STX) { errOut("TOO_SMALL", `Min swap: ${MIN_SWAP_STX / 1e6} STX`, `Use --amount ${MIN_SWAP_STX / 1e6} or higher`); return; }
  if (amountUstx > MAX_SWAP_STX) { errOut("TOO_LARGE", `Max swap: ${MAX_SWAP_STX / 1e6} STX`, `Use --amount ${MAX_SWAP_STX / 1e6} or less`); return; }

  const [balance, reserves, pool] = await Promise.all([
    getStxBalance(address),
    getPoolReserves(),
    getHodlmmPool("dlmm_6"),
  ]);

  const available = balance - MIN_STX_RESERVE;
  if (amountUstx > available) {
    errOut("INSUFFICIENT", `Need ${amountStx} STX but only ${(available / 1e6).toFixed(2)} available (after ${MIN_STX_RESERVE / 1e6} STX gas reserve)`, "Reduce amount or fund wallet");
    return;
  }

  // Use on-chain pool reserves for accurate pricing (same method as execute)
  const estimatedSbtc = estimateSwapOutput(amountUstx, reserves.reserveStx, reserves.reserveSbtc);
  const poolApr = pool?.apr ?? 0;
  const impliedStxPerBtc = reserves.reserveStx / reserves.reserveSbtc * (1e8 / 1e6);

  out({
    status: "success",
    action: "quote",
    data: {
      input: { stx: amountStx },
      estimated_output: { sbtc_sats: estimatedSbtc },
      pool: { id: "dlmm_6", pair: "STX/sBTC", apr: poolApr, tvl_usd: pool?.tvlUsd ?? 0 },
      pool_reserves: { stx: (reserves.reserveStx / 1e6).toFixed(0), sbtc_sats: reserves.reserveSbtc, implied_rate: `1 STX = ${(reserves.reserveSbtc / reserves.reserveStx * 1e6).toFixed(0)} sats` },
      wallet: { stx_balance: (balance / 1e6).toFixed(2), available_after_reserve: (available / 1e6).toFixed(2) },
      note: "Quote from on-chain XYK pool reserves. Actual output may vary with slippage.",
    },
    error: null,
  });
}

async function cmdExecute(address: string, amountStx: number, slippageBps: number, poolId: string, confirm: boolean): Promise<void> {
  if (!address?.startsWith("SP") && !address?.startsWith("SM")) { errOut("BAD_ADDRESS", "Need a valid Stacks address (SP.../SM...)", "--address SP..."); return; }

  try { amountStx = validateAmount(amountStx); } catch { errOut("BAD_AMOUNT", "Amount must be a positive number", "--amount 2"); return; }
  try { slippageBps = validateSlippage(slippageBps); } catch { errOut("BAD_SLIPPAGE", "Slippage must be >= 0", "--slippage 100"); return; }

  // Validate poolId: must be known AND compatible with STX→sBTC swap output
  if (!DLMM_CONTRACTS[poolId]) {
    errOut("BAD_POOL", `Unknown pool '${poolId}'. Valid: ${Object.keys(DLMM_CONTRACTS).join(", ")}`, "--pool dlmm_6");
    return;
  }
  if (!SBTC_COMPATIBLE_POOLS.includes(poolId)) {
    errOut("INCOMPATIBLE_POOL", `Pool '${poolId}' does not contain sBTC. After STX→sBTC swap, only these pools accept deposit: ${SBTC_COMPATIBLE_POOLS.join(", ")}`, `--pool ${SBTC_COMPATIBLE_POOLS[2]}`);
    return;
  }

  // Pre-flight: verify Stacks API is reachable before any write operation
  try { await fetchJson(`${STACKS_API}/v2/info`); } catch {
    errOut("API_DOWN", "Stacks API unreachable — refusing to execute", "Run 'doctor' to diagnose");
    return;
  }

  const amountUstx = Math.round(amountStx * 1e6);
  if (amountUstx < MIN_SWAP_STX) { errOut("TOO_SMALL", `Min swap: ${MIN_SWAP_STX / 1e6} STX`, "Increase amount"); return; }
  if (amountUstx > MAX_SWAP_STX) { errOut("TOO_LARGE", `Max swap: ${MAX_SWAP_STX / 1e6} STX`, "Decrease amount"); return; }
  if (slippageBps > MAX_SLIPPAGE_BPS) { errOut("SLIPPAGE_HIGH", `Max slippage: ${MAX_SLIPPAGE_BPS} bps`, `Use --slippage ${MAX_SLIPPAGE_BPS} or less`); return; }

  const state = loadState();
  if (state.dailySwapCount >= MAX_DAILY_SWAPS) {
    errOut("DAILY_LIMIT", `Daily swap limit reached (${MAX_DAILY_SWAPS})`, "Wait until tomorrow");
    return;
  }

  // Cooldown check: 30 minutes between swaps
  const elapsed = Date.now() - (state.lastSwapTime || 0);
  if (elapsed < MIN_SWAP_INTERVAL_MS) {
    const waitMin = Math.ceil((MIN_SWAP_INTERVAL_MS - elapsed) / 60_000);
    errOut("COOLDOWN", `Cooldown active, wait ${waitMin} minutes`, `Next swap available in ${waitMin}m`);
    return;
  }

  // Cumulative cap check
  if (state.totalSwappedStx + amountUstx > MAX_CUMULATIVE_STX) {
    errOut("CUMULATIVE_CAP", `Lifetime cap ${MAX_CUMULATIVE_STX / 1e6} STX reached (used: ${(state.totalSwappedStx / 1e6).toFixed(2)})`, "Cap reached, no more swaps");
    return;
  }

  const balance = await getStxBalance(address);
  // Reserve enough for gas on both swap + deposit transactions
  const gasReserve = MIN_STX_RESERVE * 2; // 1 STX total for 2 txs
  const available = balance - gasReserve;
  if (amountUstx > available) {
    errOut("INSUFFICIENT", `Need ${amountStx} STX, only ${(available / 1e6).toFixed(2)} available (after ${gasReserve / 1e6} STX gas reserve)`, "Fund wallet or reduce amount");
    return;
  }

  // Get pool data from on-chain reads (active bin + reserves)
  const [activeBinId, reserves] = await Promise.all([
    getActiveBinOnChain(poolId),
    getPoolReserves(),
  ]);
  const binRange = MAX_BIN_RANGE; // ±5 bins around active, matching SKILL.md

  // Calculate estimated output from pool reserves (more accurate than CoinGecko)
  const estimatedSbtc = estimateSwapOutput(amountUstx, reserves.reserveStx, reserves.reserveSbtc);
  if (estimatedSbtc <= 0) {
    errOut("NO_LIQUIDITY", "Pool has insufficient liquidity for this swap", "Try a smaller amount or different pool");
    return;
  }
  if (estimatedSbtc < MIN_DEPOSIT_SBTC) {
    errOut("DUST_OUTPUT", `Estimated output ${estimatedSbtc} sats below minimum deposit (${MIN_DEPOSIT_SBTC} sats)`, "Increase swap amount");
    return;
  }

  const commands = [
    ...buildSwapCommand(amountUstx, slippageBps, estimatedSbtc),
    ...buildDepositCommand(poolId, activeBinId, binRange),
  ];

  if (!confirm) {
    out({
      status: "success",
      action: "execute_preview",
      data: {
        warning: "DRY RUN — pass --confirm to execute",
        swap: { stx_in: amountStx, pool: poolId, slippage_bps: slippageBps, estimated_sbtc_out: estimatedSbtc },
        deposit: { target_bin: activeBinId, bin_range: binRange },
        commands,
      },
      error: null,
    });
    return;
  }

  // Record intent and start cooldown. If tx fails, agent calls `position` to verify,
  // then can retry after cooldown expires. Counters prevent rapid re-execution.
  state.totalSwappedStx += amountUstx;
  state.swapCount++;
  state.dailySwapCount++;
  state.lastSwapDate = new Date().toISOString().slice(0, 10);
  state.lastSwapTime = Date.now();
  state.deposits.push({
    poolId,
    binIds: Array.from({ length: binRange * 2 + 1 }, (_, i) => activeBinId - binRange + i),
    date: new Date().toISOString(),
  });
  saveState(state);

  out({
    status: "success",
    action: "execute",
    data: {
      execute: true,
      swap: { stx_in: amountStx, pool: poolId, estimated_sbtc_out: estimatedSbtc },
      deposit: { target_bin: activeBinId, bin_range: binRange },
      commands,
      next_steps: [
        "Agent: submit MCP commands in order (step 1 → step 2)",
        "After execution: run 'position --address' to verify on-chain success",
        `Cooldown: next swap available in ${MIN_SWAP_INTERVAL_MS / 60_000} minutes`,
      ],
      limits: { daily_remaining: MAX_DAILY_SWAPS - state.dailySwapCount, lifetime_remaining_stx: (MAX_CUMULATIVE_STX - state.totalSwappedStx) / 1e6 },
    },
    error: null,
  });
}

async function cmdPosition(address: string): Promise<void> {
  if (!address?.startsWith("SP") && !address?.startsWith("SM")) { errOut("BAD_ADDRESS", "Need a valid Stacks address (SP.../SM...)", "--address SP..."); return; }

  const [stxBal, sbtcBal, stxPrice, btcPrice] = await Promise.all([
    getStxBalance(address),
    getSbtcBalance(address),
    getStxPrice(),
    getBtcPrice(),
  ]);

  // Check HODLMM positions
  const poolIds = ["dlmm_1", "dlmm_2", "dlmm_3", "dlmm_4", "dlmm_5", "dlmm_6", "dlmm_7", "dlmm_8"];
  const positions: any[] = [];

  for (const pid of poolIds) {
    try {
      const resp = await fetchJson(`${HODLMM_API}/app/v1/users/${address}/positions/${pid}/bins`);
      const bins = resp?.bins ?? resp?.position_bins ?? [];
      const userBins = (Array.isArray(bins) ? bins : []).filter((b: any) => (b.user_liquidity ?? 0) > 0);
      if (userBins.length > 0) {
        const activeBinId = await getActiveBinOnChain(pid);
        positions.push({
          poolId: pid,
          bins: userBins.length,
          binIds: userBins.map((b: any) => b.bin_id),
          activeBin: activeBinId,
          inRange: userBins.some((b: any) => b.bin_id === activeBinId),
        });
      }
    } catch {}
  }

  const state = loadState();

  out({
    status: "success",
    action: "position",
    data: {
      wallet: {
        stx: (stxBal / 1e6).toFixed(2),
        stx_usd: (stxBal / 1e6 * stxPrice).toFixed(2),
        sbtc_sats: sbtcBal,
        sbtc_usd: (sbtcBal / 1e8 * btcPrice).toFixed(2),
      },
      hodlmm_positions: positions,
      dca_history: {
        total_swapped_stx: (state.totalSwappedStx / 1e6).toFixed(2),
        swap_count: state.swapCount,
        deposits: state.deposits.length,
      },
    },
    error: null,
  });
}

async function cmdWithdraw(address: string, poolId: string, confirm: boolean): Promise<void> {
  if (!address?.startsWith("SP") && !address?.startsWith("SM")) { errOut("BAD_ADDRESS", "Need a valid Stacks address (SP.../SM...)", "--address SP..."); return; }

  try {
    const resp = await fetchJson(`${HODLMM_API}/app/v1/users/${address}/positions/${poolId}/bins`);
    const bins = resp?.bins ?? resp?.position_bins ?? [];
    const userBins = (Array.isArray(bins) ? bins : []).filter((b: any) => (b.user_liquidity ?? 0) > 0);

    if (userBins.length === 0) {
      out({ status: "success", action: "withdraw", data: { message: "No position found in " + poolId }, error: null });
      return;
    }

    const binIds = userBins.map((b: any) => b.bin_id);
    const commands = buildWithdrawCommand(poolId, binIds);

    if (!confirm) {
      out({ status: "success", action: "withdraw_preview", data: { warning: "DRY RUN — pass --confirm to execute", poolId, binIds, commands }, error: null });
      return;
    }

    out({ status: "success", action: "withdraw", data: { execute: true, poolId, binIds, commands }, error: null });
  } catch (e: any) {
    errOut("WITHDRAW_FAIL", e.message, "Check pool ID and try again");
  }
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

const program = new Command();
program.name("hodlmm-dca-executor").description("DCA STX into sBTC and deposit into HODLMM pools").version("1.0.0");

program.command("doctor").description("Check API connectivity and guardrails").action(async () => {
  try { await cmdDoctor(); } catch (e: any) { errOut("DOCTOR_FAIL", e.message, "Check network"); }
});

program.command("quote").description("Get a swap quote without executing")
  .requiredOption("--address <address>", "Stacks address (SP...)")
  .requiredOption("--amount <stx>", "Amount of STX to swap", parseFloat)
  .action(async (opts) => {
    try { await cmdQuote(opts.address, opts.amount); } catch (e: any) { errOut("QUOTE_FAIL", e.message, "Retry"); }
  });

program.command("execute").description("Swap STX→sBTC and deposit into HODLMM pool")
  .requiredOption("--address <address>", "Stacks address (SP...)")
  .requiredOption("--amount <stx>", "STX amount to swap", parseFloat)
  .option("--slippage <bps>", "Slippage tolerance in basis points", parseInt, DEFAULT_SLIPPAGE_BPS)
  .option("--pool <id>", "HODLMM pool ID", "dlmm_6")
  .option("--confirm", "Execute (default: dry run)", false)
  .action(async (opts) => {
    try { await cmdExecute(opts.address, opts.amount, opts.slippage, opts.pool, opts.confirm); } catch (e: any) { errOut("EXEC_FAIL", e.message, "Retry"); }
  });

program.command("position").description("Check wallet balances and HODLMM positions")
  .requiredOption("--address <address>", "Stacks address (SP...)")
  .action(async (opts) => {
    try { await cmdPosition(opts.address); } catch (e: any) { errOut("POS_FAIL", e.message, "Retry"); }
  });

program.command("withdraw").description("Remove liquidity from HODLMM pool")
  .requiredOption("--address <address>", "Stacks address (SP...)")
  .option("--pool <id>", "HODLMM pool ID", "dlmm_6")
  .option("--confirm", "Execute (default: dry run)", false)
  .action(async (opts) => {
    try { await cmdWithdraw(opts.address, opts.pool, opts.confirm); } catch (e: any) { errOut("WITHDRAW_FAIL", e.message, "Retry"); }
  });

program.parse();

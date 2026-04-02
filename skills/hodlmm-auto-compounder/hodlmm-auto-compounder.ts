#!/usr/bin/env bun

/**
 * HODLMM Auto-Compounder
 *
 * Claims uncollected LP fees from Bitflow HODLMM concentrated liquidity
 * pools and redeposits them at the current active bin for compound growth.
 *
 * Commands: doctor | scan | compound | history
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
  sbtcToken: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token",
};

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

// Hardcoded safety guardrails
const MIN_COMPOUND_SATS = 100;         // skip dust
const MAX_COMPOUND_SATS = 50_000;      // 0.0005 BTC cap
const MIN_STX_RESERVE = 500_000;       // 0.5 STX for gas
const MAX_BIN_RANGE = 5;               // ±5 bins around active
const MAX_DAILY_COMPOUNDS = 10;        // rate limit
const MIN_COMPOUND_INTERVAL_MS = 60 * 60 * 1000; // 60-min cooldown

const STATE_DIR = join(process.env.HOME ?? "/tmp", ".hodlmm-compounder");
const STATE_FILE = join(STATE_DIR, "state.json");

// ─── Types ───────────────────────────────────────────────────────────────────

interface McpCommand {
  step: number;
  tool: string;
  description: string;
  params: Record<string, unknown>;
}

interface CompoundRecord {
  poolId: string;
  feesClaimed: number;
  redeposited: number;
  activeBin: number;
  date: string;
}

interface CompounderState {
  totalCompounded: number;   // cumulative sats compounded
  compoundCount: number;
  lastCompoundDate: string;
  lastCompoundTime: number;  // epoch ms for cooldown
  dailyCompoundCount: number;
  history: CompoundRecord[];
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

function loadState(): CompounderState {
  try {
    if (!existsSync(STATE_FILE)) return { totalCompounded: 0, compoundCount: 0, lastCompoundDate: "", lastCompoundTime: 0, dailyCompoundCount: 0, history: [] };
    const s = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
    const today = new Date().toISOString().slice(0, 10);
    if (s.lastCompoundDate !== today) { s.dailyCompoundCount = 0; s.lastCompoundDate = today; }
    return s;
  } catch { return { totalCompounded: 0, compoundCount: 0, lastCompoundDate: "", lastCompoundTime: 0, dailyCompoundCount: 0, history: [] }; }
}

function saveState(s: CompounderState): void {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

// ─── API Layer ───────────────────────────────────────────────────────────────

async function getStxBalance(address: string): Promise<number> {
  const d = await fetchJson(`${STACKS_API}/extended/v1/address/${address}/stx`);
  return Number(d.balance ?? 0);
}

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

// Fetch user's bin positions and uncollected fees for a given pool
async function getUserBins(address: string, poolId: string): Promise<{
  bins: { binId: number; liquidity: number; feesX: number; feesY: number }[];
  totalFeesX: number;
  totalFeesY: number;
}> {
  const resp = await fetchJson(`${HODLMM_API}/app/v1/users/${address}/positions/${poolId}/bins`);
  const rawBins = resp?.bins ?? resp?.position_bins ?? [];
  const bins = (Array.isArray(rawBins) ? rawBins : [])
    .filter((b: any) => (b.user_liquidity ?? 0) > 0)
    .map((b: any) => ({
      binId: b.bin_id ?? b.binId,
      liquidity: Number(b.user_liquidity ?? 0),
      feesX: Number(b.fees_x ?? b.uncollected_fees_x ?? b.pending_fees_x ?? 0),
      feesY: Number(b.fees_y ?? b.uncollected_fees_y ?? b.pending_fees_y ?? 0),
    }));

  const totalFeesX = bins.reduce((sum, b) => sum + b.feesX, 0);
  const totalFeesY = bins.reduce((sum, b) => sum + b.feesY, 0);

  return { bins, totalFeesX, totalFeesY };
}

// ─── MCP Command Builders ────────────────────────────────────────────────────

function buildClaimCommand(poolId: string, binIds: number[], estimatedFees: number): McpCommand {
  return {
    step: 1,
    tool: "bitflow_hodlmm_claim_fees",
    description: `Claim ~${estimatedFees} sats fees from ${poolId} bins [${binIds[0]}..${binIds[binIds.length - 1]}]`,
    params: {
      poolId,
      binIds,
    },
  };
}

function buildRedepositCommand(poolId: string, activeBinId: number, binRange: number): McpCommand {
  return {
    step: 2,
    tool: "bitflow_hodlmm_add_liquidity",
    description: `Redeposit claimed fees into ${poolId} at active bin ${activeBinId} ±${binRange}`,
    params: {
      poolId,
      targetBinId: activeBinId,
      binRange,
    },
  };
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
    checks["hodlmm_active_bin"] = `ok (dlmm_6 active_bin: ${activeBin})`;
  } catch (e: any) { checks["hodlmm_active_bin"] = `fail: ${e.message}`; }

  // Verify fee-claim endpoint is accessible
  try {
    await fetchJson(`${HODLMM_API}/app/v1/pools`);
    checks["fee_claim_ready"] = "ok";
  } catch (e: any) { checks["fee_claim_ready"] = `fail: ${e.message}`; }

  const allOk = Object.values(checks).every(v => v.startsWith("ok"));
  out({
    status: allOk ? "success" : "degraded",
    action: "doctor",
    data: {
      checks,
      guardrails: {
        min_compound_sats: MIN_COMPOUND_SATS,
        max_compound_sats: MAX_COMPOUND_SATS,
        min_stx_reserve: MIN_STX_RESERVE / 1e6,
        max_bin_range: MAX_BIN_RANGE,
        max_daily_compounds: MAX_DAILY_COMPOUNDS,
        compound_cooldown_min: MIN_COMPOUND_INTERVAL_MS / 60_000,
      },
    },
    error: null,
  });
}

async function cmdScan(address: string): Promise<void> {
  if (!address?.startsWith("SP") && !address?.startsWith("SM")) {
    errOut("BAD_ADDRESS", "Need a valid Stacks address (SP.../SM...)", "--address SP...");
    return;
  }

  const poolIds = Object.keys(DLMM_CONTRACTS);
  const positions: any[] = [];
  let totalClaimable = 0;

  for (const poolId of poolIds) {
    try {
      const { bins, totalFeesX, totalFeesY } = await getUserBins(address, poolId);
      if (bins.length === 0) continue;

      const activeBin = await getActiveBinOnChain(poolId);
      const inRange = bins.some(b => Math.abs(b.binId - activeBin) <= MAX_BIN_RANGE);
      const claimableSats = totalFeesX + totalFeesY;
      totalClaimable += claimableSats;

      positions.push({
        poolId,
        bins: bins.length,
        binRange: `${bins[0].binId}..${bins[bins.length - 1].binId}`,
        activeBin,
        inRange,
        feesX: totalFeesX,
        feesY: totalFeesY,
        totalClaimable: claimableSats,
        compoundable: claimableSats >= MIN_COMPOUND_SATS,
      });
    } catch {}
  }

  const compoundable = positions.filter(p => p.compoundable);

  out({
    status: "success",
    action: "scan",
    data: {
      address,
      positions,
      summary: {
        total_pools_with_position: positions.length,
        total_claimable_sats: totalClaimable,
        compoundable_pools: compoundable.length,
        recommendation: compoundable.length > 0
          ? `${compoundable.length} pool(s) ready to compound. Run 'compound --pool ${compoundable[0].poolId} --confirm' to execute.`
          : totalClaimable > 0
            ? `Fees accruing (${totalClaimable} sats) but below ${MIN_COMPOUND_SATS}-sat minimum. Wait for more accumulation.`
            : "No positions found. Use hodlmm-dca-executor to open a position first.",
      },
    },
    error: null,
  });
}

async function cmdCompound(address: string, poolId: string, minSats: number, confirm: boolean): Promise<void> {
  if (!address?.startsWith("SP") && !address?.startsWith("SM")) {
    errOut("BAD_ADDRESS", "Need a valid Stacks address (SP.../SM...)", "--address SP...");
    return;
  }

  if (!DLMM_CONTRACTS[poolId]) {
    errOut("BAD_POOL", `Unknown pool '${poolId}'. Valid: ${Object.keys(DLMM_CONTRACTS).join(", ")}`, "--pool dlmm_6");
    return;
  }

  // Pre-flight: verify Stacks API reachable (longer timeout for write ops)
  try {
    const resp = await fetch(`${STACKS_API}/v2/info`, { signal: AbortSignal.timeout(20_000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  } catch {
    errOut("API_DOWN", "Stacks API unreachable — refusing to execute", "Run 'doctor' to diagnose");
    return;
  }

  // Rate limits
  const state = loadState();
  if (state.dailyCompoundCount >= MAX_DAILY_COMPOUNDS) {
    errOut("DAILY_LIMIT", `Daily compound limit reached (${MAX_DAILY_COMPOUNDS})`, "Wait until tomorrow");
    return;
  }

  const elapsed = Date.now() - (state.lastCompoundTime || 0);
  if (elapsed < MIN_COMPOUND_INTERVAL_MS) {
    const waitMin = Math.ceil((MIN_COMPOUND_INTERVAL_MS - elapsed) / 60_000);
    errOut("COOLDOWN", `Cooldown active, wait ${waitMin} minutes`, `Next compound available in ${waitMin}m`);
    return;
  }

  // Gas check
  const stxBal = await getStxBalance(address);
  if (stxBal < MIN_STX_RESERVE) {
    errOut("GAS_LOW", `STX balance ${(stxBal / 1e6).toFixed(2)} below ${MIN_STX_RESERVE / 1e6} reserve`, "Fund wallet with STX for gas");
    return;
  }

  // Fetch position and fees
  let bins: { binId: number; liquidity: number; feesX: number; feesY: number }[];
  let totalFeesX: number, totalFeesY: number;
  try {
    const result = await getUserBins(address, poolId);
    bins = result.bins;
    totalFeesX = result.totalFeesX;
    totalFeesY = result.totalFeesY;
  } catch {
    errOut("NO_POSITION", `No LP position found in ${poolId}`, "Deposit first via hodlmm-dca-executor");
    return;
  }
  if (bins.length === 0) {
    errOut("NO_POSITION", `No LP position found in ${poolId}`, "Deposit first via hodlmm-dca-executor");
    return;
  }

  const claimableSats = totalFeesX + totalFeesY;
  if (claimableSats < minSats) {
    errOut("DUST_FEES", `Claimable fees ${claimableSats} sats below minimum ${minSats} sats`, "Wait for more fee accrual");
    return;
  }

  // Cap at max
  const compoundAmount = Math.min(claimableSats, MAX_COMPOUND_SATS);

  // Get active bin for redeposit
  const activeBinId = await getActiveBinOnChain(poolId);
  const binIds = bins.map(b => b.binId);

  const commands: McpCommand[] = [
    buildClaimCommand(poolId, binIds, compoundAmount),
    buildRedepositCommand(poolId, activeBinId, MAX_BIN_RANGE),
  ];

  if (!confirm) {
    out({
      status: "success",
      action: "compound_preview",
      data: {
        warning: "DRY RUN — pass --confirm to execute",
        pool: poolId,
        claimable: { feesX: totalFeesX, feesY: totalFeesY, total: claimableSats },
        compound_amount: compoundAmount,
        redeposit: { target_bin: activeBinId, bin_range: MAX_BIN_RANGE },
        bins_with_fees: bins.filter(b => b.feesX > 0 || b.feesY > 0).length,
        commands,
      },
      error: null,
    });
    return;
  }

  // Record compound
  state.totalCompounded += compoundAmount;
  state.compoundCount++;
  state.dailyCompoundCount++;
  state.lastCompoundDate = new Date().toISOString().slice(0, 10);
  state.lastCompoundTime = Date.now();
  state.history.push({
    poolId,
    feesClaimed: claimableSats,
    redeposited: compoundAmount,
    activeBin: activeBinId,
    date: new Date().toISOString(),
  });
  // Keep last 100 records
  if (state.history.length > 100) state.history = state.history.slice(-100);
  saveState(state);

  out({
    status: "success",
    action: "compound",
    data: {
      execute: true,
      pool: poolId,
      fees_claimed: claimableSats,
      compound_amount: compoundAmount,
      redeposit: { target_bin: activeBinId, bin_range: MAX_BIN_RANGE },
      commands,
      next_steps: [
        "Agent: submit MCP commands in order (step 1: claim → step 2: deposit)",
        "After execution: run 'scan --address' to verify fees were claimed",
        `Cooldown: next compound available in ${MIN_COMPOUND_INTERVAL_MS / 60_000} minutes`,
      ],
      limits: {
        daily_remaining: MAX_DAILY_COMPOUNDS - state.dailyCompoundCount,
        total_compounded_sats: state.totalCompounded,
      },
    },
    error: null,
  });
}

async function cmdHistory(address: string): Promise<void> {
  if (!address?.startsWith("SP") && !address?.startsWith("SM")) {
    errOut("BAD_ADDRESS", "Need a valid Stacks address (SP.../SM...)", "--address SP...");
    return;
  }

  const state = loadState();

  // Aggregate stats
  const byPool: Record<string, { count: number; totalSats: number }> = {};
  for (const h of state.history) {
    if (!byPool[h.poolId]) byPool[h.poolId] = { count: 0, totalSats: 0 };
    byPool[h.poolId].count++;
    byPool[h.poolId].totalSats += h.redeposited;
  }

  const last5 = state.history.slice(-5).reverse();

  out({
    status: "success",
    action: "history",
    data: {
      address,
      totals: {
        compound_count: state.compoundCount,
        total_compounded_sats: state.totalCompounded,
        total_compounded_btc: (state.totalCompounded / 1e8).toFixed(8),
      },
      by_pool: byPool,
      recent: last5.map(h => ({
        pool: h.poolId,
        claimed: h.feesClaimed,
        redeposited: h.redeposited,
        bin: h.activeBin,
        date: h.date,
      })),
      today: {
        compounds: state.dailyCompoundCount,
        remaining: MAX_DAILY_COMPOUNDS - state.dailyCompoundCount,
      },
    },
    error: null,
  });
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

const program = new Command();
program.name("hodlmm-auto-compounder").description("Claim HODLMM LP fees and redeposit for compound yield").version("1.0.0");

program.command("doctor").description("Check API connectivity and readiness").action(async () => {
  try { await cmdDoctor(); } catch (e: any) { errOut("DOCTOR_FAIL", e.message, "Check network"); }
});

program.command("scan").description("Scan all pools for uncollected fees")
  .requiredOption("--address <address>", "Stacks address (SP...)")
  .action(async (opts) => {
    try { await cmdScan(opts.address); } catch (e: any) { errOut("SCAN_FAIL", e.message, "Retry"); }
  });

program.command("compound").description("Claim fees and redeposit into active bin")
  .requiredOption("--address <address>", "Stacks address (SP...)")
  .option("--pool <id>", "HODLMM pool ID", "dlmm_6")
  .option("--min-sats <sats>", "Minimum sats to compound", parseInt, MIN_COMPOUND_SATS)
  .option("--confirm", "Execute (default: dry run)", false)
  .action(async (opts) => {
    try { await cmdCompound(opts.address, opts.pool, opts.minSats, opts.confirm); } catch (e: any) { errOut("COMPOUND_FAIL", e.message, "Retry"); }
  });

program.command("history").description("Show compounding history and stats")
  .requiredOption("--address <address>", "Stacks address (SP...)")
  .action(async (opts) => {
    try { await cmdHistory(opts.address); } catch (e: any) { errOut("HISTORY_FAIL", e.message, "Retry"); }
  });

program.parse();

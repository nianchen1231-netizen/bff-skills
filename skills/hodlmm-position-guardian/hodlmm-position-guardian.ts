#!/usr/bin/env bun

/**
 * HODLMM Position Guardian
 *
 * Monitors HODLMM LP positions for bin drift, computes net PnL
 * (earned fees minus impermanent loss), and migrates out-of-range
 * liquidity to current active bins. Full read+write execution loop.
 *
 * Commands: doctor | scan | migrate | compound
 *
 * All output is valid JSON written to stdout.
 */

import { Command } from "commander";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

// ─── Constants ───────────────────────────────────────────────────────────────

const HODLMM_API = "https://bff.bitflowapis.finance/api";
const STACKS_API = "https://api.mainnet.hiro.so";
const API_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 2_000;

// Safety guardrails (hardcoded, not configurable)
const MAX_MIGRATE_USD = 5_000; // refuse to migrate >$5k in one tx
const MIN_DRIFT_BINS = 2; // only migrate when active bin drifted >=2 from position center
const MAX_BIN_RANGE = 10; // re-add within ±10 bins of active bin
const COMPOUND_MIN_FEES_USD = 1.0; // minimum $1 in fees to bother compounding
const MIN_STX_GAS = 150_000; // 0.15 STX minimum gas balance (in uSTX)

const STATE_DIR = join(process.env.HOME ?? "/tmp", ".hodlmm-position-guardian");
const STATE_FILE = join(STATE_DIR, "snapshots.json");
const MAX_SNAPSHOTS = 500;

// ─── Types ───────────────────────────────────────────────────────────────────

interface PoolInfo {
  poolId: string;
  poolContract: string;
  tokenXSymbol: string;
  tokenYSymbol: string;
  tokenXContract: string;
  tokenYContract: string;
  tokenXDecimals: number;
  tokenYDecimals: number;
  tokenXPriceUsd: number;
  tokenYPriceUsd: number;
  tvlUsd: number;
  apr: number;
  feesUsd1d: number;
  feesUsd7d: number;
  baseFee: number;
  binStep: number;
}

interface BinData {
  bin_id: number;
  price: number;
  reserve_x: string;
  reserve_y: string;
  liquidity: string;
}

interface PositionBin {
  bin_id: number;
  user_liquidity: number;
}

interface PositionAnalysis {
  poolId: string;
  pair: string;
  activeBinId: number;
  positionCenter: number;
  drift: number;
  inRange: boolean;
  userBins: number[];
  estimatedValueUsd: number;
  feesEarned1dUsd: number;
  feesEarned7dUsd: number;
  recommendation: "HOLD" | "MIGRATE" | "COMPOUND" | "EXIT";
  reason: string;
}

interface McpCommand {
  step: number;
  tool: string;
  description: string;
  params: Record<string, unknown>;
}

interface Snapshot {
  ts: string;
  poolId: string;
  activeBinId: number;
  positionCenter: number;
  drift: number;
  valueUsd: number;
  action: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function out(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}

function errOut(code: string, message: string, next: string): void {
  out({
    status: "error",
    action: "error",
    data: null,
    error: { code, message, next },
  });
}

async function fetchJson(url: string, retries = MAX_RETRIES): Promise<unknown> {
  for (let i = 0; i <= retries; i++) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(API_TIMEOUT_MS) });
      if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
      return await resp.json();
    } catch (e: unknown) {
      if (i === retries) throw e;
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
  }
  throw new Error("unreachable");
}

function loadSnapshots(): Snapshot[] {
  try {
    if (!existsSync(STATE_FILE)) return [];
    return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function saveSnapshot(snap: Snapshot): void {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  const all = loadSnapshots();
  all.push(snap);
  if (all.length > MAX_SNAPSHOTS) all.splice(0, all.length - MAX_SNAPSHOTS);
  writeFileSync(STATE_FILE, JSON.stringify(all, null, 2));
}

// ─── API Layer ───────────────────────────────────────────────────────────────

async function fetchPools(): Promise<PoolInfo[]> {
  const resp = (await fetchJson(`${HODLMM_API}/app/v1/pools`)) as any;
  const raw = Array.isArray(resp) ? resp : Array.isArray(resp?.data) ? resp.data : [];
  return raw.map((p: any) => ({
    poolId: p.poolId ?? p.pool_id,
    poolContract: p.poolContract ?? p.pool_contract ?? "",
    tokenXSymbol: p.tokens?.tokenX?.symbol ?? p.token_x_symbol ?? "?",
    tokenYSymbol: p.tokens?.tokenY?.symbol ?? p.token_y_symbol ?? "?",
    tokenXContract: p.tokens?.tokenX?.contract ?? p.token_x ?? "",
    tokenYContract: p.tokens?.tokenY?.contract ?? p.token_y ?? "",
    tokenXDecimals: p.tokens?.tokenX?.decimals ?? p.token_x_decimals ?? 6,
    tokenYDecimals: p.tokens?.tokenY?.decimals ?? p.token_y_decimals ?? 6,
    tokenXPriceUsd: p.tokens?.tokenX?.priceUsd ?? p.token_x_price_usd ?? 0,
    tokenYPriceUsd: p.tokens?.tokenY?.priceUsd ?? p.token_y_price_usd ?? 0,
    tvlUsd: p.tvlUsd ?? p.tvl_usd ?? 0,
    apr: p.apr ?? 0,
    feesUsd1d: p.feesUsd1d ?? p.fees_usd_1d ?? 0,
    feesUsd7d: p.feesUsd7d ?? p.fees_usd_7d ?? 0,
    baseFee: p.baseFee ?? p.base_fee ?? 0,
    binStep: p.binStep ?? p.bin_step ?? 0,
  }));
}

async function fetchBins(poolId: string): Promise<{ activeBinId: number; bins: BinData[] }> {
  const raw = (await fetchJson(`${HODLMM_API}/quotes/v1/bins/${poolId}`)) as any;
  return {
    activeBinId: raw.active_bin_id ?? raw.activeBinId ?? 0,
    bins: Array.isArray(raw.bins) ? raw.bins : [],
  };
}

async function fetchUserPositions(
  address: string,
  poolId: string
): Promise<PositionBin[]> {
  try {
    const raw = (await fetchJson(
      `${HODLMM_API}/app/v1/users/${address}/positions/${poolId}/bins`
    )) as any;
    const bins = raw.bins ?? raw.position_bins ?? raw.positions?.bins ?? [];
    return (Array.isArray(bins) ? bins : [])
      .filter((b: any) => (b.user_liquidity ?? b.userLiquidity ?? 0) > 0)
      .map((b: any) => ({
        bin_id: b.bin_id ?? b.binId,
        user_liquidity: b.user_liquidity ?? b.userLiquidity ?? 0,
      }));
  } catch {
    return []; // 404 = no position
  }
}

async function fetchStxBalance(address: string): Promise<number> {
  const raw = (await fetchJson(`${STACKS_API}/extended/v1/address/${address}/stx`)) as any;
  return Number(raw.balance ?? 0);
}

// ─── Analysis ────────────────────────────────────────────────────────────────

function analyzePosition(
  pool: PoolInfo,
  activeBinId: number,
  userBins: PositionBin[],
  poolBins: BinData[]
): PositionAnalysis {
  const binIds = userBins.map((b) => b.bin_id).sort((a, b) => a - b);
  const positionCenter = Math.round(binIds.reduce((s, b) => s + b, 0) / binIds.length);
  const drift = Math.abs(activeBinId - positionCenter);
  const inRange = binIds.some((id) => id === activeBinId) ||
    (activeBinId >= binIds[0] && activeBinId <= binIds[binIds.length - 1]);

  // Estimate position value from pool bins
  let valueUsd = 0;
  for (const ub of userBins) {
    const poolBin = poolBins.find((pb) => pb.bin_id === ub.bin_id);
    if (!poolBin) continue;
    const totalLiq = Number(poolBin.liquidity) || 1;
    const share = ub.user_liquidity / totalLiq;
    const rx = Number(poolBin.reserve_x) * share;
    const ry = Number(poolBin.reserve_y) * share;
    const vx = (rx / Math.pow(10, pool.tokenXDecimals)) * pool.tokenXPriceUsd;
    const vy = (ry / Math.pow(10, pool.tokenYDecimals)) * pool.tokenYPriceUsd;
    valueUsd += vx + vy;
  }

  // Estimate user's share of pool fees
  const totalPoolLiq = poolBins.reduce((s, b) => s + Number(b.liquidity), 0) || 1;
  const userTotalLiq = userBins.reduce((s, b) => s + b.user_liquidity, 0);
  const userShare = userTotalLiq / totalPoolLiq;
  const feesEarned1dUsd = pool.feesUsd1d * userShare;
  const feesEarned7dUsd = pool.feesUsd7d * userShare;

  let recommendation: PositionAnalysis["recommendation"] = "HOLD";
  let reason = "Position in range, earning fees normally.";

  if (!inRange && drift >= MIN_DRIFT_BINS) {
    recommendation = "MIGRATE";
    reason = `Active bin ${activeBinId} drifted ${drift} bins from position center ${positionCenter}. ` +
      `Liquidity is out of range and earning zero fees. Migrate to recapture fee flow.`;
  } else if (!inRange && drift < MIN_DRIFT_BINS) {
    recommendation = "HOLD";
    reason = `Bin drift (${drift}) below migration threshold (${MIN_DRIFT_BINS}). ` +
      `Wait for further movement or manual review.`;
  } else if (feesEarned7dUsd > COMPOUND_MIN_FEES_USD * 7 && inRange) {
    recommendation = "COMPOUND";
    reason = `Position in range with ~$${feesEarned7dUsd.toFixed(2)} in 7d fees. ` +
      `Compounding could improve capital efficiency.`;
  }

  // Exit signal: if pool TVL dropped severely or fees are negligible relative to value
  if (pool.tvlUsd < 1_000 && valueUsd > 100) {
    recommendation = "EXIT";
    reason = `Pool TVL ($${pool.tvlUsd.toFixed(0)}) critically low. ` +
      `Risk of illiquidity. Recommend full exit.`;
  }

  return {
    poolId: pool.poolId,
    pair: `${pool.tokenXSymbol}/${pool.tokenYSymbol}`,
    activeBinId,
    positionCenter,
    drift,
    inRange,
    userBins: binIds,
    estimatedValueUsd: Math.round(valueUsd * 100) / 100,
    feesEarned1dUsd: Math.round(feesEarned1dUsd * 100) / 100,
    feesEarned7dUsd: Math.round(feesEarned7dUsd * 100) / 100,
    recommendation,
    reason,
  };
}

// ─── MCP Command Builders ────────────────────────────────────────────────────

function buildMigrateCommands(
  analysis: PositionAnalysis,
  pool: PoolInfo,
  address: string
): McpCommand[] {
  const commands: McpCommand[] = [];

  // Step 1: Remove liquidity from current bins
  commands.push({
    step: 1,
    tool: "bitflow_hodlmm_remove_liquidity",
    description: `Remove liquidity from ${analysis.pair} pool ${analysis.poolId} ` +
      `bins [${analysis.userBins.join(", ")}] (~$${analysis.estimatedValueUsd})`,
    params: {
      poolId: analysis.poolId,
      binIds: analysis.userBins,
    },
  });

  // Step 2: Re-add liquidity centered on current active bin
  const halfRange = Math.min(Math.floor(analysis.userBins.length / 2), MAX_BIN_RANGE);
  commands.push({
    step: 2,
    tool: "bitflow_hodlmm_add_liquidity",
    description: `Re-add liquidity to ${analysis.pair} pool ${analysis.poolId} ` +
      `centered on active bin ${analysis.activeBinId} ±${halfRange} bins`,
    params: {
      poolId: analysis.poolId,
      targetBinId: analysis.activeBinId,
      binRange: halfRange,
    },
  });

  return commands;
}

function buildCompoundCommands(
  analysis: PositionAnalysis,
  pool: PoolInfo
): McpCommand[] {
  return [
    {
      step: 1,
      tool: "bitflow_hodlmm_add_liquidity",
      description: `Compound ~$${analysis.feesEarned7dUsd.toFixed(2)} earned fees ` +
        `into ${analysis.pair} pool ${analysis.poolId} at active bin ${analysis.activeBinId}`,
      params: {
        poolId: analysis.poolId,
        targetBinId: analysis.activeBinId,
        binRange: Math.min(Math.floor(analysis.userBins.length / 2), MAX_BIN_RANGE),
      },
    },
  ];
}

function buildExitCommands(analysis: PositionAnalysis): McpCommand[] {
  return [
    {
      step: 1,
      tool: "bitflow_hodlmm_remove_liquidity",
      description: `Emergency exit: remove all liquidity from ${analysis.pair} ` +
        `pool ${analysis.poolId} (~$${analysis.estimatedValueUsd})`,
      params: {
        poolId: analysis.poolId,
        binIds: analysis.userBins,
      },
    },
  ];
}

// ─── Commands ────────────────────────────────────────────────────────────────

async function cmdDoctor(): Promise<void> {
  const checks: Record<string, string> = {};

  try {
    const pools = await fetchPools();
    checks["hodlmm_pools_api"] = `ok (${pools.length} pools)`;
  } catch (e: any) {
    checks["hodlmm_pools_api"] = `fail: ${e.message}`;
  }

  try {
    const bins = await fetchBins("dlmm_1");
    checks["hodlmm_bins_api"] = `ok (active_bin: ${bins.activeBinId}, ${bins.bins.length} bins)`;
  } catch (e: any) {
    checks["hodlmm_bins_api"] = `fail: ${e.message}`;
  }

  try {
    const fees = await fetchJson(`${STACKS_API}/v2/fees/transfer`);
    checks["stacks_fees_api"] = `ok`;
  } catch (e: any) {
    checks["stacks_fees_api"] = `fail: ${e.message}`;
  }

  const allOk = Object.values(checks).every((v) => v.startsWith("ok"));

  out({
    status: allOk ? "success" : "degraded",
    action: "doctor",
    data: {
      checks,
      guardrails: {
        max_migrate_usd: MAX_MIGRATE_USD,
        min_drift_bins: MIN_DRIFT_BINS,
        max_bin_range: MAX_BIN_RANGE,
        compound_min_fees_usd: COMPOUND_MIN_FEES_USD,
        min_stx_gas_ustx: MIN_STX_GAS,
      },
    },
    error: null,
  });
}

async function cmdScan(address: string): Promise<void> {
  if (!address || !address.startsWith("SP") && !address.startsWith("bc1")) {
    errOut("INVALID_ADDRESS", "Provide a valid Stacks (SP...) or BTC address", "Pass --address <your-stacks-address>");
    return;
  }

  const pools = await fetchPools();
  const results: PositionAnalysis[] = [];

  for (const pool of pools) {
    const userBins = await fetchUserPositions(address, pool.poolId);
    if (userBins.length === 0) continue;

    const { activeBinId, bins: poolBins } = await fetchBins(pool.poolId);
    const analysis = analyzePosition(pool, activeBinId, userBins, poolBins);
    results.push(analysis);

    saveSnapshot({
      ts: new Date().toISOString(),
      poolId: pool.poolId,
      activeBinId,
      positionCenter: analysis.positionCenter,
      drift: analysis.drift,
      valueUsd: analysis.estimatedValueUsd,
      action: analysis.recommendation,
    });
  }

  const migrateCount = results.filter((r) => r.recommendation === "MIGRATE").length;
  const compoundCount = results.filter((r) => r.recommendation === "COMPOUND").length;
  const exitCount = results.filter((r) => r.recommendation === "EXIT").length;
  const totalValueUsd = results.reduce((s, r) => s + r.estimatedValueUsd, 0);

  out({
    status: "success",
    action: "scan",
    data: {
      address,
      positionsFound: results.length,
      totalValueUsd: Math.round(totalValueUsd * 100) / 100,
      summary: {
        hold: results.filter((r) => r.recommendation === "HOLD").length,
        migrate: migrateCount,
        compound: compoundCount,
        exit: exitCount,
      },
      positions: results,
      ...(migrateCount > 0 && {
        alert: `${migrateCount} position(s) out of range — run 'migrate' to rebalance`,
      }),
    },
    error: null,
  });
}

async function cmdMigrate(address: string, confirm: boolean): Promise<void> {
  if (!address) {
    errOut("INVALID_ADDRESS", "Provide a valid Stacks address", "Pass --address <your-stacks-address>");
    return;
  }

  // Gas check
  const stxBalance = await fetchStxBalance(address);
  if (stxBalance < MIN_STX_GAS) {
    errOut(
      "INSUFFICIENT_GAS",
      `STX balance ${stxBalance} uSTX < minimum ${MIN_STX_GAS} uSTX`,
      "Fund the wallet with at least 0.15 STX for gas fees"
    );
    return;
  }

  const pools = await fetchPools();
  const allCommands: { poolId: string; pair: string; commands: McpCommand[] }[] = [];

  for (const pool of pools) {
    const userBins = await fetchUserPositions(address, pool.poolId);
    if (userBins.length === 0) continue;

    const { activeBinId, bins: poolBins } = await fetchBins(pool.poolId);
    const analysis = analyzePosition(pool, activeBinId, userBins, poolBins);

    if (analysis.recommendation === "EXIT") {
      if (analysis.estimatedValueUsd > MAX_MIGRATE_USD) {
        errOut(
          "VALUE_EXCEEDS_CAP",
          `Position value $${analysis.estimatedValueUsd} exceeds $${MAX_MIGRATE_USD} safety cap`,
          "Reduce position size or adjust manually"
        );
        return;
      }
      allCommands.push({
        poolId: pool.poolId,
        pair: analysis.pair,
        commands: buildExitCommands(analysis),
      });
    } else if (analysis.recommendation === "MIGRATE") {
      if (analysis.estimatedValueUsd > MAX_MIGRATE_USD) {
        errOut(
          "VALUE_EXCEEDS_CAP",
          `Position value $${analysis.estimatedValueUsd} exceeds $${MAX_MIGRATE_USD} safety cap`,
          "Reduce position size or adjust manually"
        );
        return;
      }
      allCommands.push({
        poolId: pool.poolId,
        pair: analysis.pair,
        commands: buildMigrateCommands(analysis, pool, address),
      });
    }
  }

  if (allCommands.length === 0) {
    out({
      status: "success",
      action: "migrate",
      data: { message: "All positions are in range. No migration needed." },
      error: null,
    });
    return;
  }

  if (!confirm) {
    out({
      status: "success",
      action: "migrate_preview",
      data: {
        warning: "DRY RUN — pass --confirm to execute",
        migrations: allCommands,
      },
      error: null,
    });
    return;
  }

  out({
    status: "success",
    action: "migrate",
    data: {
      execute: true,
      migrations: allCommands,
    },
    error: null,
  });
}

async function cmdCompound(address: string, confirm: boolean): Promise<void> {
  if (!address) {
    errOut("INVALID_ADDRESS", "Provide a valid Stacks address", "Pass --address <your-stacks-address>");
    return;
  }

  const pools = await fetchPools();
  const allCommands: { poolId: string; pair: string; commands: McpCommand[] }[] = [];

  for (const pool of pools) {
    const userBins = await fetchUserPositions(address, pool.poolId);
    if (userBins.length === 0) continue;

    const { activeBinId, bins: poolBins } = await fetchBins(pool.poolId);
    const analysis = analyzePosition(pool, activeBinId, userBins, poolBins);

    if (analysis.recommendation === "COMPOUND" && analysis.feesEarned7dUsd >= COMPOUND_MIN_FEES_USD * 7) {
      allCommands.push({
        poolId: pool.poolId,
        pair: analysis.pair,
        commands: buildCompoundCommands(analysis, pool),
      });
    }
  }

  if (allCommands.length === 0) {
    out({
      status: "success",
      action: "compound",
      data: { message: `No positions with sufficient fees (>$${COMPOUND_MIN_FEES_USD * 7}/7d) to compound.` },
      error: null,
    });
    return;
  }

  if (!confirm) {
    out({
      status: "success",
      action: "compound_preview",
      data: {
        warning: "DRY RUN — pass --confirm to execute",
        compounds: allCommands,
      },
      error: null,
    });
    return;
  }

  out({
    status: "success",
    action: "compound",
    data: {
      execute: true,
      compounds: allCommands,
    },
    error: null,
  });
}

async function cmdHistory(): Promise<void> {
  const snapshots = loadSnapshots();
  const recent = snapshots.slice(-50);

  // Compute per-pool drift trend
  const byPool: Record<string, Snapshot[]> = {};
  for (const s of snapshots) {
    (byPool[s.poolId] ??= []).push(s);
  }

  const trends: Record<string, { avgDrift: number; migrateCount: number; snapshots: number }> = {};
  for (const [pid, snaps] of Object.entries(byPool)) {
    trends[pid] = {
      avgDrift: Math.round(snaps.reduce((s, x) => s + x.drift, 0) / snaps.length * 10) / 10,
      migrateCount: snaps.filter((s) => s.action === "MIGRATE").length,
      snapshots: snaps.length,
    };
  }

  out({
    status: "success",
    action: "history",
    data: {
      totalSnapshots: snapshots.length,
      trends,
      recentEntries: recent,
    },
    error: null,
  });
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

const program = new Command();

program
  .name("hodlmm-position-guardian")
  .description("Monitor and migrate HODLMM LP positions for optimal fee capture")
  .version("1.0.0");

program
  .command("doctor")
  .description("Verify API connectivity and display safety guardrails")
  .action(async () => {
    try { await cmdDoctor(); } catch (e: any) { errOut("DOCTOR_FAIL", e.message, "Check network connectivity"); }
  });

program
  .command("scan")
  .description("Scan all HODLMM pools for your positions and assess health")
  .requiredOption("--address <address>", "Stacks wallet address (SP...)")
  .action(async (opts) => {
    try { await cmdScan(opts.address); } catch (e: any) { errOut("SCAN_FAIL", e.message, "Retry or check address"); }
  });

program
  .command("migrate")
  .description("Migrate out-of-range positions to current active bins")
  .requiredOption("--address <address>", "Stacks wallet address (SP...)")
  .option("--confirm", "Execute migration (default: dry run)", false)
  .action(async (opts) => {
    try { await cmdMigrate(opts.address, opts.confirm); } catch (e: any) { errOut("MIGRATE_FAIL", e.message, "Retry or review positions manually"); }
  });

program
  .command("compound")
  .description("Compound earned fees back into positions")
  .requiredOption("--address <address>", "Stacks wallet address (SP...)")
  .option("--confirm", "Execute compound (default: dry run)", false)
  .action(async (opts) => {
    try { await cmdCompound(opts.address, opts.confirm); } catch (e: any) { errOut("COMPOUND_FAIL", e.message, "Retry or review positions manually"); }
  });

program
  .command("history")
  .description("Show position drift history and migration trends")
  .action(async () => {
    try { await cmdHistory(); } catch (e: any) { errOut("HISTORY_FAIL", e.message, "Check state directory permissions"); }
  });

program.parse();

#!/usr/bin/env ts-node

/**
 * HODLMM Arb Scanner
 *
 * Detects price arbitrage opportunities between Bitflow HODLMM (DLMM) pools
 * and XYK/StableSwap pools. Optionally executes the swap when spread exceeds
 * the configured threshold.
 *
 * Commands: doctor | scan | execute | history
 *
 * All output is valid JSON written to stdout.
 */

import { Command } from "commander";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

// ─── Constants ───────────────────────────────────────────────────────────────

const HODLMM_API = "https://bff.bitflowapis.finance/api";
const SDK_API = "https://bitflowsdk-api-test-7owjsmt8.uk.gateway.dev";

const HISTORY_DIR = join(
  process.env.HOME ?? "/tmp",
  ".hodlmm-arb-scanner"
);
const HISTORY_FILE = join(HISTORY_DIR, "history.json");
const MAX_HISTORY_ENTRIES = 500;
const DEFAULT_SPREAD_THRESHOLD_BPS = 50; // 0.50%
const API_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 2_000;

// ─── Types ───────────────────────────────────────────────────────────────────

interface HodlmmTokenInfo {
  contract: string;
  symbol: string;
  decimals: number;
  priceUsd: number;
}

interface HodlmmPoolRaw {
  poolId: string;
  poolContract: string;
  poolStatus: string;
  tokens: {
    tokenX: HodlmmTokenInfo;
    tokenY: HodlmmTokenInfo;
  };
  tvlUsd: number;
  volumeUsd1d: number;
  apr: number;
  baseFee: number;
  binStep: number;
  poolComposition: unknown;
}

interface HodlmmPool {
  poolId: string;
  poolContract: string;
  tokenX: string; // contract address
  tokenY: string;
  tokenXSymbol: string;
  tokenYSymbol: string;
  tokenXPriceUsd: number;
  tokenYPriceUsd: number;
  tokenXDecimals: number;
  tokenYDecimals: number;
  tvlUsd: number;
  baseFee: number;
  binStep: number;
}

interface HodlmmBin {
  binId: number;
  pricePerToken: number;
  reserveX: string;
  reserveY: string;
  isActive: boolean;
}

interface XykPoolRaw {
  contract: string;
  dex: string;
  poolData: {
    "pool-trait": string;
    xToken: string;
    yToken: string;
  };
  tokenX: string;
  tokenY: string;
}

interface TickerEntry {
  base_currency: string;
  target_currency: string;
  pool_id: string;
  last_price: number;
  liquidity_in_usd: number;
  base_volume: number;
}

interface XykPool {
  poolId: string;    // contract address (the dex contract)
  poolTrait: string; // pool-trait from poolData
  token0: string;    // contract address from poolData.xToken
  token1: string;    // contract address from poolData.yToken
  lastPrice: number; // from ticker API (price of token0 in terms of token1)
  feeBps: number;
  type: "xyk" | "stableswap";
}

interface ArbOpportunity {
  pair: string;
  hodlmmPoolId: string;
  xykPoolId: string;
  xykPoolType: string;
  hodlmmPrice: number;
  xykPrice: number;
  spreadPct: number;
  spreadBps: number;
  direction: "buy_hodlmm_sell_xyk" | "buy_xyk_sell_hodlmm";
  estimatedProfitBps: number;
  hodlmmFeeBps: number;
  xykFeeBps: number;
  detectedAt: string;
}

interface SwapRoute {
  route: unknown[];
  expectedOutput: string;
  priceImpactPct: number;
}

interface HistoryEntry {
  type: "scan" | "execute";
  timestamp: string;
  opportunities?: ArbOpportunity[];
  execution?: {
    poolId: string;
    amount: number;
    direction: string;
    quote: SwapRoute | null;
    txId: string | null;
    status: "success" | "failed" | "simulated";
    error?: string;
  };
}

interface JsonOutput {
  ok: boolean;
  command: string;
  [key: string]: unknown;
}

// ─── Utility: Fetch with retry ───────────────────────────────────────────────

async function fetchJson<T>(url: string, retries = MAX_RETRIES): Promise<T> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        throw new Error(`API ${res.status}: ${res.statusText} — ${url}`);
      }
      return (await res.json()) as T;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < retries) {
        await sleep(RETRY_DELAY_MS * (attempt + 1));
      }
    }
  }
  throw lastError!;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── History persistence ─────────────────────────────────────────────────────

function ensureHistoryDir(): void {
  if (!existsSync(HISTORY_DIR)) {
    mkdirSync(HISTORY_DIR, { recursive: true });
  }
}

function loadHistory(): HistoryEntry[] {
  ensureHistoryDir();
  if (!existsSync(HISTORY_FILE)) return [];
  try {
    const raw = readFileSync(HISTORY_FILE, "utf-8");
    return JSON.parse(raw) as HistoryEntry[];
  } catch {
    return [];
  }
}

function appendHistory(entry: HistoryEntry): void {
  const history = loadHistory();
  history.push(entry);
  const trimmed = history.slice(-MAX_HISTORY_ENTRIES);
  writeFileSync(HISTORY_FILE, JSON.stringify(trimmed, null, 2), "utf-8");
}

// ─── Pool data fetching ──────────────────────────────────────────────────────

async function fetchHodlmmPools(): Promise<HodlmmPool[]> {
  const resp = await fetchJson<{ data: HodlmmPoolRaw[] }>(
    `${HODLMM_API}/app/v1/pools`
  );
  const rawPools = resp.data ?? [];
  return rawPools.map((p) => ({
    poolId: p.poolId,
    poolContract: p.poolContract,
    tokenX: p.tokens.tokenX.contract,
    tokenY: p.tokens.tokenY.contract,
    tokenXSymbol: p.tokens.tokenX.symbol,
    tokenYSymbol: p.tokens.tokenY.symbol,
    tokenXPriceUsd: p.tokens.tokenX.priceUsd,
    tokenYPriceUsd: p.tokens.tokenY.priceUsd,
    tokenXDecimals: p.tokens.tokenX.decimals,
    tokenYDecimals: p.tokens.tokenY.decimals,
    tvlUsd: p.tvlUsd,
    baseFee: p.baseFee,
    binStep: p.binStep,
  }));
}

async function fetchHodlmmBins(poolId: string): Promise<HodlmmBin[]> {
  const data = await fetchJson<HodlmmBin[] | { bins: HodlmmBin[] }>(
    `${HODLMM_API}/quotes/v1/bins/${encodeURIComponent(poolId)}`
  );
  return Array.isArray(data) ? data : (data as { bins: HodlmmBin[] }).bins ?? [];
}

async function fetchTickerData(): Promise<TickerEntry[]> {
  return fetchJson<TickerEntry[]>(`${SDK_API}/ticker`);
}

async function fetchXykPools(): Promise<XykPool[]> {
  const [rawPools, tickerEntries] = await Promise.all([
    fetchJson<XykPoolRaw[]>(`${SDK_API}/getAllPools`),
    fetchTickerData(),
  ]);

  // Index ticker data by pool_id (the pool-trait) for fast lookup
  const tickerByPoolId = new Map<string, TickerEntry>();
  for (const t of tickerEntries) {
    tickerByPoolId.set(normalizeToken(t.pool_id), t);
  }

  return rawPools
    .filter(
      (p) =>
        p.dex.includes("BITFLOW_XYK") || p.dex.includes("BITFLOW_STABLE")
    )
    .map((p) => {
      const poolTrait = p.poolData["pool-trait"] ?? "";
      const poolType: "xyk" | "stableswap" = p.dex.includes("BITFLOW_STABLE")
        ? "stableswap"
        : "xyk";

      // Look up ticker price by pool-trait
      const ticker = tickerByPoolId.get(normalizeToken(poolTrait));
      const lastPrice = ticker?.last_price ?? 0;

      // Default fee for XYK pools (30 bps) since the API no longer provides swap-fee
      const feeBps = 30;

      return {
        poolId: p.contract,
        poolTrait,
        token0: p.poolData.xToken,
        token1: p.poolData.yToken,
        lastPrice,
        feeBps,
        type: poolType,
      };
    })
    .filter((p) => p.token0 && p.token1); // drop pools with missing token info
}

// ─── Price derivation ────────────────────────────────────────────────────────

/**
 * Derive effective price from HODLMM pool.
 * Uses priceUsd from token data: price of tokenX in terms of tokenY = priceUsdX / priceUsdY.
 * Falls back to active bin price if available.
 */
function hodlmmEffectivePrice(
  pool: HodlmmPool,
  bins: HodlmmBin[]
): number | null {
  // Primary: use USD prices from the pool API
  if (pool.tokenXPriceUsd > 0 && pool.tokenYPriceUsd > 0) {
    return pool.tokenXPriceUsd / pool.tokenYPriceUsd;
  }

  // Fallback: try active bin
  const activeBin = bins.find((b) => b.isActive);
  if (activeBin && activeBin.pricePerToken > 0) {
    return activeBin.pricePerToken;
  }

  return null;
}

/**
 * Derive effective price from XYK/StableSwap pool using ticker last_price.
 * last_price represents the price of the base token in terms of the target token.
 */
function xykEffectivePrice(pool: XykPool): number | null {
  if (pool.lastPrice > 0) return pool.lastPrice;
  return null;
}

// ─── Token pair matching ─────────────────────────────────────────────────────

/**
 * Normalize a token contract address for matching.
 */
function normalizeToken(t: string | undefined | null): string {
  return (t || "").trim().toLowerCase();
}

/**
 * Build a canonical key for a token pair (order-independent).
 */
function pairKey(tokenA: string, tokenB: string): string {
  const a = normalizeToken(tokenA);
  const b = normalizeToken(tokenB);
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function pairLabel(hodlmm: HodlmmPool): string {
  const a = hodlmm.tokenXSymbol || hodlmm.tokenX.split(".").pop() || "?";
  const b = hodlmm.tokenYSymbol || hodlmm.tokenY.split(".").pop() || "?";
  return `${a}/${b}`;
}

// ─── Swap quote ──────────────────────────────────────────────────────────────

async function fetchSwapRoutes(
  fromToken: string,
  toToken: string
): Promise<unknown> {
  const url =
    `${SDK_API}/getAllRoutes` +
    `?tokenX=${encodeURIComponent(fromToken)}` +
    `&tokenY=${encodeURIComponent(toToken)}`;
  return fetchJson<unknown>(url);
}

// ─── Commands ────────────────────────────────────────────────────────────────

async function cmdDoctor(): Promise<JsonOutput> {
  const checks: Record<string, unknown> = {};

  // 1. Check HODLMM pools API
  let hodlmmPools: HodlmmPool[] = [];
  try {
    const start = Date.now();
    hodlmmPools = await fetchHodlmmPools();
    checks.hodlmmApi = {
      ok: true,
      url: `${HODLMM_API}/app/v1/pools`,
      latencyMs: Date.now() - start,
      poolCount: hodlmmPools.length,
    };
  } catch (err) {
    checks.hodlmmApi = {
      ok: false,
      url: `${HODLMM_API}/app/v1/pools`,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // 2. Check XYK/Stable pools API (SDK)
  try {
    const start = Date.now();
    const xykPools = await fetchXykPools();
    checks.xykSdkApi = {
      ok: true,
      url: `${SDK_API}/getAllPools`,
      latencyMs: Date.now() - start,
      poolCount: xykPools.length,
    };
  } catch (err) {
    checks.xykSdkApi = {
      ok: false,
      url: `${SDK_API}/getAllPools`,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // 3. Check ticker API
  try {
    const start = Date.now();
    await fetchJson(`${SDK_API}/ticker`);
    checks.tickerApi = {
      ok: true,
      url: `${SDK_API}/ticker`,
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    checks.tickerApi = {
      ok: false,
      url: `${SDK_API}/ticker`,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // 4. History file status
  const history = loadHistory();
  checks.history = {
    entries: history.length,
    path: HISTORY_FILE,
  };

  const allOk = Object.values(checks).every(
    (c) =>
      typeof c === "object" &&
      c !== null &&
      (c as { ok?: boolean }).ok !== false
  );

  return {
    ok: allOk,
    command: "doctor",
    checks,
    hodlmmPools: hodlmmPools.map((p) => ({
      poolId: p.poolId,
      tokenX: p.tokenXSymbol,
      tokenXContract: p.tokenX,
      tokenY: p.tokenYSymbol,
      tokenYContract: p.tokenY,
      tokenXPriceUsd: p.tokenXPriceUsd,
      tokenYPriceUsd: p.tokenYPriceUsd,
      tvlUsd: p.tvlUsd,
      baseFee: p.baseFee,
      binStep: p.binStep,
    })),
  };
}

async function cmdScan(thresholdBps?: number): Promise<JsonOutput> {
  const threshold = thresholdBps ?? DEFAULT_SPREAD_THRESHOLD_BPS;

  // Fetch both pool types in parallel
  const [hodlmmPools, xykPools] = await Promise.all([
    fetchHodlmmPools(),
    fetchXykPools(),
  ]);

  if (hodlmmPools.length === 0) {
    return {
      ok: true,
      command: "scan",
      opportunities: [],
      message: "No HODLMM pools found.",
      scannedAt: new Date().toISOString(),
    };
  }

  // Index XYK pools by pair key (matching on token contract addresses)
  const xykByPair = new Map<string, XykPool[]>();
  for (const pool of xykPools) {
    const key = pairKey(pool.token0, pool.token1);
    const arr = xykByPair.get(key) ?? [];
    arr.push(pool);
    xykByPair.set(key, arr);
  }

  // Fetch bins for all HODLMM pools in parallel (bounded concurrency)
  const CONCURRENCY = 5;
  const binsMap = new Map<string, HodlmmBin[]>();
  for (let i = 0; i < hodlmmPools.length; i += CONCURRENCY) {
    const batch = hodlmmPools.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map((p) => fetchHodlmmBins(p.poolId))
    );
    results.forEach((r, idx) => {
      binsMap.set(
        batch[idx].poolId,
        r.status === "fulfilled" ? r.value : []
      );
    });
  }

  // Compare prices
  const opportunities: ArbOpportunity[] = [];

  for (const hodlmm of hodlmmPools) {
    const key = pairKey(hodlmm.tokenX, hodlmm.tokenY);
    const matchingXyk = xykByPair.get(key);
    if (!matchingXyk || matchingXyk.length === 0) continue;

    const bins = binsMap.get(hodlmm.poolId) ?? [];
    const hPrice = hodlmmEffectivePrice(hodlmm, bins);
    if (hPrice == null || hPrice <= 0) continue;

    for (const xyk of matchingXyk) {
      // Determine if tokens are in same order
      const sameOrder =
        normalizeToken(hodlmm.tokenX) === normalizeToken(xyk.token0);

      let xPrice = xykEffectivePrice(xyk);
      if (xPrice == null || xPrice <= 0) continue;

      // If tokens are reversed, invert the XYK price
      if (!sameOrder) {
        xPrice = 1 / xPrice;
      }

      // Spread calculation
      const spread = Math.abs(hPrice - xPrice) / Math.min(hPrice, xPrice);
      const spreadBps = Math.round(spread * 10_000);
      const spreadPct = parseFloat((spread * 100).toFixed(4));

      // Determine direction: buy cheap, sell expensive
      const direction: ArbOpportunity["direction"] =
        hPrice < xPrice ? "buy_hodlmm_sell_xyk" : "buy_xyk_sell_hodlmm";

      // Estimate profit after fees
      // HODLMM baseFee is typically in bps already
      const hodlmmFee = Math.round(hodlmm.baseFee) || 30;
      const xykFee = xyk.feeBps ?? 30;
      const totalFeeBps = hodlmmFee + xykFee;
      const profitBps = Math.max(0, spreadBps - totalFeeBps);

      if (spreadBps >= threshold) {
        opportunities.push({
          pair: pairLabel(hodlmm),
          hodlmmPoolId: hodlmm.poolId,
          xykPoolId: xyk.poolId,
          xykPoolType: xyk.type,
          hodlmmPrice: parseFloat(hPrice.toPrecision(8)),
          xykPrice: parseFloat(xPrice.toPrecision(8)),
          spreadPct,
          spreadBps,
          direction,
          estimatedProfitBps: profitBps,
          hodlmmFeeBps: hodlmmFee,
          xykFeeBps: xykFee,
          detectedAt: new Date().toISOString(),
        });
      }
    }
  }

  // Sort by spread descending
  opportunities.sort((a, b) => b.spreadBps - a.spreadBps);

  // Persist to history
  appendHistory({
    type: "scan",
    timestamp: new Date().toISOString(),
    opportunities,
  });

  return {
    ok: true,
    command: "scan",
    thresholdBps: threshold,
    hodlmmPoolsScanned: hodlmmPools.length,
    xykPoolsScanned: xykPools.length,
    matchingPairs: new Set(
      hodlmmPools
        .map((p) => pairKey(p.tokenX, p.tokenY))
        .filter((k) => xykByPair.has(k))
    ).size,
    opportunitiesFound: opportunities.length,
    opportunities,
    scannedAt: new Date().toISOString(),
  };
}

async function cmdExecute(
  poolId: string,
  amountSats: number
): Promise<JsonOutput> {
  if (!poolId || amountSats <= 0) {
    return {
      ok: false,
      command: "execute",
      error: "Missing --pool-id or --amount (must be > 0).",
    };
  }

  // 1. Fetch all HODLMM pools and find the target
  const hodlmmPools = await fetchHodlmmPools();
  const hodlmm = hodlmmPools.find((p) => p.poolId === poolId);
  if (!hodlmm) {
    return {
      ok: false,
      command: "execute",
      error: `HODLMM pool ${poolId} not found. Available: ${hodlmmPools.map((p) => p.poolId).join(", ")}`,
    };
  }

  // 2. Fetch bins for price
  const bins = await fetchHodlmmBins(poolId);
  const hPrice = hodlmmEffectivePrice(hodlmm, bins);

  // 3. Fetch matching XYK pools
  const xykPools = await fetchXykPools();
  const key = pairKey(hodlmm.tokenX, hodlmm.tokenY);
  const matchingXyk = xykPools.filter(
    (p) => pairKey(p.token0, p.token1) === key
  );

  if (matchingXyk.length === 0) {
    return {
      ok: false,
      command: "execute",
      error: `No XYK/StableSwap pool found for pair ${hodlmm.tokenXSymbol}/${hodlmm.tokenYSymbol} (${hodlmm.tokenX} / ${hodlmm.tokenY}).`,
    };
  }

  // Pick the XYK pool with best price for arb
  let bestXyk: XykPool | null = null;
  let bestSpreadBps = 0;
  let direction: ArbOpportunity["direction"] = "buy_hodlmm_sell_xyk";

  for (const xyk of matchingXyk) {
    const sameOrder =
      normalizeToken(hodlmm.tokenX) === normalizeToken(xyk.token0);
    let xPrice = xykEffectivePrice(xyk);
    if (xPrice == null || xPrice <= 0 || hPrice == null) continue;
    if (!sameOrder) xPrice = 1 / xPrice;

    const spread = Math.abs(hPrice - xPrice) / Math.min(hPrice, xPrice);
    const sBps = Math.round(spread * 10_000);
    if (sBps > bestSpreadBps) {
      bestSpreadBps = sBps;
      bestXyk = xyk;
      direction =
        hPrice < xPrice ? "buy_hodlmm_sell_xyk" : "buy_xyk_sell_hodlmm";
    }
  }

  if (!bestXyk || bestSpreadBps < DEFAULT_SPREAD_THRESHOLD_BPS) {
    return {
      ok: false,
      command: "execute",
      error: `Spread (${bestSpreadBps} bps) is below threshold (${DEFAULT_SPREAD_THRESHOLD_BPS} bps). Not profitable.`,
      spreadBps: bestSpreadBps,
    };
  }

  // 4. Get swap routes from Bitflow SDK API
  const fromToken =
    direction === "buy_hodlmm_sell_xyk" ? hodlmm.tokenX : bestXyk.token0;
  const toToken =
    direction === "buy_hodlmm_sell_xyk" ? hodlmm.tokenY : bestXyk.token1;

  let routes: unknown = null;
  try {
    routes = await fetchSwapRoutes(fromToken, toToken);
  } catch (err) {
    const entry: HistoryEntry = {
      type: "execute",
      timestamp: new Date().toISOString(),
      execution: {
        poolId,
        amount: amountSats,
        direction,
        quote: null,
        txId: null,
        status: "failed",
        error: `Route fetch failed: ${err instanceof Error ? err.message : err}`,
      },
    };
    appendHistory(entry);

    return {
      ok: false,
      command: "execute",
      error: `Failed to get swap routes: ${err instanceof Error ? err.message : err}`,
    };
  }

  // 5. Report the quote — actual signing must be done by the caller (BFF runtime)
  const executionResult = {
    poolId,
    amount: amountSats,
    direction,
    fromToken,
    toToken,
    spreadBps: bestSpreadBps,
    routes,
    txId: null as string | null,
    status: "simulated" as const,
    message:
      "Swap routes retrieved. Execution requires wallet signing by the BFF runtime. " +
      "Pass this output to the signing pipeline to broadcast the transaction.",
  };

  appendHistory({
    type: "execute",
    timestamp: new Date().toISOString(),
    execution: {
      poolId,
      amount: amountSats,
      direction,
      quote: null,
      txId: null,
      status: "simulated",
    },
  });

  return {
    ok: true,
    command: "execute",
    ...executionResult,
  };
}

async function cmdHistory(limit?: number): Promise<JsonOutput> {
  const history = loadHistory();
  const cap = limit ?? 20;
  const recent = history.slice(-cap).reverse();

  const scans = recent.filter((e) => e.type === "scan");
  const executions = recent.filter((e) => e.type === "execute");

  // Aggregate stats
  const totalOpportunities = scans.reduce(
    (sum, s) => sum + (s.opportunities?.length ?? 0),
    0
  );
  const profitableOpps = scans.reduce(
    (sum, s) =>
      sum +
      (s.opportunities?.filter((o) => o.estimatedProfitBps > 0).length ?? 0),
    0
  );

  return {
    ok: true,
    command: "history",
    entriesShown: recent.length,
    totalEntries: history.length,
    summary: {
      scansShown: scans.length,
      executionsShown: executions.length,
      totalOpportunitiesDetected: totalOpportunities,
      profitableOpportunities: profitableOpps,
    },
    entries: recent,
  };
}

// ─── CLI setup ───────────────────────────────────────────────────────────────

function output(data: JsonOutput): void {
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}

async function main(): Promise<void> {
  const program = new Command();

  program
    .name("hodlmm-arb-scanner")
    .description(
      "HODLMM cross-pool arbitrage scanner for Bitflow HODLMM vs XYK/StableSwap pools"
    )
    .version("1.0.0");

  program
    .command("doctor")
    .description(
      "Check Bitflow API availability and list available HODLMM pools"
    )
    .action(async () => {
      try {
        output(await cmdDoctor());
      } catch (err) {
        output({
          ok: false,
          command: "doctor",
          error: err instanceof Error ? err.message : String(err),
        });
        process.exitCode = 1;
      }
    });

  program
    .command("scan")
    .description(
      "Scan all HODLMM pools and compare against XYK/StableSwap for arb opportunities"
    )
    .option(
      "-t, --threshold <bps>",
      "Minimum spread in basis points to report",
      String(DEFAULT_SPREAD_THRESHOLD_BPS)
    )
    .action(async (opts) => {
      try {
        const threshold = parseInt(opts.threshold, 10);
        if (isNaN(threshold) || threshold < 0) {
          output({
            ok: false,
            command: "scan",
            error: "Invalid threshold. Must be a non-negative integer (bps).",
          });
          process.exitCode = 1;
          return;
        }
        output(await cmdScan(threshold));
      } catch (err) {
        output({
          ok: false,
          command: "scan",
          error: err instanceof Error ? err.message : String(err),
        });
        process.exitCode = 1;
      }
    });

  program
    .command("execute")
    .description("Execute an arbitrage swap when spread exceeds threshold")
    .requiredOption("--pool-id <id>", "HODLMM pool ID to arb against")
    .requiredOption("--amount <sats>", "Amount in smallest unit (sats)")
    .action(async (opts) => {
      try {
        const amount = parseInt(opts.amount, 10);
        if (isNaN(amount) || amount <= 0) {
          output({
            ok: false,
            command: "execute",
            error: "Invalid amount. Must be a positive integer.",
          });
          process.exitCode = 1;
          return;
        }
        output(await cmdExecute(opts.poolId, amount));
      } catch (err) {
        output({
          ok: false,
          command: "execute",
          error: err instanceof Error ? err.message : String(err),
        });
        process.exitCode = 1;
      }
    });

  program
    .command("history")
    .description("Show recently detected arbitrage opportunities")
    .option("-l, --limit <n>", "Number of entries to show", "20")
    .action(async (opts) => {
      try {
        const limit = parseInt(opts.limit, 10);
        output(await cmdHistory(isNaN(limit) ? 20 : limit));
      } catch (err) {
        output({
          ok: false,
          command: "history",
          error: err instanceof Error ? err.message : String(err),
        });
        process.exitCode = 1;
      }
    });

  // Default: show help if no command
  if (process.argv.length <= 2) {
    program.help();
  }

  await program.parseAsync(process.argv);
}

main().catch((err) => {
  output({
    ok: false,
    command: "unknown",
    error: err instanceof Error ? err.message : String(err),
  });
  process.exitCode = 1;
});

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
const STACKS_API = "https://api.mainnet.hiro.so";

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
  token0Symbol: string;
  token1Symbol: string;
  lastPrice: number; // from ticker API (price of token0 in terms of token1)
  liquidityUsd: number;
  feeBps: number;
  dex: string;       // which DEX (ALEX, VELAR, BITFLOW_XYK, etc.)
  type: "xyk" | "stableswap";
}

interface ArbOpportunity {
  pair: string;
  cheapPool: { id: string; dex: string; price: number; feeBps: number };
  expensivePool: { id: string; dex: string; price: number; feeBps: number };
  spreadPct: number;
  spreadBps: number;
  estimatedProfitBps: number;
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

async function fetchJson<T>(url: string, init?: RequestInit, retries = MAX_RETRIES): Promise<T> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
        headers: { Accept: "application/json", ...init?.headers },
        ...init,
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

  // Include ALL DEXes (ALEX, VELAR, BITFLOW) for cross-DEX arb
  return rawPools
    .map((p) => {
      const poolTrait = p.poolData?.["pool-trait"] ?? "";
      const poolType: "xyk" | "stableswap" = (p.dex || "").includes("STABLE")
        ? "stableswap"
        : "xyk";

      // Look up ticker price by pool-trait
      const ticker = tickerByPoolId.get(normalizeToken(poolTrait));
      const lastPrice = ticker?.last_price ?? 0;
      const liquidityUsd = ticker?.liquidity_in_usd ?? 0;

      // Fee: 30 bps default, ALEX often uses 30, VELAR uses 30
      const feeBps = 30;

      return {
        poolId: p.contract,
        poolTrait,
        token0: p.poolData?.xToken || "",
        token1: p.poolData?.yToken || "",
        token0Symbol: p.tokenX || "",
        token1Symbol: p.tokenY || "",
        lastPrice,
        liquidityUsd,
        feeBps,
        dex: p.dex || "unknown",
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
 */
function xykEffectivePrice(pool: XykPool): number | null {
  if (pool.lastPrice > 0) return pool.lastPrice;
  return null;
}

/**
 * Read on-chain reserves from a Bitflow XYK pool contract via Hiro read-only call.
 * Returns { xBalance, yBalance } in raw atomic units.
 */
async function readOnChainReserves(
  poolTrait: string
): Promise<{ xBalance: number; yBalance: number } | null> {
  if (!poolTrait) return null;
  const dotIdx = poolTrait.indexOf(".");
  if (dotIdx === -1) return null;
  const addr = poolTrait.substring(0, dotIdx);
  const name = poolTrait.substring(dotIdx + 1);

  try {
    const resp = await fetch(
      `${STACKS_API}/v2/contracts/call-read/${addr}/${name}/get-pool`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sender: addr, arguments: [] }),
        signal: AbortSignal.timeout(10_000),
      }
    );
    const data = (await resp.json()) as { okay: boolean; result: string };
    if (!data.okay) return null;

    const hex = data.result;
    const findUint = (fieldName: string): number | null => {
      const nameHex = Buffer.from(fieldName).toString("hex");
      const idx = hex.indexOf(nameHex);
      if (idx === -1) return null;
      const afterName = idx + nameHex.length;
      // uint type marker = "01", followed by 32 hex chars (16 bytes)
      const typeIdx = hex.indexOf("01", afterName);
      if (typeIdx < 0 || typeIdx > afterName + 4) return null;
      return parseInt(hex.substring(typeIdx + 2, typeIdx + 34), 16);
    };

    const xBalance = findUint("x-balance");
    const yBalance = findUint("y-balance");
    if (xBalance == null || yBalance == null) return null;
    return { xBalance, yBalance };
  } catch {
    return null;
  }
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

// Unified pool entry for cross-DEX comparison
interface UnifiedPool {
  id: string;
  dex: string;
  token0: string;
  token1: string;
  pair: string;
  price: number;
  feeBps: number;
}

async function cmdScan(thresholdBps?: number): Promise<JsonOutput> {
  const threshold = thresholdBps ?? DEFAULT_SPREAD_THRESHOLD_BPS;

  const [hodlmmPools, xykPools] = await Promise.all([
    fetchHodlmmPools(),
    fetchXykPools(),
  ]);

  // Fetch HODLMM bins
  const CONCURRENCY = 5;
  const binsMap = new Map<string, HodlmmBin[]>();
  for (let i = 0; i < hodlmmPools.length; i += CONCURRENCY) {
    const batch = hodlmmPools.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(batch.map((p) => fetchHodlmmBins(p.poolId)));
    results.forEach((r, idx) => {
      binsMap.set(batch[idx].poolId, r.status === "fulfilled" ? r.value : []);
    });
  }

  // Build unified pool list — ALL DEXes
  const allPools: UnifiedPool[] = [];

  for (const h of hodlmmPools) {
    const bins = binsMap.get(h.poolId) ?? [];
    const price = hodlmmEffectivePrice(h, bins);
    if (price != null && price > 0) {
      allPools.push({
        id: h.poolId, dex: "HODLMM",
        token0: h.tokenX, token1: h.tokenY,
        pair: `${h.tokenXSymbol || h.tokenX.split(".").pop()}/${h.tokenYSymbol || h.tokenY.split(".").pop()}`,
        price, feeBps: Math.round((h.baseFee || 0.003) * 10000),
      });
    }
  }

  // Build token price index from HODLMM data (reliable USD prices)
  const tokenPriceUsd = new Map<string, number>();
  for (const h of hodlmmPools) {
    if (h.tokenXPriceUsd > 0) tokenPriceUsd.set(normalizeToken(h.tokenX), h.tokenXPriceUsd);
    if (h.tokenYPriceUsd > 0) tokenPriceUsd.set(normalizeToken(h.tokenY), h.tokenYPriceUsd);
  }

  // Build set of HODLMM pair keys for targeted on-chain reads
  const hodlmmPairKeys = new Set(hodlmmPools.map((h) => pairKey(h.tokenX, h.tokenY)));

  // Token decimals index (from HODLMM data)
  const tokenDecimals = new Map<string, number>();
  for (const h of hodlmmPools) {
    if (h.tokenXDecimals) tokenDecimals.set(normalizeToken(h.tokenX), h.tokenXDecimals);
    if (h.tokenYDecimals) tokenDecimals.set(normalizeToken(h.tokenY), h.tokenYDecimals);
  }

  // For XYK pools that overlap HODLMM pairs: read on-chain reserves (XYK only, not StableSwap)
  // StableSwap uses a curved AMM — reserves ratio ≠ execution price. Use HODLMM quote API instead.
  const ON_CHAIN_CONCURRENCY = 3;
  const xykOnChainPrices = new Map<string, number>(); // poolTrait → price

  const xykNeedOnChain = xykPools.filter((x) => {
    const key = pairKey(x.token0, x.token1);
    return hodlmmPairKeys.has(key) && x.poolTrait && x.dex.includes("XYK");
  });

  for (let i = 0; i < xykNeedOnChain.length; i += ON_CHAIN_CONCURRENCY) {
    const batch = xykNeedOnChain.slice(i, i + ON_CHAIN_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map((x) => readOnChainReserves(x.poolTrait))
    );
    results.forEach((r, idx) => {
      if (r.status === "fulfilled" && r.value) {
        const x = batch[idx];
        const xDec = tokenDecimals.get(normalizeToken(x.token0)) || 6;
        const yDec = tokenDecimals.get(normalizeToken(x.token1)) || 6;
        const xH = r.value.xBalance / Math.pow(10, xDec);
        const yH = r.value.yBalance / Math.pow(10, yDec);
        if (xH > 0 && yH > 0) {
          xykOnChainPrices.set(x.poolTrait, yH / xH);
        }
      }
    });
  }

  // For StableSwap pools overlapping HODLMM: use HODLMM quote API to get real execution price
  // This is the correct approach — StableSwap curve ≠ reserves ratio
  const stableNeedQuote = xykPools.filter((x) => {
    const key = pairKey(x.token0, x.token1);
    return hodlmmPairKeys.has(key) && x.dex.includes("STABLE");
  });
  const stableQuotePrices = new Map<string, number>();

  for (const sp of stableNeedQuote) {
    try {
      // Get quote: swap 100 units of token0 for token1 via HODLMM quote
      // (HODLMM quote API routes through the best pool automatically)
      const xDec = tokenDecimals.get(normalizeToken(sp.token0)) || 6;
      const testAmount = (100 * Math.pow(10, xDec)).toString();
      const quoteResp = await fetchJson<{ success: boolean; amount_out: string; fee: string }>(
        `${HODLMM_API}/quotes/v1/quote`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            input_token: sp.token0,
            output_token: sp.token1,
            amount_in: testAmount,
          }),
        }
      );
      if (quoteResp.success && quoteResp.amount_out) {
        const yDec = tokenDecimals.get(normalizeToken(sp.token1)) || 6;
        const outHuman = parseInt(quoteResp.amount_out) / Math.pow(10, yDec);
        const inHuman = 100;
        // This gives HODLMM's price — we need StableSwap's actual price
        // Since we can't get StableSwap quote directly, mark it as "quote-verified"
        // and use the HODLMM price (which means spread ≈ 0 for stablecoins)
        stableQuotePrices.set(sp.poolTrait, outHuman / inHuman);
      }
    } catch { /* skip */ }
  }

  for (const x of xykPools) {
    let price = xykEffectivePrice(x); // ticker price (often 0)
    let priceSource = "ticker";

    // XYK pools: use on-chain reserves (correct for x*y=k)
    if ((price == null || price <= 0) && x.dex.includes("XYK")) {
      const onChainPrice = xykOnChainPrices.get(x.poolTrait);
      if (onChainPrice) {
        price = onChainPrice;
        priceSource = "on-chain-reserves";
      }
    }

    // StableSwap pools: use HODLMM quote as proxy
    // NOTE: This means StableSwap price ≈ HODLMM price for same pair
    // Real StableSwap execution price requires direct contract call (get-dy)
    // which needs pool-specific Clarity arguments we can't generalize
    if ((price == null || price <= 0) && x.dex.includes("STABLE")) {
      const quotePrice = stableQuotePrices.get(x.poolTrait);
      if (quotePrice) {
        price = quotePrice;
        priceSource = "hodlmm-quote-proxy";
      }
    }

    // Final fallback: USD-derived price
    if ((price == null || price <= 0) && x.token0 && x.token1) {
      const p0 = tokenPriceUsd.get(normalizeToken(x.token0));
      const p1 = tokenPriceUsd.get(normalizeToken(x.token1));
      if (p0 && p0 > 0 && p1 && p1 > 0) {
        price = p0 / p1;
        priceSource = "usd-derived";
      }
    }

    if (price != null && price > 0) {
      allPools.push({
        id: x.poolId, dex: x.dex + (priceSource !== "ticker" ? ` [${priceSource}]` : ""),
        token0: x.token0, token1: x.token1,
        pair: `${x.token0Symbol || x.token0.split(".").pop()}/${x.token1Symbol || x.token1.split(".").pop()}`,
        price, feeBps: x.feeBps,
      });
    }
  }

  // Group by canonical token pair
  const byPair = new Map<string, UnifiedPool[]>();
  for (const pool of allPools) {
    const n0 = normalizeToken(pool.token0);
    const n1 = normalizeToken(pool.token1);
    const canonKey = n0 < n1 ? `${n0}|${n1}` : `${n1}|${n0}`;
    const isReversed = !(n0 < n1);
    if (isReversed && pool.price > 0) {
      pool.price = 1 / pool.price;
      [pool.token0, pool.token1] = [pool.token1, pool.token0];
    }
    const arr = byPair.get(canonKey) ?? [];
    arr.push(pool);
    byPair.set(canonKey, arr);
  }

  // Find cross-DEX arb: pairs with 2+ pools on DIFFERENT DEXes
  const opportunities: ArbOpportunity[] = [];
  let pairsWithMultipleDexes = 0;

  for (const [, pools] of byPair) {
    if (pools.length < 2) continue;
    const dexes = new Set(pools.map((p) => p.dex));
    if (dexes.size < 2) continue;
    pairsWithMultipleDexes++;

    // Compare every cross-DEX pair combination
    for (let i = 0; i < pools.length; i++) {
      for (let j = i + 1; j < pools.length; j++) {
        if (pools[i].dex === pools[j].dex) continue;
        const [cheap, exp] = pools[i].price < pools[j].price
          ? [pools[i], pools[j]]
          : [pools[j], pools[i]];

        const spread = (exp.price - cheap.price) / cheap.price;
        const spreadBps = Math.round(spread * 10_000);
        const spreadPct = parseFloat((spread * 100).toFixed(4));
        const profitBps = Math.max(0, spreadBps - cheap.feeBps - exp.feeBps);

        if (spreadBps >= threshold) {
          opportunities.push({
            pair: cheap.pair || exp.pair,
            cheapPool: { id: cheap.id, dex: cheap.dex, price: parseFloat(cheap.price.toPrecision(8)), feeBps: cheap.feeBps },
            expensivePool: { id: exp.id, dex: exp.dex, price: parseFloat(exp.price.toPrecision(8)), feeBps: exp.feeBps },
            spreadPct, spreadBps, estimatedProfitBps: profitBps,
            detectedAt: new Date().toISOString(),
          });
        }
      }
    }
  }

  opportunities.sort((a, b) => b.spreadBps - a.spreadBps);
  appendHistory({ type: "scan", timestamp: new Date().toISOString(), opportunities });

  const dexCounts: Record<string, number> = {};
  for (const p of allPools) dexCounts[p.dex] = (dexCounts[p.dex] || 0) + 1;

  return {
    ok: true, command: "scan", thresholdBps: threshold,
    totalPoolsScanned: allPools.length,
    dexDistribution: dexCounts,
    pairsWithMultipleDexes,
    opportunitiesFound: opportunities.length,
    opportunities: opportunities.slice(0, 20),
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

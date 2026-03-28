#!/usr/bin/env bun
import { Command } from "commander";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const TICKER_API = "https://bitflow-sdk-api-gateway-7owjsmt8.uc.gateway.dev/ticker";
const HIRO_POX_API = "https://api.hiro.so/v2/pox";
const HIRO_BALANCES_API = "https://api.hiro.so/extended/v1/address";
const LLAMA_PROTOCOL_API = "https://api.llama.fi/protocol/bitflow";
const COINGECKO_PRICE_API =
  "https://api.coingecko.com/api/v3/simple/price?ids=blockstack,bitcoin&vs_currencies=usd";
const FEE_RATE = 0.003; // 0.3% assumed fee rate
const MIN_LIQUIDITY_USD = 1000;
const FETCH_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface TickerEntry {
  base_currency: string;
  base_volume: number;
  high: number;
  last_price: number;
  liquidity_in_usd: number;
  low: number;
  pool_id: string;
  target_currency: string;
  target_volume: number;
  ticker_id: string;
}

interface PoolSummary {
  pool_id: string;
  name: string;
  base_currency: string;
  target_currency: string;
  liquidity_usd: number;
  last_price: number;
  high: number;
  low: number;
  volume_24h: number;
  fee_apy_pct: number | null;
}

interface ProtocolData {
  tvl: number | null;
  stacks_tvl: number | null;
  name: string | null;
}

interface Prices {
  stx_usd: number | null;
  btc_usd: number | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function fetchJSON(url: string): Promise<unknown> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    return await res.json().catch(() => null);
  } catch {
    return null;
  }
}

function out(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

/** Parse a Bitflow LP pool_id/ticker_id into a human-readable pair name.
 *  e.g. "SPQC38PW542EQJ5M11CR25P7BS1CA6QT4TBXGB3M.stx-ststx-lp-token-v-1-2"
 *  → "STX/stSTX"
 */
function poolName(poolId: string, baseCurrency: string, targetCurrency: string): string {
  // Try to derive from token contract names
  function tokenLabel(raw: string): string {
    if (!raw || raw === "") return "?";
    // If it looks like a Stacks principal (SP.../SM...), extract the contract name part
    if (raw.includes(".")) {
      const contractName = raw.split(".").pop() ?? raw;
      // Strip common suffixes
      return contractName
        .replace(/-token(-v[-\d.]*)?$/, "")
        .replace(/-lp$/, "")
        .replace(/-/g, "")
        .toUpperCase();
    }
    return raw.toUpperCase();
  }

  const b = tokenLabel(baseCurrency);
  const t = tokenLabel(targetCurrency);
  if (b !== "?" && t !== "?") return `${b}/${t}`;

  // Fallback: parse pool_id contract name
  const contractName = (poolId.split(".").pop() ?? poolId)
    .replace(/-lp-token.*$/, "")
    .replace(/-/g, "/")
    .toUpperCase();
  return contractName || poolId;
}

function fmtUsd(n: number): string {
  return n.toFixed(2);
}

function fmtPct(n: number): string {
  return n.toFixed(2);
}

function fmtPrice(n: number): string {
  return n.toFixed(6);
}

// ---------------------------------------------------------------------------
// Shared data fetchers
// ---------------------------------------------------------------------------
async function fetchTickers(): Promise<TickerEntry[] | null> {
  const raw = await fetchJSON(TICKER_API);
  if (!Array.isArray(raw)) return null;
  return raw as TickerEntry[];
}

async function fetchProtocol(): Promise<ProtocolData> {
  const raw = await fetchJSON(LLAMA_PROTOCOL_API) as Record<string, unknown> | null;
  if (!raw) return { tvl: null, stacks_tvl: null, name: null };
  const tvl = typeof raw.tvl === "number" ? raw.tvl : null;
  const name = typeof raw.name === "string" ? raw.name : null;
  // Try to extract Stacks chain TVL from chainTvls
  let stacks_tvl: number | null = null;
  const chainTvls = raw.chainTvls as Record<string, unknown> | undefined;
  if (chainTvls) {
    const stacksEntry = chainTvls["Stacks"] ?? chainTvls["stacks"];
    if (typeof stacksEntry === "number") {
      stacks_tvl = stacksEntry;
    } else if (stacksEntry && typeof (stacksEntry as Record<string, unknown>).tvl === "number") {
      stacks_tvl = (stacksEntry as Record<string, unknown>).tvl as number;
    }
  }
  return { tvl, stacks_tvl, name };
}

async function fetchPrices(): Promise<Prices> {
  const raw = await fetchJSON(COINGECKO_PRICE_API) as Record<string, Record<string, number>> | null;
  if (!raw) return { stx_usd: null, btc_usd: null };
  const stx_usd = raw?.blockstack?.usd ?? null;
  const btc_usd = raw?.bitcoin?.usd ?? null;
  return { stx_usd, btc_usd };
}

function buildPools(tickers: TickerEntry[]): PoolSummary[] {
  return tickers
    .filter((t) => t.liquidity_in_usd >= MIN_LIQUIDITY_USD)
    .map((t) => {
      const volume_24h = (t.base_volume ?? 0) + (t.target_volume ?? 0);
      let fee_apy_pct: number | null = null;
      if (t.liquidity_in_usd > 0) {
        fee_apy_pct = Number(fmtPct((volume_24h * FEE_RATE * 365) / t.liquidity_in_usd));
      }
      return {
        pool_id: t.pool_id,
        name: poolName(t.pool_id, t.base_currency, t.target_currency),
        base_currency: t.base_currency,
        target_currency: t.target_currency,
        liquidity_usd: Number(fmtUsd(t.liquidity_in_usd)),
        last_price: Number(fmtPrice(t.last_price ?? 0)),
        high: Number(fmtPrice(t.high ?? 0)),
        low: Number(fmtPrice(t.low ?? 0)),
        volume_24h: Number(fmtUsd(volume_24h)),
        fee_apy_pct,
      };
    })
    .sort((a, b) => b.liquidity_usd - a.liquidity_usd);
}

// ---------------------------------------------------------------------------
// doctor command
// ---------------------------------------------------------------------------
async function doctor(): Promise<void> {
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

  // Check 1: Ticker API connectivity
  const tickers = await fetchTickers();
  const tickerOk = tickers !== null && tickers.length > 0;
  checks.push({
    name: "ticker_api",
    ok: tickerOk,
    detail: tickerOk
      ? `Ticker API returned ${tickers!.length} pools`
      : `Failed to reach ${TICKER_API}`,
  });

  // Check 2: STACKS_ADDRESS / STX_ADDRESS env var
  const address = process.env.STACKS_ADDRESS || process.env.STX_ADDRESS || null;
  const addrOk = address !== null && address.length > 0;
  checks.push({
    name: "stacks_address",
    ok: addrOk,
    detail: addrOk
      ? `Found address: ${address}`
      : "Neither STACKS_ADDRESS nor STX_ADDRESS is set (required for position commands)",
  });

  // Check 3: Hiro API connectivity
  const pox = await fetchJSON(HIRO_POX_API);
  const hiroOk = pox !== null;
  checks.push({
    name: "hiro_api",
    ok: hiroOk,
    detail: hiroOk
      ? "Hiro PoX API is reachable"
      : `Failed to reach ${HIRO_POX_API}`,
  });

  const allOk = checks.every((c) => c.ok);
  out({
    status: allOk ? "ready" : "error",
    action: "doctor",
    data: { checks },
  });
}

// ---------------------------------------------------------------------------
// status command
// ---------------------------------------------------------------------------
async function status(): Promise<void> {
  const [tickers, protocol, prices] = await Promise.all([
    fetchTickers(),
    fetchProtocol(),
    fetchPrices(),
  ]);

  if (!tickers) {
    out({
      status: "error",
      action: "status",
      error: `Failed to fetch pools from Ticker API (${TICKER_API}). The API may be temporarily unavailable.`,
    });
    return;
  }

  if (tickers.length === 0) {
    out({
      status: "error",
      action: "status",
      error: "Ticker API returned an empty pool list.",
    });
    return;
  }

  const pools = buildPools(tickers);

  out({
    status: "success",
    action: "status",
    data: {
      pools,
      protocol: {
        name: protocol.name ?? "Bitflow",
        tvl_usd: protocol.tvl !== null ? Number(fmtUsd(protocol.tvl)) : null,
        stacks_tvl_usd:
          protocol.stacks_tvl !== null ? Number(fmtUsd(protocol.stacks_tvl)) : null,
      },
      prices: {
        stx_usd: prices.stx_usd,
        btc_usd: prices.btc_usd,
      },
      meta: {
        total_tickers: tickers.length,
        filtered_pools: pools.length,
        min_liquidity_filter_usd: MIN_LIQUIDITY_USD,
        assumed_fee_rate_pct: FEE_RATE * 100,
      },
      timestamp: new Date().toISOString(),
    },
  });
}

// ---------------------------------------------------------------------------
// run analyze --amount <usd_value>
// ---------------------------------------------------------------------------
async function analyze(opts: { amount: string }): Promise<void> {
  const amountUsd = parseFloat(opts.amount);
  if (isNaN(amountUsd) || amountUsd <= 0) {
    out({ status: "error", action: "analyze", error: "Invalid --amount value; must be a positive number (USD)." });
    return;
  }

  const tickers = await fetchTickers();
  if (!tickers || tickers.length === 0) {
    out({ status: "error", action: "analyze", error: "Failed to fetch pool data from Ticker API." });
    return;
  }

  const pools = buildPools(tickers);
  if (pools.length === 0) {
    out({ status: "error", action: "analyze", error: `No pools with liquidity >= $${MIN_LIQUIDITY_USD} found.` });
    return;
  }

  // Filter out junk pools before scoring
  const filteredPools = pools.filter((p) => {
    if ((p.fee_apy_pct ?? 0) > 1000) return false; // fake volume / abnormal APY
    if (p.liquidity_usd < 10000) return false;      // too shallow
    if (p.volume_24h === 0) return false;            // no recent trading activity
    return true;
  });

  if (filteredPools.length === 0) {
    out({ status: "error", action: "analyze", error: "No qualifying pools after filtering (APY ≤ 1000%, liquidity ≥ $10k, volume > 0)." });
    return;
  }

  // Risk-adjusted score: fee_apy / (spread_volatility + 1)
  // Spread volatility proxy: (high - low) / last_price if last_price > 0, else 0
  const scored = filteredPools.map((p) => {
    const apy = p.fee_apy_pct ?? 0;
    let spread = 0;
    if (p.last_price > 0 && (p.high > 0 || p.low > 0)) {
      const lo = p.low > 0 ? p.low : p.last_price;
      const hi = p.high > 0 ? p.high : p.last_price;
      spread = (hi - lo) / p.last_price;
    }
    const score = apy / (spread + 1);
    return { pool: p, score, spread_pct: Number(fmtPct(spread * 100)) };
  });

  scored.sort((a, b) => b.score - a.score);
  const top3 = scored.slice(0, 3);

  const recommendations = top3.map((item, rank) => {
    const { pool } = item;
    const apy = pool.fee_apy_pct ?? 0;
    const daily_yield_usd = Number(fmtUsd((amountUsd * apy) / 100 / 365));
    const weekly_yield_usd = Number(fmtUsd(daily_yield_usd * 7));
    const monthly_yield_usd = Number(fmtUsd(daily_yield_usd * 30));

    return {
      rank: rank + 1,
      pool_id: pool.pool_id,
      name: pool.name,
      liquidity_usd: pool.liquidity_usd,
      fee_apy_pct: apy,
      spread_volatility_pct: item.spread_pct,
      risk_adjusted_score: Number(item.score.toFixed(4)),
      projected_yields: {
        amount_usd: Number(fmtUsd(amountUsd)),
        daily_usd: daily_yield_usd,
        weekly_usd: weekly_yield_usd,
        monthly_usd: monthly_yield_usd,
        daily_pct: Number(fmtPct(apy / 365)),
        weekly_pct: Number(fmtPct((apy / 365) * 7)),
        monthly_pct: Number(fmtPct((apy / 365) * 30)),
      },
    };
  });

  out({
    status: "success",
    action: "analyze",
    data: {
      amount_usd: Number(fmtUsd(amountUsd)),
      note: "APY estimated from 24h volume × 0.3% fee × 365 / liquidity. Past volume is not guaranteed.",
      recommendations,
    },
  });
}

// ---------------------------------------------------------------------------
// run position --address <stx_address>
// ---------------------------------------------------------------------------
async function position(opts: { address: string }): Promise<void> {
  const addr = opts.address.trim();
  if (!addr) {
    out({ status: "error", action: "position", error: "Address is required." });
    return;
  }

  // Fetch fungible token balances from Hiro API
  const balancesUrl = `${HIRO_BALANCES_API}/${addr}/balances`;
  const raw = await fetchJSON(balancesUrl) as Record<string, unknown> | null;
  if (!raw) {
    out({
      status: "error",
      action: "position",
      error: `Failed to fetch balances from Hiro API for address ${addr}. Check that the address is valid.`,
    });
    return;
  }

  // Hiro extended/v1 balances: { fungible_tokens: { "<principal>::<name>": { balance, ... } } }
  const ftMap = (raw.fungible_tokens ?? {}) as Record<string, { balance: string }>;

  // Fetch current pool list to cross-reference LP tokens
  const tickers = await fetchTickers();

  // Find LP tokens: contract name contains "lp-token" or "pool"
  const holdings: Array<{
    token_name: string;
    balance: string;
    pool_id: string | null;
    pool_name: string | null;
    pool_liquidity_usd: number | null;
    fee_apy_pct: number | null;
  }> = [];

  for (const [tokenId, info] of Object.entries(ftMap)) {
    const balance = info.balance ?? "0";
    if (balance === "0") continue;

    const tokenContract = tokenId.includes("::") ? tokenId.split("::")[0] : tokenId;
    const contractNamePart = (tokenContract.split(".").pop() ?? tokenContract).toLowerCase();

    // Only interested in LP tokens
    const isLp = contractNamePart.includes("lp-token") || contractNamePart.includes("pool");
    if (!isLp) continue;

    // Cross-reference pool list by matching pool_id
    let matchedPoolId: string | null = null;
    let poolLiquidityUsd: number | null = null;
    let feeApyPct: number | null = null;

    if (tickers) {
      for (const ticker of tickers) {
        if (
          ticker.pool_id === tokenContract ||
          tokenContract.startsWith(ticker.pool_id) ||
          ticker.pool_id.startsWith(tokenContract)
        ) {
          matchedPoolId = ticker.pool_id;
          poolLiquidityUsd = ticker.liquidity_in_usd;
          const vol = (ticker.base_volume ?? 0) + (ticker.target_volume ?? 0);
          feeApyPct =
            ticker.liquidity_in_usd > 0
              ? Number(fmtPct((vol * FEE_RATE * 365) / ticker.liquidity_in_usd))
              : null;
          break;
        }
      }
    }

    holdings.push({
      token_name: tokenId,
      balance,
      pool_id: matchedPoolId,
      pool_name: matchedPoolId
        ? poolName(matchedPoolId, "", "")
        : contractNamePart,
      pool_liquidity_usd: poolLiquidityUsd,
      fee_apy_pct: feeApyPct,
    });
  }

  if (holdings.length === 0) {
    out({
      status: "success",
      action: "position",
      data: { address: addr, holdings: [], message: "No Bitflow LP tokens found" },
    });
    return;
  }

  out({
    status: "success",
    action: "position",
    data: {
      address: addr,
      holdings,
      meta: {
        lp_tokens_found: holdings.length,
        note: "balance is in the token's smallest denomination.",
      },
    },
  });
}

// ---------------------------------------------------------------------------
// run entry --pool <pool_id> --amount <usd_value>
// ---------------------------------------------------------------------------
async function entry(opts: { pool: string; amount: string }): Promise<void> {
  const poolId = opts.pool.trim();
  const amountUsd = parseFloat(opts.amount);

  if (!poolId) {
    out({ status: "error", action: "entry", error: "--pool is required." });
    return;
  }
  if (isNaN(amountUsd) || amountUsd <= 0) {
    out({ status: "error", action: "entry", error: "--amount must be a positive number (USD)." });
    return;
  }

  const [tickers] = await Promise.all([fetchTickers()]);
  if (!tickers) {
    out({ status: "error", action: "entry", error: "Failed to fetch pool data from Ticker API." });
    return;
  }

  // Find pool — allow partial match (user may omit version suffix)
  const ticker = tickers.find(
    (t) => t.pool_id === poolId || t.pool_id.startsWith(poolId) || poolId.startsWith(t.pool_id)
  );

  if (!ticker) {
    out({
      status: "error",
      action: "entry",
      error: `Pool "${poolId}" not found. Run "status" to list available pools.`,
    });
    return;
  }

  // XYK 50/50 split: tokenX_amount = amount/2 / tokenX_price
  // Use last_price as tokenX price (price of base in terms of target)
  // tokenY_price is assumed $1 or derived from last_price
  const lastPrice = ticker.last_price ?? 0;
  const halfUsd = amountUsd / 2;

  // tokenX = base_currency, tokenY = target_currency
  // last_price = price of tokenX in tokenY units
  // We need USD prices; use last_price as relative proxy
  // tokenX_amount = halfUsd / tokenX_price_usd
  // tokenY_amount = halfUsd / tokenY_price_usd
  // Without external USD prices per token, estimate using last_price ratio
  // If last_price > 0: tokenX is worth last_price × tokenY, so tokenX_amount × last_price = tokenY_amount
  // Both sides = halfUsd, so: tokenX_amount = halfUsd / tokenX_price_usd
  // We expose the amounts in "units" assuming last_price approximates tokenX/tokenY exchange rate
  let tokenXAmount: string;
  let tokenYAmount: string;
  let minLpTokens: string;

  if (lastPrice > 0) {
    // halfUsd / last_price gives relative token units (treat last_price as USD price of tokenX)
    const xAmt = halfUsd / lastPrice;
    const yAmt = halfUsd; // treat tokenY as ~$1 unit; caller should adjust
    tokenXAmount = xAmt.toFixed(6);
    tokenYAmount = yAmt.toFixed(6);
    // min_lp_tokens: apply 1% slippage → 99% of geometric mean
    minLpTokens = (Math.sqrt(xAmt * yAmt) * 0.99).toFixed(6);
  } else {
    tokenXAmount = "0";
    tokenYAmount = "0";
    minLpTokens = "0";
  }

  // Safety checks
  const safetyChecks: Array<{ check: string; ok: boolean; message: string }> = [];

  const tvlSharePct = ticker.liquidity_in_usd > 0
    ? (amountUsd / ticker.liquidity_in_usd) * 100
    : Infinity;
  if (tvlSharePct > 10) {
    safetyChecks.push({
      check: "position_size",
      ok: false,
      message: "Large position relative to pool TVL",
    });
  } else {
    safetyChecks.push({
      check: "position_size",
      ok: true,
      message: `Deposit is ${fmtPct(tvlSharePct)}% of pool TVL`,
    });
  }

  const volume_24h = (ticker.base_volume ?? 0) + (ticker.target_volume ?? 0);
  if (volume_24h === 0) {
    safetyChecks.push({
      check: "trading_activity",
      ok: false,
      message: "No recent trading activity",
    });
  } else {
    safetyChecks.push({
      check: "trading_activity",
      ok: true,
      message: `24h volume: $${fmtUsd(volume_24h)}`,
    });
  }

  const fee_apy_pct =
    ticker.liquidity_in_usd > 0
      ? Number(fmtPct((volume_24h * FEE_RATE * 365) / ticker.liquidity_in_usd))
      : null;

  const pName = poolName(ticker.pool_id, ticker.base_currency, ticker.target_currency);

  const params = {
    amount_usd: Number(fmtUsd(amountUsd)),
    token_x: ticker.base_currency,
    token_y: ticker.target_currency,
    token_x_amount: tokenXAmount,
    token_y_amount: tokenYAmount,
    max_slippage_pct: 1,
  };

  const mcpCommand = {
    tool: "bitflow_add_liquidity",
    arguments: {
      pool_id: ticker.pool_id,
      token_x_amount: tokenXAmount,
      token_y_amount: tokenYAmount,
      min_lp_tokens: minLpTokens,
    },
  };

  out({
    status: "success",
    action: "entry",
    data: {
      pool: {
        pool_id: ticker.pool_id,
        liquidity_usd: Number(fmtUsd(ticker.liquidity_in_usd)),
        last_price: Number(fmtPrice(lastPrice)),
        volume_24h: Number(fmtUsd(volume_24h)),
        fee_apy_pct,
      },
      poolName: pName,
      params,
      safetyChecks,
      mcpCommand,
    },
  });
}

// ---------------------------------------------------------------------------
// Commander setup
// ---------------------------------------------------------------------------
const program = new Command();
program
  .name("hodlmm-yield-radar")
  .description("Bitflow HODLMM pool yield scanner and position monitor");

program
  .command("doctor")
  .description("Check environment and API connectivity")
  .action(doctor);

program
  .command("status")
  .description("Show all Bitflow pools with liquidity, volume, and estimated APY")
  .action(status);

const run = program.command("run").description("Core DeFi operations");

run
  .command("analyze")
  .description("Recommend best pools for a given investment amount")
  .requiredOption("--amount <usd_value>", "Investment amount in USD")
  .action((opts: { amount: string }) => analyze(opts));

run
  .command("position")
  .description("Show Bitflow LP token holdings for a Stacks address")
  .requiredOption("--address <stx_address>", "Stacks address to inspect")
  .action((opts: { address: string }) => position(opts));

run
  .command("entry")
  .description("Calculate entry parameters and safety checks for a pool")
  .requiredOption("--pool <pool_id>", "Pool ID (from status output)")
  .requiredOption("--amount <usd_value>", "Amount to deposit in USD")
  .action((opts: { pool: string; amount: string }) => entry(opts));

program.parse();

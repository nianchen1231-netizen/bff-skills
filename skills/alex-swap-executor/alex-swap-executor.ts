#!/usr/bin/env bun
/**
 * ALEX DEX Swap Executor — BFF Skills Competition
 *
 * A general-purpose swap executor for the ALEX decentralized exchange on Stacks.
 * Supports quoting, executing, monitoring, and logging swaps across any ALEX-listed
 * token pair (STX, sBTC, ALEX, stSTX, USDA, etc.).
 *
 * Safety: slippage cap, spend cap, gas cap, cooldown, confirmation gate, quote staleness.
 */

import { Command, Option } from "commander";
import { getAlexDexService } from "@aibtc/mcp-server/dist/services/defi.service.js";
import { getWalletManager } from "@aibtc/mcp-server/dist/services/wallet-manager.js";
import { getExplorerTxUrl } from "@aibtc/mcp-server/dist/config/networks.js";
import * as fs from "fs";
import * as path from "path";

// ─── Types ────────────────────────────────────────────────────────────────────

interface OutputEnvelope {
  status: "ok" | "error" | "warn";
  action: string;
  data: any;
  error: string | null;
}

interface SwapLedgerEntry {
  id: string;
  timestamp: string;
  from: string;
  to: string;
  amountIn: number;
  amountOutExpected: number;
  amountOutMin: number;
  slippageBps: number;
  txId: string | null;
  explorerUrl: string | null;
  status: "submitted" | "confirmed" | "failed" | "dry-run";
}

interface QuoteResult {
  from: string;
  to: string;
  amountIn: number;
  amountOut: number;
  amountOutMin: number;
  slippageBps: number;
  route: string[];
  priceImpact: number | null;
  quotedAt: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const HIRO_API = "https://api.mainnet.hiro.so";

const TOKEN_CONTRACTS: Record<string, string> = {
  STX: "native",
  sBTC: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token",
  ALEX: "SP102V8P0F7JX67ARQ77WEA3D3CFB5XW39REDT0AM.token-alex",
  stSTX: "SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG.ststx-token",
  USDA: "SP2C2YFP12AJZB1KD5YNY1F2D9RKXZQNSR7MZBPGG.usda-token",
};

const TOKEN_DECIMALS: Record<string, number> = {
  STX: 6,
  sBTC: 8,
  ALEX: 8,
  stSTX: 6,
  USDA: 6,
};

/** Default safety limits */
const DEFAULTS = {
  SLIPPAGE_BPS: 100, // 1%
  MAX_SLIPPAGE_BPS: 500, // 5% hard ceiling
  SPEND_CAP_USTX: 500_000, // 0.5 STX
  GAS_CAP_STX: 10,
  COOLDOWN_MS: 5 * 60 * 1000, // 5 minutes
  QUOTE_STALENESS_MS: 30_000, // 30 seconds
  POLL_INTERVAL_MS: 15_000, // price poll for auto mode
};

const LEDGER_DIR = path.join(
  process.env.HOME || "/tmp",
  ".alex-swap-executor"
);
const LEDGER_FILE = path.join(LEDGER_DIR, "swap-ledger.json");
const COOLDOWN_FILE = path.join(LEDGER_DIR, "cooldown-state.json");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function output(
  status: OutputEnvelope["status"],
  action: string,
  data: any,
  error: any = null
): void {
  const envelope: OutputEnvelope = {
    status,
    action,
    data,
    error: error ? String(error) : null,
  };
  console.log(JSON.stringify(envelope));
}

function resolveToken(symbol: string): string {
  const upper = symbol.toUpperCase();
  const mapped = TOKEN_CONTRACTS[upper] ?? TOKEN_CONTRACTS[symbol];
  if (!mapped) {
    throw new Error(
      `Unknown token "${symbol}". Supported: ${Object.keys(TOKEN_CONTRACTS).join(", ")}`
    );
  }
  return upper;
}

function toBaseUnits(amount: number, symbol: string): number {
  const decimals = TOKEN_DECIMALS[symbol] ?? 6;
  return Math.floor(amount * 10 ** decimals);
}

function fromBaseUnits(amount: number, symbol: string): number {
  const decimals = TOKEN_DECIMALS[symbol] ?? 6;
  return amount / 10 ** decimals;
}

function ensureLedgerDir(): void {
  if (!fs.existsSync(LEDGER_DIR)) {
    fs.mkdirSync(LEDGER_DIR, { recursive: true });
  }
}

function readLedger(): SwapLedgerEntry[] {
  ensureLedgerDir();
  if (!fs.existsSync(LEDGER_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(LEDGER_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function writeLedger(entries: SwapLedgerEntry[]): void {
  ensureLedgerDir();
  fs.writeFileSync(LEDGER_FILE, JSON.stringify(entries, null, 2));
}

function appendLedger(entry: SwapLedgerEntry): void {
  const entries = readLedger();
  entries.push(entry);
  writeLedger(entries);
}

function readCooldowns(): Record<string, number> {
  ensureLedgerDir();
  if (!fs.existsSync(COOLDOWN_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(COOLDOWN_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function writeCooldown(pair: string): void {
  const cds = readCooldowns();
  cds[pair] = Date.now();
  ensureLedgerDir();
  fs.writeFileSync(COOLDOWN_FILE, JSON.stringify(cds, null, 2));
}

function checkCooldown(from: string, to: string): void {
  const pair = `${from}-${to}`;
  const cds = readCooldowns();
  const last = cds[pair] || 0;
  const elapsed = Date.now() - last;
  if (elapsed < DEFAULTS.COOLDOWN_MS) {
    const remaining = Math.ceil((DEFAULTS.COOLDOWN_MS - elapsed) / 1000);
    throw new Error(
      `Cooldown active for ${pair}. ${remaining}s remaining. Min interval: ${DEFAULTS.COOLDOWN_MS / 1000}s`
    );
  }
}

function checkQuoteStaleness(quotedAt: string): void {
  const age = Date.now() - new Date(quotedAt).getTime();
  if (age > DEFAULTS.QUOTE_STALENESS_MS) {
    throw new Error(
      `Quote is stale (${Math.round(age / 1000)}s old). Max allowed: ${DEFAULTS.QUOTE_STALENESS_MS / 1000}s. Re-fetch quote.`
    );
  }
}

function generateId(): string {
  return `swap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function fetchJson(url: string): Promise<any> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} from ${url}`);
  return resp.json();
}

async function getStxBalance(address: string): Promise<number> {
  const data = await fetchJson(`${HIRO_API}/extended/v1/address/${address}/stx`);
  return Number(data.balance || 0);
}

async function getFtBalances(
  address: string
): Promise<Record<string, number>> {
  const data = await fetchJson(
    `${HIRO_API}/extended/v1/address/${address}/balances`
  );
  const result: Record<string, number> = {};
  result["STX"] = Number(data.stx?.balance || 0);
  const ftMap = data.fungible_tokens || {};
  for (const [contractId, info] of Object.entries(ftMap) as any) {
    for (const [sym, principal] of Object.entries(TOKEN_CONTRACTS)) {
      if (sym === "STX") continue;
      if (contractId.startsWith(principal)) {
        result[sym] = Number(info.balance || 0);
      }
    }
  }
  return result;
}

// ─── Core service wrappers ────────────────────────────────────────────────────

async function getQuote(
  from: string,
  to: string,
  amount: number,
  slippageBps: number
): Promise<QuoteResult> {
  const alexDex = getAlexDexService();
  const baseAmount = toBaseUnits(amount, from);

  // Attempt to get a quote from ALEX DEX service
  const quoteResponse = await alexDex.getSwapQuote({
    tokenIn: TOKEN_CONTRACTS[from] === "native" ? "STX" : TOKEN_CONTRACTS[from],
    tokenOut: TOKEN_CONTRACTS[to] === "native" ? "STX" : TOKEN_CONTRACTS[to],
    amount: baseAmount,
  });

  const amountOut = Number(quoteResponse.amountOut ?? quoteResponse.expectedOutput ?? 0);
  const amountOutMin = Math.floor(amountOut * (1 - slippageBps / 10_000));
  const route: string[] = quoteResponse.route ?? [from, to];
  const priceImpact = quoteResponse.priceImpact ?? null;

  return {
    from,
    to,
    amountIn: amount,
    amountOut: fromBaseUnits(amountOut, to),
    amountOutMin: fromBaseUnits(amountOutMin, to),
    slippageBps,
    route,
    priceImpact: priceImpact ? Number(priceImpact) : null,
    quotedAt: new Date().toISOString(),
  };
}

async function executeSwap(
  from: string,
  to: string,
  amount: number,
  slippageBps: number,
  spendCapUstx: number,
  gasCapStx: number
): Promise<{ txId: string; explorerUrl: string; quote: QuoteResult }> {
  // Safety: spend cap
  if (from === "STX") {
    const baseAmount = toBaseUnits(amount, "STX");
    if (baseAmount > spendCapUstx) {
      throw new Error(
        `Spend cap exceeded: ${baseAmount} uSTX > cap ${spendCapUstx} uSTX. Raise --spend-cap or reduce --amount.`
      );
    }
  }

  // Safety: slippage ceiling
  if (slippageBps > DEFAULTS.MAX_SLIPPAGE_BPS) {
    throw new Error(
      `Slippage ${slippageBps} bps exceeds hard ceiling ${DEFAULTS.MAX_SLIPPAGE_BPS} bps.`
    );
  }

  // Safety: cooldown
  checkCooldown(from, to);

  // Get fresh quote
  const quote = await getQuote(from, to, amount, slippageBps);

  // Safety: check quote is fresh
  checkQuoteStaleness(quote.quotedAt);

  const alexDex = getAlexDexService();
  const walletMgr = getWalletManager();

  const baseAmount = toBaseUnits(amount, from);
  const baseAmountOutMin = toBaseUnits(quote.amountOutMin, to);

  // Execute the swap via ALEX DEX service
  const swapResult = await alexDex.executeSwap({
    tokenIn: TOKEN_CONTRACTS[from] === "native" ? "STX" : TOKEN_CONTRACTS[from],
    tokenOut: TOKEN_CONTRACTS[to] === "native" ? "STX" : TOKEN_CONTRACTS[to],
    amount: baseAmount,
    minAmountOut: baseAmountOutMin,
    senderKey: walletMgr.getPrivateKey(),
    fee: toBaseUnits(gasCapStx, "STX"),
  });

  const txId = swapResult.txId ?? swapResult.txid ?? swapResult.transactionId ?? "";
  const explorerUrl = getExplorerTxUrl(txId);

  // Record cooldown
  writeCooldown(from, to);

  return { txId, explorerUrl, quote };
}

// ─── CLI Commands ─────────────────────────────────────────────────────────────

const program = new Command();

program
  .name("alex-swap-executor")
  .description(
    "ALEX DEX swap executor for Stacks — quote, execute, monitor, and log token swaps"
  )
  .version("1.0.0");

// ── doctor ────────────────────────────────────────────────────────────────────
program
  .command("doctor")
  .description("Check wallet, ALEX API connectivity, MCP tools, and token balances")
  .action(async () => {
    const checks: Record<string, { ok: boolean; detail: string }> = {};

    // 1. Wallet
    try {
      const wm = getWalletManager();
      const addr = wm.getAddress();
      checks.wallet = { ok: true, detail: `Address: ${addr}` };
    } catch (e: any) {
      checks.wallet = { ok: false, detail: e.message };
    }

    // 2. Hiro API
    try {
      const info = await fetchJson(`${HIRO_API}/v2/info`);
      checks.hiro_api = {
        ok: true,
        detail: `Block height: ${info.stacks_tip_height}`,
      };
    } catch (e: any) {
      checks.hiro_api = { ok: false, detail: e.message };
    }

    // 3. ALEX DEX service
    try {
      const alexDex = getAlexDexService();
      checks.alex_dex_service = {
        ok: !!alexDex,
        detail: alexDex ? "Service loaded" : "Service is null",
      };
    } catch (e: any) {
      checks.alex_dex_service = { ok: false, detail: e.message };
    }

    // 4. Token balances
    try {
      const wm = getWalletManager();
      const addr = wm.getAddress();
      const bals = await getFtBalances(addr);
      const formatted: Record<string, string> = {};
      for (const [sym, raw] of Object.entries(bals)) {
        formatted[sym] = `${fromBaseUnits(raw, sym)} ${sym}`;
      }
      checks.token_balances = { ok: true, detail: JSON.stringify(formatted) };
    } catch (e: any) {
      checks.token_balances = { ok: false, detail: e.message };
    }

    // 5. Ledger directory
    try {
      ensureLedgerDir();
      const ledger = readLedger();
      checks.ledger = {
        ok: true,
        detail: `${ledger.length} entries in ${LEDGER_FILE}`,
      };
    } catch (e: any) {
      checks.ledger = { ok: false, detail: e.message };
    }

    const allOk = Object.values(checks).every((c) => c.ok);
    output(allOk ? "ok" : "warn", "doctor", {
      checks,
      supported_tokens: Object.keys(TOKEN_CONTRACTS),
      safety_defaults: {
        slippage_bps: DEFAULTS.SLIPPAGE_BPS,
        max_slippage_bps: DEFAULTS.MAX_SLIPPAGE_BPS,
        spend_cap_ustx: DEFAULTS.SPEND_CAP_USTX,
        gas_cap_stx: DEFAULTS.GAS_CAP_STX,
        cooldown_seconds: DEFAULTS.COOLDOWN_MS / 1000,
        quote_staleness_seconds: DEFAULTS.QUOTE_STALENESS_MS / 1000,
      },
    });
  });

// ── status ────────────────────────────────────────────────────────────────────
program
  .command("status")
  .description("Show wallet balances and ALEX pool stats")
  .action(async () => {
    try {
      const wm = getWalletManager();
      const addr = wm.getAddress();
      const bals = await getFtBalances(addr);

      const formatted: Record<string, { raw: number; display: number }> = {};
      for (const sym of Object.keys(TOKEN_CONTRACTS)) {
        const raw = bals[sym] ?? 0;
        formatted[sym] = { raw, display: fromBaseUnits(raw, sym) };
      }

      // Attempt to get pool stats from ALEX
      let poolStats: any = null;
      try {
        const alexDex = getAlexDexService();
        const pools = await alexDex.getPoolStats?.();
        poolStats = pools ?? "Pool stats not available via current service API";
      } catch {
        poolStats = "Could not fetch pool stats";
      }

      // Cooldown state
      const cooldowns = readCooldowns();
      const activeCooldowns: Record<string, string> = {};
      const now = Date.now();
      for (const [pair, ts] of Object.entries(cooldowns)) {
        const remaining = DEFAULTS.COOLDOWN_MS - (now - ts);
        if (remaining > 0) {
          activeCooldowns[pair] = `${Math.ceil(remaining / 1000)}s remaining`;
        }
      }

      // Recent swaps
      const ledger = readLedger();
      const recentSwaps = ledger.slice(-5).reverse();

      output("ok", "status", {
        address: addr,
        balances: formatted,
        pool_stats: poolStats,
        active_cooldowns: activeCooldowns,
        recent_swaps_count: ledger.length,
        last_5_swaps: recentSwaps,
      });
    } catch (e: any) {
      output("error", "status", null, e.message);
    }
  });

// ── quote ─────────────────────────────────────────────────────────────────────
program
  .command("quote")
  .description("Get a swap quote with route and price impact")
  .requiredOption("--from <token>", "Source token symbol (e.g. STX)")
  .requiredOption("--to <token>", "Destination token symbol (e.g. sBTC)")
  .requiredOption("--amount <number>", "Amount of source token (display units)", parseFloat)
  .addOption(
    new Option("--slippage <bps>", "Slippage tolerance in basis points")
      .default(DEFAULTS.SLIPPAGE_BPS)
      .argParser(parseInt)
  )
  .action(async (opts) => {
    try {
      const from = resolveToken(opts.from);
      const to = resolveToken(opts.to);

      if (from === to) throw new Error("Source and destination tokens must differ");
      if (opts.amount <= 0) throw new Error("Amount must be positive");
      if (opts.slippage > DEFAULTS.MAX_SLIPPAGE_BPS) {
        throw new Error(
          `Slippage ${opts.slippage} bps exceeds hard ceiling ${DEFAULTS.MAX_SLIPPAGE_BPS} bps`
        );
      }

      const quote = await getQuote(from, to, opts.amount, opts.slippage);

      const effectivePrice =
        quote.amountOut > 0 ? quote.amountIn / quote.amountOut : null;
      const inversePrice =
        quote.amountIn > 0 ? quote.amountOut / quote.amountIn : null;

      output("ok", "quote", {
        ...quote,
        effective_price: effectivePrice,
        inverse_price: inversePrice,
        spend_cap_ustx: DEFAULTS.SPEND_CAP_USTX,
        gas_cap_stx: DEFAULTS.GAS_CAP_STX,
        hint: "Add --confirm to the swap command to execute. Quote valid for 30s.",
      });
    } catch (e: any) {
      output("error", "quote", null, e.message);
    }
  });

// ── swap ──────────────────────────────────────────────────────────────────────
program
  .command("swap")
  .description("Execute a swap on ALEX DEX")
  .requiredOption("--from <token>", "Source token symbol")
  .requiredOption("--to <token>", "Destination token symbol")
  .requiredOption("--amount <number>", "Amount of source token (display units)", parseFloat)
  .addOption(
    new Option("--slippage <bps>", "Slippage tolerance in bps")
      .default(DEFAULTS.SLIPPAGE_BPS)
      .argParser(parseInt)
  )
  .addOption(
    new Option("--spend-cap <ustx>", "Max spend in uSTX (for STX sells)")
      .default(DEFAULTS.SPEND_CAP_USTX)
      .argParser(parseInt)
  )
  .addOption(
    new Option("--gas-cap <stx>", "Max gas fee in STX")
      .default(DEFAULTS.GAS_CAP_STX)
      .argParser(parseFloat)
  )
  .option("--confirm", "Actually broadcast the transaction (dry-run without this)")
  .action(async (opts) => {
    try {
      const from = resolveToken(opts.from);
      const to = resolveToken(opts.to);

      if (from === to) throw new Error("Source and destination tokens must differ");
      if (opts.amount <= 0) throw new Error("Amount must be positive");

      // Without --confirm, do a dry run (quote only)
      if (!opts.confirm) {
        const quote = await getQuote(from, to, opts.amount, opts.slippage);

        const entry: SwapLedgerEntry = {
          id: generateId(),
          timestamp: new Date().toISOString(),
          from,
          to,
          amountIn: opts.amount,
          amountOutExpected: quote.amountOut,
          amountOutMin: quote.amountOutMin,
          slippageBps: opts.slippage,
          txId: null,
          explorerUrl: null,
          status: "dry-run",
        };
        appendLedger(entry);

        output("warn", "swap", {
          mode: "dry-run",
          quote,
          ledger_entry: entry,
          hint: "Add --confirm to broadcast. This was a dry run.",
          safety: {
            slippage_bps: opts.slippage,
            spend_cap_ustx: opts.spendCap,
            gas_cap_stx: opts.gasCap,
          },
        });
        return;
      }

      // Live execution
      const { txId, explorerUrl, quote } = await executeSwap(
        from,
        to,
        opts.amount,
        opts.slippage,
        opts.spendCap,
        opts.gasCap
      );

      const entry: SwapLedgerEntry = {
        id: generateId(),
        timestamp: new Date().toISOString(),
        from,
        to,
        amountIn: opts.amount,
        amountOutExpected: quote.amountOut,
        amountOutMin: quote.amountOutMin,
        slippageBps: opts.slippage,
        txId,
        explorerUrl,
        status: "submitted",
      };
      appendLedger(entry);

      output("ok", "swap", {
        mode: "live",
        tx_id: txId,
        explorer_url: explorerUrl,
        quote,
        ledger_entry: entry,
        safety: {
          slippage_bps: opts.slippage,
          spend_cap_ustx: opts.spendCap,
          gas_cap_stx: opts.gasCap,
        },
      });
    } catch (e: any) {
      output("error", "swap", null, e.message);
    }
  });

// ── auto ──────────────────────────────────────────────────────────────────────
program
  .command("auto")
  .description("Monitor price and execute swap when target is reached")
  .requiredOption("--from <token>", "Source token symbol")
  .requiredOption("--to <token>", "Destination token symbol")
  .requiredOption(
    "--target-price <number>",
    "Target price (units of from per 1 unit of to)",
    parseFloat
  )
  .requiredOption("--amount <number>", "Amount of source token (display units)", parseFloat)
  .addOption(
    new Option("--slippage <bps>", "Slippage tolerance in bps")
      .default(DEFAULTS.SLIPPAGE_BPS)
      .argParser(parseInt)
  )
  .addOption(
    new Option("--spend-cap <ustx>", "Max spend in uSTX")
      .default(DEFAULTS.SPEND_CAP_USTX)
      .argParser(parseInt)
  )
  .addOption(
    new Option("--gas-cap <stx>", "Max gas fee in STX")
      .default(DEFAULTS.GAS_CAP_STX)
      .argParser(parseFloat)
  )
  .addOption(
    new Option("--max-checks <n>", "Max price checks before giving up")
      .default(60)
      .argParser(parseInt)
  )
  .option("--confirm", "Actually execute when target is hit")
  .action(async (opts) => {
    try {
      const from = resolveToken(opts.from);
      const to = resolveToken(opts.to);

      if (from === to) throw new Error("Source and destination tokens must differ");
      if (opts.amount <= 0) throw new Error("Amount must be positive");
      if (opts.targetPrice <= 0) throw new Error("Target price must be positive");

      let checks = 0;
      const maxChecks: number = opts.maxChecks;

      output("ok", "auto", {
        mode: opts.confirm ? "armed" : "dry-run",
        from,
        to,
        target_price: opts.targetPrice,
        amount: opts.amount,
        max_checks: maxChecks,
        poll_interval_ms: DEFAULTS.POLL_INTERVAL_MS,
        hint: opts.confirm
          ? "Monitoring. Will execute when target price is reached."
          : "Monitoring in dry-run mode. Add --confirm to auto-execute.",
      });

      while (checks < maxChecks) {
        checks++;

        try {
          const quote = await getQuote(from, to, opts.amount, opts.slippage);
          const currentPrice =
            quote.amountOut > 0 ? quote.amountIn / quote.amountOut : Infinity;

          output("ok", "auto:poll", {
            check_number: checks,
            current_price: currentPrice,
            target_price: opts.targetPrice,
            amount_out: quote.amountOut,
            price_met: currentPrice <= opts.targetPrice,
          });

          // Target met: price of `from` per unit of `to` is at or below target
          if (currentPrice <= opts.targetPrice) {
            if (!opts.confirm) {
              output("warn", "auto:trigger", {
                message: "Target price reached but --confirm not set. Dry run only.",
                quote,
              });
              return;
            }

            // Execute swap
            const { txId, explorerUrl, quote: freshQuote } = await executeSwap(
              from,
              to,
              opts.amount,
              opts.slippage,
              opts.spendCap,
              opts.gasCap
            );

            const entry: SwapLedgerEntry = {
              id: generateId(),
              timestamp: new Date().toISOString(),
              from,
              to,
              amountIn: opts.amount,
              amountOutExpected: freshQuote.amountOut,
              amountOutMin: freshQuote.amountOutMin,
              slippageBps: opts.slippage,
              txId,
              explorerUrl,
              status: "submitted",
            };
            appendLedger(entry);

            output("ok", "auto:executed", {
              tx_id: txId,
              explorer_url: explorerUrl,
              quote: freshQuote,
              ledger_entry: entry,
              checks_taken: checks,
            });
            return;
          }
        } catch (pollErr: any) {
          output("warn", "auto:poll-error", {
            check_number: checks,
            error: pollErr.message,
          });
        }

        // Wait before next check
        await new Promise((resolve) =>
          setTimeout(resolve, DEFAULTS.POLL_INTERVAL_MS)
        );
      }

      output("warn", "auto:timeout", {
        message: `Target price not reached after ${maxChecks} checks.`,
        checks_taken: checks,
      });
    } catch (e: any) {
      output("error", "auto", null, e.message);
    }
  });

// ── history ───────────────────────────────────────────────────────────────────
program
  .command("history")
  .description("Show past swaps from local ledger")
  .option("--limit <n>", "Number of entries to show", parseInt, 20)
  .option("--pair <pair>", 'Filter by pair (e.g. "STX-sBTC")')
  .option("--status <status>", "Filter by status")
  .action(async (opts) => {
    try {
      let entries = readLedger();

      if (opts.pair) {
        const [f, t] = opts.pair.split("-");
        entries = entries.filter(
          (e) =>
            e.from.toUpperCase() === f?.toUpperCase() &&
            e.to.toUpperCase() === t?.toUpperCase()
        );
      }

      if (opts.status) {
        entries = entries.filter((e) => e.status === opts.status);
      }

      const total = entries.length;
      const shown = entries.slice(-opts.limit).reverse();

      // Aggregates
      const pairCounts: Record<string, number> = {};
      const statusCounts: Record<string, number> = {};
      for (const e of entries) {
        const pair = `${e.from}-${e.to}`;
        pairCounts[pair] = (pairCounts[pair] || 0) + 1;
        statusCounts[e.status] = (statusCounts[e.status] || 0) + 1;
      }

      output("ok", "history", {
        total_entries: total,
        showing: shown.length,
        filters: {
          pair: opts.pair ?? "all",
          status: opts.status ?? "all",
          limit: opts.limit,
        },
        aggregates: { by_pair: pairCounts, by_status: statusCounts },
        entries: shown,
        ledger_path: LEDGER_FILE,
      });
    } catch (e: any) {
      output("error", "history", null, e.message);
    }
  });

// ── Parse ─────────────────────────────────────────────────────────────────────
program.parse();

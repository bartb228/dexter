import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { formatToolResult } from '../types.js';
import { logger } from '../../utils/logger.js';

/**
 * Bridge to the local Kronos K-line foundation model (a separate Python project).
 * Spawns `python3 predict_json.py <TICKER>` in the Kronos project dir and returns
 * its JSON forecast. Kronos is PyTorch/Python, so we cross the boundary via a
 * subprocess rather than reimplementing the model in TS.
 *
 * Safety: the subprocess is launched with an ARGS ARRAY (no shell), the ticker is
 * validated to a strict charset, and the command/cwd are fixed config — no
 * user-controlled string is ever interpolated into a shell.
 */
const KRONOS_DIR = process.env.KRONOS_DIR || '/Users/Ambartsum/code/Kronos';
const KRONOS_PYTHON = process.env.KRONOS_PYTHON || 'python3';
const KRONOS_SCRIPT = 'predict_json.py';
const KRONOS_TIMEOUT_MS = 180_000; // cold start (~10s model load) + sampling
const MAX_BUF = 2 * 1024 * 1024; // cap captured stdout/stderr (PyTorch can be chatty on stderr)
const TICKER_RE = /^[A-Za-z0-9.\-]{1,15}$/;

/** True when the Kronos project + JSON wrapper are present locally. */
export function kronosAvailable(): boolean {
  return existsSync(join(KRONOS_DIR, KRONOS_SCRIPT));
}

interface ProcResult { ok: boolean; stdout: string; stderr: string; code: number | null }

function runKronos(args: string[]): Promise<ProcResult> {
  return new Promise((resolve) => {
    // Array args + no `shell` option => arguments cannot be interpreted by a shell.
    const child = spawn(KRONOS_PYTHON, [KRONOS_SCRIPT, ...args], { cwd: KRONOS_DIR });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), KRONOS_TIMEOUT_MS);
    // Keep the TAIL — the JSON object is the last line, so cap from the front.
    child.stdout.on('data', (d) => { stdout += d.toString(); if (stdout.length > MAX_BUF) stdout = stdout.slice(-MAX_BUF); });
    child.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > MAX_BUF) stderr = stderr.slice(-MAX_BUF); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, stdout, stderr: String(e), code: null }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, stdout, stderr, code }); });
  });
}

/** Parse the last non-empty stdout line as JSON (the wrapper prints one JSON object). */
function parseLastJson(stdout: string): Record<string, unknown> | null {
  const line = stdout.trim().split('\n').filter(Boolean).pop();
  if (!line) return null;
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export const KRONOS_PREDICT_DESCRIPTION = `
Forecasts a stock/crypto asset's near-term price path using Kronos, a local
foundation model for financial candlesticks (K-lines). Returns predicted OHLCV
bars plus the expected percent change and direction.

## When to Use

- The user asks for a price prediction / forecast / "where is X headed".
- You want a model-based directional signal for an asset to complement fundamentals.

## When NOT to Use

- Historical or current prices (use get_market_data).
- Fundamentals, ratios, filings (use get_financials / get_key_ratios / read_filings).

## Notes

- Works for ANY US-listed stock/ETF ticker (auto-fetched on demand) plus major crypto
  pairs like BTCUSDT/ETHUSDT. Common examples: NVDA, AAPL, MSFT, TSLA, SPY, QQQ.
- Output is a probabilistic statistical forecast, NOT investment advice — say so.
- A single call can take ~10-30s (model load + sampling; first use of a new ticker
  also downloads its history).
`.trim();

const KronosInputSchema = z.object({
  ticker: z
    .string()
    .describe('Asset to forecast — any US-listed stock/ETF symbol (e.g. NVDA, GOOGL, AMZN) or a crypto pair (e.g. BTCUSDT). Auto-fetched on demand.'),
  horizon: z
    .number()
    .int()
    .min(1)
    .max(64)
    .optional()
    .describe('Number of future bars to forecast (default ~12 for the 1h model).'),
});

export const kronosPredict = new DynamicStructuredTool({
  name: 'kronos_predict',
  description:
    'Forecast an asset\'s near-term price path with the local Kronos K-line foundation model. Returns predicted OHLCV candles, expected % change, and direction. Works for any US-listed stock/ETF (e.g. NVDA, GOOGL, AMZN) or major crypto pair (e.g. BTCUSDT). Output is a statistical forecast, not investment advice.',
  schema: KronosInputSchema,
  func: async (input) => {
    const ticker = input.ticker.trim().toUpperCase();
    if (!TICKER_RE.test(ticker)) {
      return formatToolResult({ error: `Invalid ticker '${input.ticker}'. Use a plain symbol like NVDA.` }, []);
    }
    if (!kronosAvailable()) {
      return formatToolResult(
        { error: `Kronos not found at ${KRONOS_DIR}. Set KRONOS_DIR to the Kronos project path.` },
        [],
      );
    }

    const args = [ticker];
    if (input.horizon) args.push('--horizon', String(input.horizon));

    const r = await runKronos(args);
    const parsed = parseLastJson(r.stdout);

    if (parsed && typeof parsed.error === 'string') {
      logger.warn(`[Kronos] ${parsed.error}`);
      return formatToolResult({ error: parsed.error }, []);
    }
    if (!r.ok || !parsed) {
      logger.warn(`[Kronos] failed (exit ${r.code}): ${(r.stderr || '').slice(-300)}`);
      return formatToolResult(
        { error: `Kronos prediction failed${r.code !== null ? ` (exit ${r.code})` : ''}.`, detail: (r.stderr || r.stdout).slice(-300) },
        [],
      );
    }
    return formatToolResult(parsed, ['Kronos K-line foundation model (local, NeoQuasar/Kronos-small)']);
  },
});

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { formatToolResult } from '../types.js';
import { logger } from '../../utils/logger.js';

/**
 * Bridge to ai-hedge-fund's pure-compute quant analysts (a separate Python project).
 * Spawns `quant_signals_json.py <TICKER>`, which runs the Mohanram G-Score, Beneish
 * M-Score, and quality-factor agents directly — NO LLM, no portfolio manager — and
 * returns their signals as JSON.
 *
 * Safety: launched with an ARGS ARRAY (no shell); ticker validated to a strict
 * charset; command/cwd are fixed config — no user string reaches a shell.
 */
const AHF_DIR = process.env.AHF_DIR || '/Users/Ambartsum/code/ai-hedge-fund';
const AHF_PYTHON = process.env.AHF_PYTHON || join(AHF_DIR, '.venv/bin/python');
const AHF_SCRIPT = 'quant_signals_json.py';
const TIMEOUT_MS = 150_000; // python import of the ai-hedge-fund stack + 3 agents
const MAX_BUF = 2 * 1024 * 1024;
const TICKER_RE = /^[A-Za-z0-9.\-]{1,15}$/;

/** True when the ai-hedge-fund project + quant wrapper are present locally. */
export function quantSignalsAvailable(): boolean {
  return existsSync(join(AHF_DIR, AHF_SCRIPT));
}

interface ProcResult { ok: boolean; stdout: string; stderr: string; code: number | null }

function runWrapper(args: string[]): Promise<ProcResult> {
  return new Promise((resolve) => {
    const child = spawn(AHF_PYTHON, [AHF_SCRIPT, ...args], { cwd: AHF_DIR });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
    // Keep the TAIL — the JSON object is the last line, so cap from the front.
    child.stdout.on('data', (d) => { stdout += d.toString(); if (stdout.length > MAX_BUF) stdout = stdout.slice(-MAX_BUF); });
    child.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > MAX_BUF) stderr = stderr.slice(-MAX_BUF); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, stdout, stderr: String(e), code: null }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, stdout, stderr, code }); });
  });
}

function parseLastJson(stdout: string): Record<string, unknown> | null {
  const line = stdout.trim().split('\n').filter(Boolean).pop();
  if (!line) return null;
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export const QUANT_SIGNALS_DESCRIPTION = `
Computes three deterministic quant signals for a stock from its SEC fundamentals
(no LLM, no opinion — pure formulas):

- **Mohanram G-Score** — financial-strength score (profitability, stability, conservatism).
- **Beneish M-Score** — earnings-manipulation risk (a "flag" means elevated risk).
- **Quality factors** — Novy-Marx gross profitability, net dilution, Rule of 40,
  operating leverage, margin expansion, low accruals.

## When to Use

- Assessing a company's financial quality, strength, or earnings-manipulation risk.
- A fast, objective scorecard to complement narrative analysis or price forecasts.

## When NOT to Use

- Prices/news (use get_market_data), raw statements (use get_financials), price
  forecasts (use kronos_predict).

## Notes

- Deterministic and fast (no LLM). Values come from the same engine as the ai-hedge-fund
  analysts. Not investment advice.
`.trim();

const QuantSignalsInputSchema = z.object({
  ticker: z.string().describe('Stock ticker to score, e.g. NVDA, AAPL.'),
  end_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD')
    .optional()
    .describe('As-of date YYYY-MM-DD (default: latest available).'),
});

export const quantSignals = new DynamicStructuredTool({
  name: 'quant_signals',
  description:
    'Compute deterministic quant signals for a stock from SEC fundamentals (no LLM): Mohanram G-Score (financial strength), Beneish M-Score (earnings-manipulation risk), and quality factors (gross profitability, Rule of 40, net dilution, accruals, etc.). Fast, objective scorecard; not investment advice.',
  schema: QuantSignalsInputSchema,
  func: async (input) => {
    const ticker = input.ticker.trim().toUpperCase();
    if (!TICKER_RE.test(ticker)) {
      return formatToolResult({ error: `Invalid ticker '${input.ticker}'. Use a plain symbol like NVDA.` }, []);
    }
    if (!quantSignalsAvailable()) {
      return formatToolResult(
        { error: `ai-hedge-fund quant bridge not found at ${AHF_DIR}. Set AHF_DIR to the ai-hedge-fund project path.` },
        [],
      );
    }

    const args = [ticker];
    if (input.end_date) args.push('--end-date', input.end_date);

    const r = await runWrapper(args);
    const parsed = parseLastJson(r.stdout);

    if (parsed && typeof parsed.error === 'string') {
      logger.warn(`[QuantSignals] ${parsed.error}`);
      return formatToolResult({ error: parsed.error }, []);
    }
    if (!r.ok || !parsed) {
      logger.warn(`[QuantSignals] failed (exit ${r.code}): ${(r.stderr || '').slice(-300)}`);
      return formatToolResult(
        { error: `Quant signals failed${r.code !== null ? ` (exit ${r.code})` : ''}.`, detail: (r.stderr || r.stdout).slice(-300) },
        [],
      );
    }
    return formatToolResult(parsed, ['ai-hedge-fund quant analysts (Mohanram/Beneish/quality, from SEC fundamentals)']);
  },
});

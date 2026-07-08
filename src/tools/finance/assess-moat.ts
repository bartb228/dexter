import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { formatToolResult } from '../types.js';
import { logger } from '../../utils/logger.js';

/**
 * Bridge to the local ai-hedge-fund project's economic-MOAT analysis. Spawns
 * `moat_json.py <TICKER>` (Warren-Buffett `analyze_moat` + Charlie-Munger
 * `analyze_moat_strength`) and returns its JSON verdict. This is the qualitative
 * moat layer that complements run_quality_screen's quantitative gates: screen first,
 * then assess_moat the survivors.
 *
 * ai-hedge-fund needs Python 3.10+ — so we invoke its OWN .venv interpreter, not the
 * system python3. Safety: array args (no shell); ticker validated to a strict charset
 * (leading alphanumeric so it can't be spread into argv as a flag).
 */
const MOAT_DIR = process.env.AI_HEDGE_FUND_DIR || '/Users/Ambartsum/code/ai-hedge-fund';
const MOAT_PYTHON = process.env.AI_HEDGE_FUND_PYTHON || join(MOAT_DIR, '.venv/bin/python');
const MOAT_SCRIPT = 'moat_json.py';
const MOAT_TIMEOUT_MS = 120_000; // data fetch (EDGAR/financialdatasets) + analysis
const MAX_BUF = 1 * 1024 * 1024;
const TICKER_RE = /^[A-Za-z0-9][A-Za-z0-9.\-]{0,14}$/;

/** True when the local ai-hedge-fund project + its venv interpreter are present. */
export function assessMoatAvailable(): boolean {
  return existsSync(join(MOAT_DIR, MOAT_SCRIPT)) && existsSync(MOAT_PYTHON);
}

interface ProcResult { ok: boolean; stdout: string; stderr: string; code: number | null }

function runMoat(args: string[]): Promise<ProcResult> {
  return new Promise((resolve) => {
    // Default to the FREE SEC-EDGAR data backend (consistent all-filer coverage, no paid
    // key — and it returns enough history for Buffett's ≥5-year analysis, unlike the
    // financialdatasets free tier). SEC mandates a User-Agent; supply a default if unset.
    // A user's explicit DATA_BACKEND / EDGAR_USER_AGENT still win.
    const child = spawn(MOAT_PYTHON, [MOAT_SCRIPT, ...args], {
      cwd: MOAT_DIR,
      env: {
        ...process.env,
        DATA_BACKEND: process.env.DATA_BACKEND || 'edgar',
        EDGAR_USER_AGENT: process.env.EDGAR_USER_AGENT || 'Dexter Research research@dexter.local',
      },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), MOAT_TIMEOUT_MS);
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

export const ASSESS_MOAT_DESCRIPTION = `
Assesses whether a company has a durable ECONOMIC MOAT (competitive advantage) using
Warren Buffett's and Charlie Munger's frameworks, and returns a wide / narrow / none
verdict with the reasoning.

## What it evaluates
- ROE / ROIC durability (consistently > 15% across years)
- Pricing power (stable / improving gross margins)
- Low capital intensity (capex as % of revenue)
- Intangibles: R&D investment, brand/goodwill

## When to Use
- The user asks whether a business "has a moat", is a "quality compounder", has "pricing
  power" or a "durable competitive advantage".
- As the SECOND step after run_quality_screen: screen the universe on the quantitative
  gates, then assess_moat each survivor for the qualitative moat verdict.

## When NOT to Use
- Bulk multi-criteria screening (use run_quality_screen).
- Raw ratios/statements (use get_key_ratios / get_financials).

## Notes
- One ticker per call. Needs the local ai-hedge-fund project + its data backend
  (financialdatasets key, or DATA_BACKEND=edgar for the free SEC path).
- The wide/narrow/none label is a heuristic blend of the two frameworks' scores; the
  per-framework details are the substance — always cite them. Not investment advice.
`.trim();

const AssessMoatInputSchema = z.object({
  ticker: z
    .string()
    .describe('Company ticker to assess for an economic moat, e.g. "AAPL", "V", "MSFT".'),
});

export const assessMoat = new DynamicStructuredTool({
  name: 'assess_moat',
  description:
    'Assess a company\'s ECONOMIC MOAT (durable competitive advantage) via Warren Buffett\'s + Charlie Munger\'s frameworks — ROE/ROIC durability, pricing power (gross-margin stability), capital intensity, R&D/intangibles — returning a wide/narrow/none verdict with reasoning. One ticker per call. Pair with run_quality_screen (screen first, then assess_moat the survivors).',
  schema: AssessMoatInputSchema,
  func: async (input) => {
    const ticker = input.ticker.trim().toUpperCase();
    if (!TICKER_RE.test(ticker)) {
      return formatToolResult({ error: `Invalid ticker '${input.ticker}'. Use a plain symbol like AAPL.` }, []);
    }
    if (!assessMoatAvailable()) {
      return formatToolResult(
        { error: `Moat engine not found (ai-hedge-fund at ${MOAT_DIR}, venv python at ${MOAT_PYTHON}). Set AI_HEDGE_FUND_DIR / AI_HEDGE_FUND_PYTHON.` },
        [],
      );
    }

    const r = await runMoat([ticker]);
    const parsed = parseLastJson(r.stdout);

    if (parsed && typeof parsed.error === 'string') {
      logger.warn(`[assess_moat] ${ticker}: ${parsed.error}`);
      return formatToolResult({ ticker, error: parsed.error }, []);
    }
    if (!r.ok || !parsed) {
      logger.warn(`[assess_moat] failed (exit ${r.code}): ${(r.stderr || '').slice(-300)}`);
      return formatToolResult(
        {
          error: `Moat assessment failed${r.code !== null ? ` (exit ${r.code})` : ''}.`,
          detail: (r.stderr || r.stdout).slice(-400),
        },
        [],
      );
    }
    return formatToolResult(parsed, [
      'ai-hedge-fund moat analysis — Warren Buffett analyze_moat + Charlie Munger analyze_moat_strength (ROIC durability, pricing power, capital intensity, intangibles)',
    ]);
  },
});

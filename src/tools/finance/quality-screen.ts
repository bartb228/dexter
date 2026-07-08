import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { formatToolResult } from '../types.js';
import { logger } from '../../utils/logger.js';

/**
 * Bridge to the local Stock-scanner project's DETERMINISTIC `quality_moat` screen.
 * Spawns `python3 scanner.py --profile quality_moat --json <tmp>` in the scanner dir
 * and returns the ranked shortlist it wrote. The 17-criteria quality gates live in
 * the Python engine (config.py `quality_moat` profile) — pinned there so this tool
 * runs a fixed, auditable screen rather than the LLM re-deciding thresholds per call.
 * The economic-MOAT verdict is a separate step (the assess_moat tool).
 *
 * Safety: launched with an ARGS ARRAY (no shell); tickers are validated to a strict
 * charset; the command/cwd are fixed config — no user string reaches a shell.
 */
const SCANNER_DIR = process.env.STOCK_SCANNER_DIR || '/Users/Ambartsum/code/Stock scanner/scanner';
const SCANNER_PYTHON = process.env.STOCK_SCANNER_PYTHON || 'python3';
const SCANNER_SCRIPT = 'scanner.py';
const SCAN_TIMEOUT_MS = 300_000; // a universe scan is minutes; a --symbols run is faster
const MAX_BUF = 1 * 1024 * 1024;
// Must START alphanumeric so a "symbol" can never be spread into argv as a flag
// (e.g. "--top" / "-rf") — argument-injection defense for the --symbols spread below.
const TICKER_RE = /^[A-Za-z0-9][A-Za-z0-9.\-]{0,14}$/;

/** True when the local Stock-scanner project is present. */
export function qualityScreenAvailable(): boolean {
  return existsSync(join(SCANNER_DIR, SCANNER_SCRIPT));
}

interface ProcResult { ok: boolean; stderr: string; code: number | null }

function runScanner(args: string[]): Promise<ProcResult> {
  return new Promise((resolve) => {
    // Array args + no `shell` option => arguments cannot be interpreted by a shell.
    const child = spawn(SCANNER_PYTHON, [SCANNER_SCRIPT, ...args], { cwd: SCANNER_DIR });
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), SCAN_TIMEOUT_MS);
    child.stdout.on('data', () => { /* JSON goes to a file; drain stdout to avoid backpressure */ });
    child.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > MAX_BUF) stderr = stderr.slice(-MAX_BUF); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, stderr: String(e), code: null }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, stderr, code }); });
  });
}

/** Screen-relevant fields surfaced to the model (present-if-available; keeps payload lean). */
const SELECT = [
  'symbol', 'company', 'name', 'sector', 'composite_score', 'roe', 'roic', 'debt_eq',
  'current_ratio', 'interest_coverage', 'peg_ratio', 'pe', 'rev_growth', 'eps_growth',
  'operating_margin', 'gross_margin', 'ev_ebitda', 'market_cap', 'best_fit_profile',
  'passing_profiles',
] as const;

export const RUN_QUALITY_SCREEN_DESCRIPTION = `
Runs a DETERMINISTIC quality-compounder / economic-moat stock screen and returns the
ranked shortlist that passes every gate. The gates are fixed in the Stock-scanner
engine (not re-decided per call):

  ROE ≥ 15%, ROIC ≥ 15%, Debt/Equity < 0.5, current ratio > 1.5,
  interest coverage > 10, PEG < 1.5, revenue growth > 8%, market cap > $10B
  (plus Piotroski / Mohanram quality + Beneish fraud screens).

## When to Use
- The user wants "high-quality businesses", "wide/narrow moat compounders", "Buffett-style
  quality at a reasonable price", or asks to screen the market by quality + valuation.

## When NOT to Use
- A single-metric lookup (use get_key_ratios / get_financials).
- The MOAT verdict itself (brand/network/switching-cost/pricing-power) — that's the
  companion assess_moat tool; run this screen first, then assess_moat on the survivors.

## Notes
- Pass \`symbols\` to screen specific tickers (fast). Omit to screen the scanner's
  default large-cap universe (slower — can take minutes).
- Requires the local Stock-scanner project + its Finnhub/Polygon keys; without keys it
  degrades to slower Yahoo data. Returns a clear error (not a crash) if the scan fails.
- Deterministic and auditable — the same inputs give the same shortlist.
`.trim();

const QualityScreenInputSchema = z.object({
  symbols: z
    .array(z.string())
    .optional()
    .describe('Specific tickers to screen, e.g. ["AAPL","MSFT","V"]. Omit to screen the scanner\'s default large-cap universe (slower).'),
  top: z
    .number().int().min(1).max(100)
    .optional()
    .describe('Max number of ranked picks to return (default 25).'),
  relaxed: z
    .boolean()
    .optional()
    .describe('Use the relaxed variant — loosens ONLY the liquidity gate (current ratio > 1.0 instead of > 1.5) to surface more cash-generative quality names; all other gates stay strict. Default false.'),
});

export const runQualityScreen = new DynamicStructuredTool({
  name: 'run_quality_screen',
  description:
    'Run the deterministic quality-moat stock screen (ROE≥15%, ROIC≥15%, D/E<0.5, current>1.5, interest-coverage>10, PEG<1.5, revenue-growth>8%, market-cap>$10B, + Piotroski/Mohanram/Beneish quality) and return the ranked shortlist that passed. Pass `symbols` to screen specific tickers, or omit for the default large-cap universe. The economic-moat verdict is a separate step — run assess_moat on the survivors.',
  schema: QualityScreenInputSchema,
  func: async (input) => {
    if (!qualityScreenAvailable()) {
      return formatToolResult(
        { error: `Stock scanner not found at ${SCANNER_DIR}. Set STOCK_SCANNER_DIR to the scanner project path.` },
        [],
      );
    }
    const symbols = (input.symbols ?? []).map((s) => s.trim().toUpperCase()).filter(Boolean);
    for (const s of symbols) {
      if (!TICKER_RE.test(s)) {
        return formatToolResult({ error: `Invalid ticker '${s}'. Use plain symbols like AAPL.` }, []);
      }
    }

    const profile = input.relaxed ? 'quality_moat_relaxed' : 'quality_moat';
    const outPath = join(tmpdir(), `qm_scan_${process.pid}_${Date.now()}.json`);
    const args = ['--profile', profile, '--json', outPath, '--top', String(input.top ?? 25)];
    if (symbols.length) args.push('--symbols', ...symbols);

    const r = await runScanner(args);

    let records: Array<Record<string, unknown>> = [];
    try {
      records = JSON.parse(readFileSync(outPath, 'utf-8')) as Array<Record<string, unknown>>;
    } catch {
      // file missing / unreadable — handled as failure or empty below
    } finally {
      try { rmSync(outPath, { force: true }); } catch { /* best-effort cleanup */ }
    }
    // A non-array payload (e.g. an {"error": ...} object, should the scanner ever emit
    // one) would make records.map() below throw OUTSIDE the try — coerce to [] so this
    // tool always returns a formatToolResult, never throws.
    if (!Array.isArray(records)) records = [];

    if (!r.ok && records.length === 0) {
      logger.warn(`[quality_screen] scan failed (exit ${r.code}): ${(r.stderr || '').slice(-300)}`);
      return formatToolResult(
        {
          error: `Quality screen failed${r.code !== null ? ` (exit ${r.code})` : ''}. The scanner needs Finnhub/Polygon keys in its .env for a full run.`,
          detail: (r.stderr || '').slice(-400),
        },
        [],
      );
    }

    const picks = records.map((rec) => {
      const out: Record<string, unknown> = {};
      for (const k of SELECT) {
        if (rec[k] !== undefined && rec[k] !== null) out[k] = rec[k];
      }
      return out;
    });

    return formatToolResult(
      {
        profile,
        screened: symbols.length ? symbols : 'default large-cap universe',
        passed: picks.length,
        picks,
      },
      ['Stock scanner — quality_moat deterministic gates (ROE/ROIC≥15%, D/E<0.5, current>1.5, interest-cov>10, PEG<1.5, rev>8%, mktcap>$10B). Economic-moat verdict is separate (assess_moat).'],
    );
  },
});

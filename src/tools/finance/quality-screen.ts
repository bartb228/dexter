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
// Prefer the scanner's own venv python when it exists: the cash-adjusted (operating) ROIC
// path (Plan 03-01) needs edgartools>=5, which requires Python>=3.10. System `python3` may be
// 3.9 (no edgartools) → cash enrichment is silently inert → no flip. Falling back to `python3`
// keeps the screen working (just without the operating-ROIC rescue). $STOCK_SCANNER_PYTHON wins.
const VENV_PYTHON = join(SCANNER_DIR, '.venv', 'bin', 'python');
const SCANNER_PYTHON = process.env.STOCK_SCANNER_PYTHON || (existsSync(VENV_PYTHON) ? VENV_PYTHON : 'python3');
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
  'symbol', 'company', 'name', 'sector', 'composite_score', 'roe', 'roic', 'roic_operating',
  'debt_eq', 'current_ratio', 'interest_coverage', 'peg_ratio', 'pe', 'rev_growth', 'eps_growth',
  'operating_margin', 'gross_margin', 'ev_ebitda', 'market_cap', 'best_fit_profile',
  'passing_profiles',
  // Plan 03-01: cash-adjusted ("operating") ROIC provenance. roic_operating nets cash +
  // short-term investments out of invested capital (rescues cash-rich compounders past the
  // ROIC gate); cash_verified/cash_verification record the SEC cross-source check of that
  // netting ("verified" | "unverified" | "mismatch:…"). Absent when EDGAR isn't wired.
  'cash_verified', 'cash_verification',
] as const;

/**
 * Per-gate rejection summary the scanner writes to `--rejections-json`. Attached to the
 * tool result so a 0-passers screen is SELF-EXPLAINING (which gates blocked how many
 * names, with sample reasons) rather than misread as a "backend limitation".
 *
 * Invariants (all counts are "how many names", so >= 0; samples capped at 8) are enforced
 * by {@link normalizeFailureSummary}, which is the ONLY sanctioned constructor — build
 * instances through it, never by hand, so the invariants hold. `readonly` guards against
 * post-construction mutation.
 */
export interface FailureSummary {
  readonly screened: number;
  readonly passed: number;
  readonly rejected: number;
  /** canonical gate → count of screened names blocked by it (>= 0; already sorted by the scanner). */
  readonly gate_tally: Readonly<Record<string, number>>;
  /** capped sample of per-name reasons (the scanner caps at 8; re-capped here defensively). */
  readonly samples: ReadonlyArray<Readonly<{ symbol: string; failures: readonly string[] }>>;
  /** Plan 03-02: "who almost passed" — rejected names ranked by (fewest gates, smallest
   * margin), scanner-ranked. A 1-gate near-miss (e.g. GOOGL, ROIC 0.143 vs 0.15) tops it. */
  readonly near_miss: ReadonlyArray<Readonly<{
    symbol: string;
    n_failed: number;
    margin: number;
    gates: ReadonlyArray<Readonly<{ gate: string; value: number | null; threshold: number | null }>>;
  }>>;
  /** Plan 03-03: per-gate "what-if" — how many names are SOLE-blocked by each gate (fail only
   * it) + the closest metric value that would admit one. Answers "what would get more passers?" */
  readonly sensitivity: Readonly<Record<string, Readonly<{
    sole_blockers: number;
    would_admit_at: number | null;
    threshold: number | null;
    examples: readonly string[];
  }>>>;
}

/**
 * Defensively coerce the scanner's rejections JSON into a {@link FailureSummary}.
 * Returns `undefined` for anything that is not a plain non-array object (missing file,
 * `null`, string, number, array) so the tool attaches nothing rather than throwing or
 * fabricating — preserving run_quality_screen's never-throw contract (Decision D6).
 * Numeric fields coerce to finite numbers (default 0); non-number gate_tally values are
 * dropped; samples are re-capped at 8.
 */
export function normalizeFailureSummary(raw: unknown): FailureSummary | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  // Counts are "how many names" — clamp to >= 0 so a garbled/adversarial file can never
  // hand the model a negative (nonsensical) count.
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, v) : 0);

  const gate_tally: Record<string, number> = {};
  const rawTally = obj.gate_tally;
  if (rawTally !== null && typeof rawTally === 'object' && !Array.isArray(rawTally)) {
    for (const [gate, count] of Object.entries(rawTally as Record<string, unknown>)) {
      // Drop non-number and negative tallies — a "names blocked" count is never < 0.
      if (typeof count === 'number' && Number.isFinite(count) && count >= 0) gate_tally[gate] = count;
    }
  }

  const rawSamples = Array.isArray(obj.samples) ? obj.samples : [];
  const samples = rawSamples
    // Keep only well-formed sample rows: a plain object WITH a real (non-empty string)
    // symbol. Non-objects AND malformed objects (missing/blank symbol) are dropped rather
    // than padding the reported list with blank {symbol:'',failures:[]} placeholders that
    // misrepresent the count.
    .filter((s): s is { symbol: string } & Record<string, unknown> =>
      s !== null && typeof s === 'object' && !Array.isArray(s)
      && typeof (s as Record<string, unknown>).symbol === 'string'
      && ((s as Record<string, unknown>).symbol as string).length > 0)
    .slice(0, 8)
    .map((so) => ({
      symbol: so.symbol,
      failures: Array.isArray(so.failures)
        ? so.failures.filter((f): f is string => typeof f === 'string')
        : [],
    }));

  const rawNear = Array.isArray(obj.near_miss) ? obj.near_miss : [];
  const near_miss = rawNear
    .filter((n): n is { symbol: string } & Record<string, unknown> =>
      n !== null && typeof n === 'object' && !Array.isArray(n)
      && typeof (n as Record<string, unknown>).symbol === 'string'
      && ((n as Record<string, unknown>).symbol as string).length > 0)
    .slice(0, 15)
    .map((no) => ({
      symbol: no.symbol,
      n_failed: num(no.n_failed),
      margin: typeof no.margin === 'number' && Number.isFinite(no.margin) ? Math.max(0, no.margin) : 0,
      gates: (Array.isArray(no.gates) ? no.gates : [])
        .filter((g): g is { gate: string } & Record<string, unknown> =>
          g !== null && typeof g === 'object' && !Array.isArray(g)
          && typeof (g as Record<string, unknown>).gate === 'string')
        .map((g) => ({
          gate: g.gate,
          value: typeof g.value === 'number' && Number.isFinite(g.value) ? g.value : null,
          threshold: typeof g.threshold === 'number' && Number.isFinite(g.threshold) ? g.threshold : null,
        })),
    }));

  const numOrNull = (v: unknown): number | null =>
    (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const sensitivity: Record<string, { sole_blockers: number; would_admit_at: number | null; threshold: number | null; examples: string[] }> = {};
  const rawSens = obj.sensitivity;
  if (rawSens !== null && typeof rawSens === 'object' && !Array.isArray(rawSens)) {
    for (const [gate, v] of Object.entries(rawSens as Record<string, unknown>)) {
      if (v === null || typeof v !== 'object' || Array.isArray(v)) continue;
      const vo = v as Record<string, unknown>;
      sensitivity[gate] = {
        sole_blockers: num(vo.sole_blockers),
        would_admit_at: numOrNull(vo.would_admit_at),
        threshold: numOrNull(vo.threshold),
        examples: (Array.isArray(vo.examples) ? vo.examples : []).filter((e): e is string => typeof e === 'string').slice(0, 5),
      };
    }
  }

  return {
    screened: num(obj.screened),
    passed: num(obj.passed),
    rejected: num(obj.rejected),
    gate_tally,
    samples,
    near_miss,
    sensitivity,
  };
}

/** Universes run_quality_screen can target when `symbols` is omitted. "default" means
 * "send no --universe flag" → the scanner's config.UNIVERSE. The z.enum over these values
 * is the injection guard: only one of these literals can ever reach the scanner's argv. */
const UNIVERSES = ['default', 'sp500', 'russell_1000', 'russell_3000', 'dow_30', 'quality_growth'] as const;
type Universe = (typeof UNIVERSES)[number];

/**
 * Assemble the scanner CLI args. Pure + exported so the arg wiring — especially the
 * --symbols precedence and flag ordering — is unit-testable without spawning Python.
 * Invariants: ALWAYS emits --json + --rejections-json; --symbols (variadic, argparse
 * nargs='+') is ALWAYS last so no flag is swallowed as a ticker; --universe is sent ONLY
 * when there are no symbols and the universe is a non-"default" value. --symbols beats
 * --universe — the two are never sent together (matches the scanner's resolve order).
 */
export function buildScanArgs(opts: {
  profile: string;
  outPath: string;
  rejPath: string;
  top: number;
  symbols: string[];
  universe?: Universe;
}): string[] {
  const { profile, outPath, rejPath, top, symbols, universe } = opts;
  const args = ['--profile', profile, '--json', outPath, '--rejections-json', rejPath, '--top', String(top)];
  if (symbols.length > 0) {
    args.push('--symbols', ...symbols); // symbols win; keep --symbols LAST
  } else if (universe && universe !== 'default') {
    args.push('--universe', universe);
  }
  return args;
}

/** Label for the result's `screened` field: the ticker array when symbols were given,
 * else the chosen universe (or the default large-cap universe). Pure + exported so the
 * branches are unit-testable rather than buried in func(). */
export function describeScreened(symbols: string[], universe?: Universe): string[] | string {
  if (symbols.length > 0) return symbols;
  if (universe && universe !== 'default') return `${universe} universe`;
  return 'default large-cap universe';
}

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
- Pass \`symbols\` to screen specific tickers (fast). Omit to screen a \`universe\`.
- \`universe\` (when \`symbols\` is omitted): \`quality_growth\` is a fast curated compounder
  shortlist — the recommended way to actually find passers. \`default\` is the mature
  large-cap list (rarely clears this strict screen). \`sp500\`/\`russell_1000\`/
  \`russell_3000\`/\`dow_30\` scrape a LIVE index and are SLOW (minutes; may approach the
  300s timeout). \`symbols\` always wins over \`universe\`.
- Requires the local Stock-scanner project + its Finnhub/Polygon keys; without keys it
  degrades to slower Yahoo data. Returns a clear error (not a crash) if the scan fails.
- Deterministic and auditable — the same inputs give the same shortlist.

## Interpreting an empty result (passed: 0)
- Zero passers is NOT a backend or data failure. The scan ran; the names simply did not
  clear the (strict) gates. Read \`failure_summary.gate_tally\` to state WHY — e.g.
  "19 of 40 failed Debt/Equity < 0.5" — and cite \`failure_summary.samples\` for the
  specific tickers and their exact failing metric values.
- NEVER attribute 0 passers to "backend limitations". And NEVER invent or guess a metric
  value: if a number is not present in \`picks\` or \`failure_summary\`, say it is not
  available — do not fill it in from memory (a real screen showed KO's Debt/Equity at
  ~1.41, not 0.00; the tool's own data is the source of truth).
- To surface passers, screen a broader/more-appropriate set of names — e.g.
  \`universe: 'quality_growth'\` (a curated compounder shortlist), or a wider \`symbols\`
  list — rather than loosening the gates in your reasoning.
- When passers are few, cite \`failure_summary.near_miss\` — the rejected names ranked by how
  close they came (fewest gates × smallest margin), each with the exact failing metric. e.g.
  "GOOGL missed ONLY ROIC (14.3% vs the 15% floor)". A name one gate away by a hair is a
  watchlist candidate, not a flat reject — surface it as such instead of implying it failed badly.
- \`failure_summary.sensitivity\` answers "what would it take to get more passers?" — per gate,
  how many names it SOLE-blocks (fail only it) + the closest metric value that would admit one
  (e.g. "ROIC sole-blocks 8; the nearest is DXCM at 0.123 vs the 0.15 floor"). Cite it rather
  than speculating about which gate to loosen.
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
  universe: z
    .enum(UNIVERSES)
    .optional()
    .describe('Which universe to screen when `symbols` is omitted. "quality_growth" = a fast curated compounder shortlist (recommended for finding passers). "default" = the mature large-cap list (rarely clears this screen). "sp500"/"russell_1000"/"russell_3000"/"dow_30" scrape a LIVE index and are SLOW (minutes; may approach the timeout). Ignored when `symbols` is provided.'),
});

export const runQualityScreen = new DynamicStructuredTool({
  name: 'run_quality_screen',
  description:
    'Run the deterministic quality-moat stock screen (ROE≥15%, ROIC≥15%, D/E<0.5, current>1.5, interest-coverage>10, PEG<1.5, revenue-growth>8%, market-cap>$10B, + Piotroski/Mohanram/Beneish quality) and return the ranked shortlist that passed. The ROIC gate uses the HIGHER of book ROIC and cash-adjusted (operating) ROIC — the latter nets cash + short-term investments out of invested capital so cash-rich compounders are not penalized; when a name passes on the operating figure, `roic_operating` and `cash_verified`/`cash_verification` (an independent SEC cross-check of the cash netting) are on the row. Pass `symbols` to screen specific tickers, or omit for the default large-cap universe. On 0 passers, returns a failure_summary (per-gate tally + sample reasons) explaining WHY names were rejected — this is not an error and not a backend limitation. The economic-moat verdict is a separate step — run assess_moat on the survivors.',
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
    const rejPath = join(tmpdir(), `qm_rej_${process.pid}_${Date.now()}.json`);
    const universe = input.universe;
    const args = buildScanArgs({ profile, outPath, rejPath, top: input.top ?? 25, symbols, universe });

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

    // Read the sibling rejections file the SAME defensive way (try/catch + finally
    // cleanup) so a missing/garbage file degrades to no summary — never a throw (D6).
    // On a 0-passers run this is what explains WHY names failed (per-gate tally + samples).
    let failureSummary: FailureSummary | undefined;
    try {
      failureSummary = normalizeFailureSummary(JSON.parse(readFileSync(rejPath, 'utf-8')));
    } catch {
      // rejections file missing / unreadable / not JSON — degrade to no summary.
    } finally {
      try { rmSync(rejPath, { force: true }); } catch { /* best-effort cleanup */ }
    }

    if (!r.ok && records.length === 0) {
      logger.warn(`[quality_screen] scan failed (exit ${r.code}): ${(r.stderr || '').slice(-300)}`);
      return formatToolResult(
        {
          error: `Quality screen failed${r.code !== null ? ` (exit ${r.code})` : ''}. The scanner needs Finnhub/Polygon keys in its .env for a full run.`,
          detail: (r.stderr || '').slice(-400),
          // Surface any partial tally even on a hard failure, so the model still has a reason.
          ...(failureSummary ? { failure_summary: failureSummary } : {}),
        },
        [],
      );
    }

    // Observability: the scanner exited non-zero yet still produced usable records
    // (e.g. a crash AFTER the picks were written). Surface it so a silent post-picks
    // failure is visible in logs instead of looking like a fully clean run.
    if (!r.ok) {
      logger.warn(`[quality_screen] scanner exited ${r.code} but returned ${records.length} record(s); result may be partial: ${(r.stderr || '').slice(-300)}`);
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
        screened: describeScreened(symbols, universe),
        passed: picks.length,
        picks,
        // Present whenever the scan rejected any names — the reason set behind a short (or
        // empty) picks list. On passed:0 this is the antidote to "backend limitations".
        ...(failureSummary ? { failure_summary: failureSummary } : {}),
      },
      ['Stock scanner — quality_moat deterministic gates (ROE/ROIC≥15%, D/E<0.5, current>1.5, interest-cov>10, PEG<1.5, rev>8%, mktcap>$10B). Economic-moat verdict is separate (assess_moat).'],
    );
  },
});

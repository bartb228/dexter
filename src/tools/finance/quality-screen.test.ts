import { describe, test, expect } from 'bun:test';
import { normalizeFailureSummary, buildScanArgs, describeScreened } from './quality-screen.js';

// Plan 01-02 Task 2: unit-test the pure summary-normalizer (no scanner spawn). Its job is
// to turn whatever the scanner's --rejections-json file contained into a clean
// FailureSummary or `undefined` — the tool must NEVER throw on this path (Decision D6).
describe('normalizeFailureSummary', () => {
  test('non-object / invalid inputs return undefined (never throw — D6)', () => {
    expect(normalizeFailureSummary(null)).toBeUndefined();
    expect(normalizeFailureSummary(undefined)).toBeUndefined();
    expect(normalizeFailureSummary('x')).toBeUndefined();
    expect(normalizeFailureSummary(42)).toBeUndefined();
    // An array is `typeof 'object'` but is not a valid summary shape → undefined.
    expect(normalizeFailureSummary([])).toBeUndefined();
  });

  test('a valid summary is returned cleaned, numbers coerced and gate_tally preserved', () => {
    const raw = {
      screened: 40,
      passed: 0,
      rejected: 38,
      gate_tally: { ROIC: 22, 'Debt/Eq': 19, CurrentRatio: 21 },
      samples: [{ symbol: 'KO', failures: ['Debt/Eq=1.41 > 0.5', 'ROIC=0.108 < 15%'] }],
    };
    expect(normalizeFailureSummary(raw)).toEqual({
      screened: 40,
      passed: 0,
      rejected: 38,
      gate_tally: { ROIC: 22, 'Debt/Eq': 19, CurrentRatio: 21 },
      samples: [{ symbol: 'KO', failures: ['Debt/Eq=1.41 > 0.5', 'ROIC=0.108 < 15%'] }],
      near_miss: [],
      sensitivity: {},
    });
  });

  test('gate_tally entries with non-number values are dropped, valid ones kept', () => {
    const out = normalizeFailureSummary({
      screened: 3,
      passed: 0,
      rejected: 3,
      gate_tally: { ROIC: 3, Bogus: 'lots', NaNish: NaN, CurrentRatio: 2 },
      samples: [],
    });
    expect(out?.gate_tally).toEqual({ ROIC: 3, CurrentRatio: 2 });
  });

  test('samples longer than 8 are capped to 8 (and keep the first 8, in order)', () => {
    const samples = Array.from({ length: 12 }, (_, i) => ({ symbol: `S${i}`, failures: ['ROIC=x'] }));
    const out = normalizeFailureSummary({
      screened: 12,
      passed: 0,
      rejected: 12,
      gate_tally: { ROIC: 12 },
      samples,
    });
    expect(out?.samples).toHaveLength(8);
    expect(out?.samples[0].symbol).toBe('S0');
    expect(out?.samples[7].symbol).toBe('S7');
  });

  test('missing numeric fields default to 0 (never NaN/undefined)', () => {
    expect(normalizeFailureSummary({ gate_tally: {}, samples: [] })).toEqual({
      screened: 0,
      passed: 0,
      rejected: 0,
      gate_tally: {},
      samples: [],
      near_miss: [],
      sensitivity: {},
    });
  });

  // Review-driven hardening: a "how many names" count is never negative.
  test('negative counts and negative gate_tally values are clamped/dropped (>= 0 invariant)', () => {
    const out = normalizeFailureSummary({
      screened: -5,
      passed: -10,
      rejected: -3,
      gate_tally: { ROIC: -7, Good: 3 },
      samples: [],
    });
    expect(out).toEqual({
      screened: 0,
      passed: 0,
      rejected: 0,
      gate_tally: { Good: 3 }, // ROIC:-7 dropped
      samples: [],
      near_miss: [],
      sensitivity: {},
    });
  });

  // Review-driven hardening: junk sample entries are dropped, not padded into blank rows.
  // Covers both non-objects AND malformed objects lacking a usable symbol.
  test('malformed sample entries (non-object OR no symbol) are dropped, real ones kept', () => {
    const out = normalizeFailureSummary({
      screened: 3,
      passed: 0,
      rejected: 3,
      gate_tally: { ROIC: 3 },
      samples: [
        'ROIC failed for KO', // non-object
        42, // non-object
        null, // non-object
        ['nested'], // array
        {}, // object, no symbol
        { reason: 'no symbol field' }, // object, no symbol
        { symbol: '', failures: ['x'] }, // blank symbol
        { symbol: 'KO', failures: ['ROIC=x'] }, // the only real one
      ],
    });
    expect(out?.samples).toEqual([{ symbol: 'KO', failures: ['ROIC=x'] }]);
  });

  // Plan 03-02: near_miss passthrough + defensive coercion (never throws — D6).
  test('near_miss is coerced; malformed entries/gates dropped', () => {
    const out = normalizeFailureSummary({
      screened: 40, passed: 0, rejected: 38, gate_tally: { ROIC: 22 }, samples: [],
      near_miss: [
        { symbol: 'GOOGL', n_failed: 1, margin: 0.048, gates: [{ gate: 'ROIC', value: 0.143, threshold: 0.15 }] },
        'junk',            // non-object → dropped
        { n_failed: 1 },   // no symbol → dropped
        { symbol: 'X', n_failed: -2, margin: 'bad', gates: [{ gate: 'Debt/Eq', value: 'x', threshold: 0.5 }, 42] },
      ],
    });
    expect(out?.near_miss.length).toBe(2);
    expect(out?.near_miss[0]).toEqual({
      symbol: 'GOOGL', n_failed: 1, margin: 0.048, gates: [{ gate: 'ROIC', value: 0.143, threshold: 0.15 }],
    });
    // n_failed clamped >= 0; non-number margin → 0; non-number gate value → null; the junk gate (42) dropped.
    expect(out?.near_miss[1]).toEqual({
      symbol: 'X', n_failed: 0, margin: 0, gates: [{ gate: 'Debt/Eq', value: null, threshold: 0.5 }],
    });
  });

  test('non-array or missing near_miss → [] (never throws)', () => {
    expect(normalizeFailureSummary({ gate_tally: {}, samples: [], near_miss: 'nope' })?.near_miss).toEqual([]);
    expect(normalizeFailureSummary({ gate_tally: {}, samples: [] })?.near_miss).toEqual([]);
  });

  test('near_miss is capped at 15 and negative margin is clamped to 0', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ symbol: `S${i}`, n_failed: 1, margin: -1, gates: [] }));
    const out = normalizeFailureSummary({ gate_tally: {}, samples: [], near_miss: many });
    expect(out?.near_miss).toHaveLength(15);
    expect(out?.near_miss[0].margin).toBe(0); // negative margin clamped (>= 0 invariant)
  });

  // Plan 03-03: sensitivity coercion (never throws — D6).
  test('sensitivity is coerced; malformed gate entries dropped', () => {
    const out = normalizeFailureSummary({
      gate_tally: {}, samples: [], near_miss: [],
      sensitivity: {
        ROIC: { sole_blockers: 8, would_admit_at: 0.143, threshold: 0.15, examples: ['DXCM', 'GOOGL', 42] },
        Bad: 'not-an-object',
        DebtEq: { sole_blockers: -3, would_admit_at: 'x', threshold: null, examples: 'nope' },
      },
    });
    expect(out?.sensitivity.ROIC).toEqual({
      sole_blockers: 8, would_admit_at: 0.143, threshold: 0.15, examples: ['DXCM', 'GOOGL'],
    });
    expect(out?.sensitivity.Bad).toBeUndefined(); // non-object gate entry dropped
    expect(out?.sensitivity.DebtEq).toEqual({
      sole_blockers: 0, would_admit_at: null, threshold: null, examples: [], // -3→0, 'x'→null, 'nope'→[]
    });
  });
});

// Plan 02-01 Task 3: the arg wiring (symbols-vs-universe precedence + flag ordering) is
// the one regression class the normalizeFailureSummary tests can't catch — test it directly.
describe('buildScanArgs', () => {
  const base = { profile: 'quality_moat', outPath: '/tmp/out.json', rejPath: '/tmp/rej.json', top: 25 };

  test('symbols present → --symbols with the tickers, and NO --universe', () => {
    const args = buildScanArgs({ ...base, symbols: ['KO', 'MSFT'], universe: 'quality_growth' });
    const si = args.indexOf('--symbols');
    expect(si).toBeGreaterThanOrEqual(0);
    expect(args.slice(si)).toEqual(['--symbols', 'KO', 'MSFT']);
    expect(args).not.toContain('--universe');
  });

  test('universe=quality_growth, no symbols → --universe quality_growth (+ --json/--rejections-json)', () => {
    const args = buildScanArgs({ ...base, symbols: [], universe: 'quality_growth' });
    const i = args.indexOf('--universe');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe('quality_growth');
    expect(args).not.toContain('--symbols');
    expect(args).toContain('--json');
    expect(args).toContain('--rejections-json');
  });

  test('universe=default, no symbols → NO --universe flag, but --json/--rejections-json still present', () => {
    const args = buildScanArgs({ ...base, symbols: [], universe: 'default' });
    expect(args).not.toContain('--universe');
    expect(args).not.toContain('--symbols');
    // The "always emits --json + --rejections-json" invariant matters most on this plain path.
    expect(args).toContain('--json');
    expect(args).toContain('--rejections-json');
  });

  test('universe omitted (undefined), no symbols → NO --universe (the true default call shape)', () => {
    const args = buildScanArgs({ ...base, symbols: [], universe: undefined });
    expect(args).not.toContain('--universe');
    expect(args).not.toContain('--symbols');
    expect(args).toContain('--json');
    expect(args).toContain('--rejections-json');
  });

  test('both symbols AND universe given → symbols win, --universe absent', () => {
    const args = buildScanArgs({ ...base, symbols: ['LRCX'], universe: 'sp500' });
    expect(args).toContain('--symbols');
    expect(args).not.toContain('--universe');
  });

  test('always emits --json/--rejections-json; --rejections-json precedes the trailing --symbols', () => {
    const args = buildScanArgs({ ...base, symbols: ['KO'], universe: undefined });
    expect(args[args.indexOf('--profile') + 1]).toBe('quality_moat');
    expect(args[args.indexOf('--top') + 1]).toBe('25');
    expect(args[args.indexOf('--json') + 1]).toBe('/tmp/out.json');
    expect(args[args.indexOf('--rejections-json') + 1]).toBe('/tmp/rej.json');
    const si = args.indexOf('--symbols');
    // Phase-01 order guard (deferred from 01-02): flag must precede the variadic --symbols.
    expect(args.indexOf('--rejections-json')).toBeLessThan(si);
    // --symbols + tickers are the trailing segment → argparse nargs='+' can't eat a later flag.
    expect(args.slice(si)).toEqual(['--symbols', 'KO']);
  });
});

// Review-driven: the result's `screened` label is the only signal of what was actually
// screened — unit-test its branches so a future edit can't silently mislabel a scan.
describe('describeScreened', () => {
  test('symbols present → the symbols array (verbatim)', () => {
    expect(describeScreened(['KO', 'MSFT'], 'quality_growth')).toEqual(['KO', 'MSFT']);
  });
  test('no symbols, universe=quality_growth → "quality_growth universe"', () => {
    expect(describeScreened([], 'quality_growth')).toBe('quality_growth universe');
  });
  test('no symbols, universe=default → "default large-cap universe"', () => {
    expect(describeScreened([], 'default')).toBe('default large-cap universe');
  });
  test('no symbols, universe omitted → "default large-cap universe"', () => {
    expect(describeScreened([], undefined)).toBe('default large-cap universe');
  });
});

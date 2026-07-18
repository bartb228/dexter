import { describe, test, expect } from 'bun:test';
import { normalizeFailureSummary } from './quality-screen.js';

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
});

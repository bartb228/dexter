import { describe, test, expect } from 'bun:test';
import {
  estimateTokens,
  getEffectiveContextWindow,
  getAutoCompactThreshold,
  CONTEXT_THRESHOLD,
  KEEP_TOOL_USES,
} from './tokens.js';

describe('estimateTokens', () => {
  test('returns 0 for an empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  test('uses ~3.5 chars/token, rounded up', () => {
    // ceil(4 / 3.5) = ceil(1.14) = 2
    expect(estimateTokens('abcd')).toBe(2);
    // ceil(7 / 3.5) = 2
    expect(estimateTokens('a'.repeat(7))).toBe(2);
    // ceil(8 / 3.5) = ceil(2.28) = 3
    expect(estimateTokens('a'.repeat(8))).toBe(3);
  });
});

describe('context window thresholds', () => {
  // 'claude-' prefix resolves to a 200k context window provider.
  const model = 'claude-opus-4-8';

  test('effective window reserves 20k output tokens (200k -> 180k)', () => {
    expect(getEffectiveContextWindow(model)).toBe(180_000);
  });

  test('auto-compact threshold sits 13k below the effective window (-> 167k)', () => {
    expect(getAutoCompactThreshold(model)).toBe(167_000);
  });
});

describe('legacy constants', () => {
  test('expose the documented fallback values', () => {
    expect(CONTEXT_THRESHOLD).toBe(100_000);
    expect(KEEP_TOOL_USES).toBe(5);
  });
});

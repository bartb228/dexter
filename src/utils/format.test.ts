import { describe, test, expect } from 'bun:test';
import { formatTurnDuration, formatTokensCompact } from './format.js';

// ---------------------------------------------------------------------------
// formatTurnDuration
// ---------------------------------------------------------------------------

describe('formatTurnDuration', () => {
  test('renders sub-minute durations as whole seconds', () => {
    expect(formatTurnDuration(0)).toBe('0s');
    expect(formatTurnDuration(22_000)).toBe('22s');
  });

  test('floors fractional seconds (does not round up)', () => {
    expect(formatTurnDuration(1_999)).toBe('1s');
    expect(formatTurnDuration(59_999)).toBe('59s');
  });

  test('switches to "Mm Ss" at exactly 60s', () => {
    expect(formatTurnDuration(60_000)).toBe('1m 0s');
  });

  test('renders minutes and remainder seconds', () => {
    // 4m 6s = 240_000 + 6_000
    expect(formatTurnDuration(246_000)).toBe('4m 6s');
  });

  test('handles durations over an hour without an hours unit', () => {
    // 61m 1s = 3_660_000 + 1_000
    expect(formatTurnDuration(3_661_000)).toBe('61m 1s');
  });
});

// ---------------------------------------------------------------------------
// formatTokensCompact
// ---------------------------------------------------------------------------

describe('formatTokensCompact', () => {
  test('leaves small numbers unscaled', () => {
    expect(formatTokensCompact(0)).toBe('0');
    expect(formatTokensCompact(880)).toBe('880');
  });

  test('uses a lowercase k suffix with one fractional digit', () => {
    expect(formatTokensCompact(3_200)).toBe('3.2k');
  });

  test('drops the fractional digit when it is zero', () => {
    expect(formatTokensCompact(14_000)).toBe('14k');
  });

  test('uses a lowercase m suffix for millions', () => {
    expect(formatTokensCompact(1_500_000)).toBe('1.5m');
  });
});

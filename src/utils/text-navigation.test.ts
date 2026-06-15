import { describe, test, expect } from 'bun:test';
import {
  findPrevWordStart,
  findNextWordEnd,
  getLineAndColumn,
  getCursorPosition,
  getLineStart,
  getLineEnd,
  getLineCount,
} from './text-navigation.js';

// ---------------------------------------------------------------------------
// findPrevWordStart
// ---------------------------------------------------------------------------

describe('findPrevWordStart', () => {
  test('returns 0 when already at or before the start', () => {
    expect(findPrevWordStart('hello world', 0)).toBe(0);
    expect(findPrevWordStart('hello world', -5)).toBe(0);
  });

  test('jumps to the start of the current word', () => {
    // pos 11 is end of "world"; previous word start is index 6
    expect(findPrevWordStart('hello world', 11)).toBe(6);
  });

  test('skips intervening whitespace to the previous word', () => {
    // pos 6 sits at "w"; skipping the space lands at start of "hello" (0)
    expect(findPrevWordStart('hello world', 6)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// findNextWordEnd
// ---------------------------------------------------------------------------

describe('findNextWordEnd', () => {
  test('returns text length when at or past the end', () => {
    expect(findNextWordEnd('hello world', 11)).toBe(11);
    expect(findNextWordEnd('hello world', 99)).toBe(11);
  });

  test('moves to the end of the current word', () => {
    expect(findNextWordEnd('hello world', 0)).toBe(5);
  });

  test('skips leading whitespace to the next word end', () => {
    expect(findNextWordEnd('hello world', 5)).toBe(11);
  });
});

// ---------------------------------------------------------------------------
// getLineAndColumn / getCursorPosition (inverse of each other)
// ---------------------------------------------------------------------------

describe('getLineAndColumn', () => {
  test('reports line 0 column 0 at the start', () => {
    expect(getLineAndColumn('ab\ncd', 0)).toEqual({ line: 0, column: 0 });
  });

  test('counts newlines to find the line and column', () => {
    // pos 4 is the "d" on the second line, column 1
    expect(getLineAndColumn('ab\ncd', 4)).toEqual({ line: 1, column: 1 });
  });
});

describe('getCursorPosition', () => {
  test('round-trips with getLineAndColumn', () => {
    const text = 'ab\ncd';
    const { line, column } = getLineAndColumn(text, 4);
    expect(getCursorPosition(text, line, column)).toBe(4);
  });

  test('clamps a column past the line length to the line end', () => {
    // line 1 ("cd") has length 2; column 99 clamps to 2 -> pos 5
    expect(getCursorPosition('ab\ncd', 1, 99)).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// getLineStart / getLineEnd / getLineCount
// ---------------------------------------------------------------------------

describe('getLineStart', () => {
  test('returns 0 for a position on the first line', () => {
    expect(getLineStart('ab\ncd', 1)).toBe(0);
  });

  test('returns the index just after the preceding newline', () => {
    expect(getLineStart('ab\ncd', 4)).toBe(3);
  });
});

describe('getLineEnd', () => {
  test('returns the index of the next newline', () => {
    expect(getLineEnd('ab\ncd', 0)).toBe(2);
  });

  test('returns text length on the last line (no trailing newline)', () => {
    expect(getLineEnd('ab\ncd', 4)).toBe(5);
  });
});

describe('getLineCount', () => {
  test('counts a single line for empty text', () => {
    expect(getLineCount('')).toBe(1);
  });

  test('counts newline-separated lines', () => {
    expect(getLineCount('a\nb\nc')).toBe(3);
  });

  test('counts a trailing newline as an extra (empty) line', () => {
    expect(getLineCount('a\nb\n')).toBe(3);
  });
});

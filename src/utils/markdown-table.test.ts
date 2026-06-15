import { describe, test, expect } from 'bun:test';
import {
  parseMarkdownTable,
  renderBoxTable,
  transformMarkdownTables,
  transformBold,
  formatResponse,
} from './markdown-table.js';

const SIMPLE_TABLE = `| A | B |
|---|---|
| 1 | 2 |`;

describe('parseMarkdownTable', () => {
  test('parses headers and rows from a pipe table', () => {
    expect(parseMarkdownTable(SIMPLE_TABLE)).toEqual({ headers: ['A', 'B'], rows: [['1', '2']] });
  });

  test('returns null without a separator line', () => {
    expect(parseMarkdownTable('| A | B |\n| 1 | 2 |')).toBeNull();
  });

  test('returns null for input with fewer than two lines', () => {
    expect(parseMarkdownTable('| A | B |')).toBeNull();
  });
});

describe('renderBoxTable', () => {
  test('draws a unicode box with the header content', () => {
    const out = renderBoxTable(['A', 'B'], [['1', '2']]);
    const lines = out.split('\n');
    expect(lines[0]).toBe('┌───┬───┐');
    expect(lines[1]).toBe('│ A │ B │');
    expect(out).toContain('└');
    expect(out).toContain('1');
    expect(out).toContain('2');
  });
});

describe('transformMarkdownTables', () => {
  test('replaces a markdown table with a box-drawing table', () => {
    const out = transformMarkdownTables(SIMPLE_TABLE);
    expect(out).toContain('┌');
    expect(out).not.toContain('|---|');
  });

  test('leaves non-table content untouched', () => {
    const text = 'just a sentence with no table';
    expect(transformMarkdownTables(text)).toBe(text);
  });
});

describe('transformBold', () => {
  test('removes the ** markers around bold text', () => {
    const out = transformBold('this is **bold** text');
    expect(out).not.toContain('**');
    expect(out).toContain('bold');
  });
});

describe('formatResponse', () => {
  test('applies both table and bold transforms', () => {
    const out = formatResponse(`Here:\n${SIMPLE_TABLE}\nand **done**`);
    expect(out).toContain('┌');
    expect(out).not.toContain('**');
  });
});

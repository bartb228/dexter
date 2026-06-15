import { describe, test, expect } from 'bun:test';
import { getToolDescription } from './tool-description.js';

describe('getToolDescription', () => {
  test('renders the documented financial-statement example', () => {
    expect(
      getToolDescription('get_income_statements', { ticker: 'aapl', period: 'annual', limit: 5 })
    ).toBe('AAPL income statements (annual) - 5 periods');
  });

  test('renders the documented search example', () => {
    expect(getToolDescription('tavily_search', { query: 'bitcoin price' })).toBe(
      '"bitcoin price" tavily search'
    );
  });

  test('uppercases the ticker', () => {
    expect(getToolDescription('get_prices', { ticker: 'nvda' })).toBe('NVDA prices');
  });

  test('strips get_/search_ prefixes and underscores from the tool name', () => {
    expect(getToolDescription('get_balance_sheets', {})).toBe('balance sheets');
    expect(getToolDescription('search_news', {})).toBe('news');
  });

  test('appends a date range when both bounds are present', () => {
    expect(
      getToolDescription('get_prices', { ticker: 'AAPL', start_date: '2024-01-01', end_date: '2024-06-30' })
    ).toBe('AAPL prices from 2024-01-01 to 2024-06-30');
  });

  test('appends unrecognized args in a bracketed key=value list', () => {
    expect(getToolDescription('get_thing', { foo: 'bar' })).toBe('thing [foo=bar]');
  });

  test('ignores a non-numeric limit', () => {
    // the limit branch requires typeof === 'number'
    expect(getToolDescription('get_thing', { limit: 'lots' })).toBe('thing [limit=lots]');
  });
});

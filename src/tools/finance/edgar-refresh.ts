import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from '../types.js';
import { clearEdgarCache } from './edgar/index.js';

export const EDGAR_REFRESH_DESCRIPTION = `
Clears the cached SEC EDGAR data (the ticker→CIK map and company financials) so the
next finance request re-fetches fresh data from SEC.

## When to Use

- A newly-listed ticker (e.g. a recent IPO) isn't resolving or looks missing.
- Fundamentals look stale right after an earnings filing and you need the latest numbers.
- Any time you suspect the cached financial data is out of date.

## Notes

- Filings, insider trades, and stock prices are always live and are NOT affected.
- Only the local EDGAR cache is cleared; the next call repopulates it from SEC.
`.trim();

export const edgarRefresh = new DynamicStructuredTool({
  name: 'edgar_refresh',
  description:
    'Clears the local SEC EDGAR cache (ticker→CIK map and company financials) so the next finance request re-fetches fresh data from SEC. Use when a newly-listed ticker is not resolving or fundamentals look stale after a filing. Filings, insider data, and prices are always live and unaffected.',
  schema: z.object({}),
  func: async () => {
    const { cleared } = clearEdgarCache();
    return formatToolResult({
      refreshed: true,
      cleared_files: cleared.length,
      detail:
        cleared.length > 0
          ? `Cleared ${cleared.length} cached EDGAR file(s); the next finance request will re-fetch fresh data from SEC.`
          : 'EDGAR cache was already empty; the next request fetches fresh data from SEC.',
    });
  },
});

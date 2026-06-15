import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { api, stripFieldsDeep } from './api.js';
import { formatToolResult } from '../types.js';
import { TTL_1H } from './utils.js';
import { isEdgarBackend, edgarInsiderTrades } from './edgar/index.js';
import { logger } from '../../utils/logger.js';

const REDUNDANT_INSIDER_FIELDS = ['issuer'] as const;

/** Shift a YYYY-MM-DD date by whole days (UTC) — used to turn FD's EXCLUSIVE
 *  filing_date_gt/lt bounds into the INCLUSIVE bounds recentForm4Filings applies. */
function shiftDay(d: string, days: number): string {
  const t = Date.parse(`${d}T00:00:00Z`);
  if (Number.isNaN(t)) return d;
  return new Date(t + days * 86_400_000).toISOString().slice(0, 10);
}

const InsiderTradesInputSchema = z.object({
  ticker: z
    .string()
    .describe("The stock ticker symbol to fetch insider trades for. For example, 'AAPL' for Apple."),
  limit: z
    .number()
    .default(10)
    .describe('Maximum number of insider trades to return (default: 10, max: 1000). Increase this for longer historical windows when needed.'),
  filing_date: z
    .string()
    .optional()
    .describe('Exact filing date to filter by (YYYY-MM-DD).'),
  filing_date_gte: z
    .string()
    .optional()
    .describe('Filter for trades with filing date greater than or equal to this date (YYYY-MM-DD).'),
  filing_date_lte: z
    .string()
    .optional()
    .describe('Filter for trades with filing date less than or equal to this date (YYYY-MM-DD).'),
  filing_date_gt: z
    .string()
    .optional()
    .describe('Filter for trades with filing date greater than this date (YYYY-MM-DD).'),
  filing_date_lt: z
    .string()
    .optional()
    .describe('Filter for trades with filing date less than this date (YYYY-MM-DD).'),
  name: z
    .string()
    .optional()
    .describe("Filter by insider name (e.g., 'HUANG JEN HSUN'). Names can be discovered via the /insider-trades/names/?ticker={ticker} endpoint."),
});

export const getInsiderTrades = new DynamicStructuredTool({
  name: 'get_insider_trades',
  description: `Retrieves insider trading transactions for a given company ticker. Insider trades include purchases and sales of company stock by executives, directors, and other insiders. This data is sourced from SEC Form 4 filings. Use filing_date filters to narrow down results by date range. Use the name parameter to filter by a specific insider.`,
  schema: InsiderTradesInputSchema,
  func: async (input) => {
    // Free SEC Form 4 backend under DATA_BACKEND=edgar; FD otherwise / on failure.
    if (isEdgarBackend()) {
      try {
        const trades = await edgarInsiderTrades(input.ticker, {
          limit: input.limit,
          // FD supports several filing-date filters; EDGAR applies inclusive bounds, so
          // exclusive gt/lt are shifted one day inward to preserve their semantics.
          startDate:
            input.filing_date_gte ??
            (input.filing_date_gt ? shiftDay(input.filing_date_gt, 1) : undefined) ??
            input.filing_date,
          endDate:
            input.filing_date_lte ??
            (input.filing_date_lt ? shiftDay(input.filing_date_lt, -1) : undefined) ??
            input.filing_date,
        });
        const filtered = input.name
          ? trades.filter((t) => t.name?.toUpperCase().includes(input.name!.toUpperCase()))
          : trades;
        if (filtered.length) {
          return formatToolResult(
            stripFieldsDeep(filtered, REDUNDANT_INSIDER_FIELDS),
            [`https://data.sec.gov (EDGAR Form 4: ${input.ticker.toUpperCase()})`],
          );
        }
        logger.info(`[EDGAR] no Form 4 insider trades for ${input.ticker}; falling back to FD`);
      } catch (e) {
        logger.warn(`[EDGAR] insider trades failed (${input.ticker}); falling back to FD: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const params: Record<string, string | number | undefined> = {
      ticker: input.ticker.toUpperCase(),
      limit: input.limit,
      filing_date: input.filing_date,
      filing_date_gte: input.filing_date_gte,
      filing_date_lte: input.filing_date_lte,
      filing_date_gt: input.filing_date_gt,
      filing_date_lt: input.filing_date_lt,
      name: input.name,
    };
    const { data, url } = await api.get('/insider-trades/', params, { cacheable: true, ttlMs: TTL_1H });
    return formatToolResult(
      stripFieldsDeep(data.insider_trades || [], REDUNDANT_INSIDER_FIELDS),
      [url]
    );
  },
});

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { api } from './api.js';
import { formatToolResult } from '../types.js';
import { isEdgarBackend, FRESHNESS_LIVE_PRICE } from './edgar/index.js';
import { hasPriceProvider, edgarStockPrices, edgarStockSnapshot } from './edgar/prices.js';
import { logger } from '../../utils/logger.js';

export const STOCK_PRICE_DESCRIPTION = `
Fetches current stock price snapshots for equities, including open, high, low, close prices, volume, and market cap. Powered by Financial Datasets.
`.trim();

const StockPriceInputSchema = z.object({
  ticker: z
    .string()
    .describe("The stock ticker symbol to fetch current price for. For example, 'AAPL' for Apple."),
});

export const getStockPrice = new DynamicStructuredTool({
  name: 'get_stock_price',
  description:
    'Fetches the current stock price snapshot for an equity ticker, including open, high, low, close prices, volume, and market cap.',
  schema: StockPriceInputSchema,
  func: async (input) => {
    const ticker = input.ticker.trim().toUpperCase();
    // Under DATA_BACKEND=edgar, derive the snapshot from the keyed price provider
    // (Polygon/Tiingo); SEC EDGAR has no quotes. Fall back to FD on miss.
    if (isEdgarBackend() && hasPriceProvider()) {
      try {
        const snap = await edgarStockSnapshot(ticker);
        if (snap) return formatToolResult(snap, ['https://polygon.io / tiingo.com (keyed price provider)', FRESHNESS_LIVE_PRICE]);
        logger.info(`[Prices] no snapshot for ${ticker}; falling back to FD`);
      } catch (e) {
        logger.warn(`[Prices] snapshot failed (${ticker}); falling back to FD: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const params = { ticker };
    const { data, url } = await api.get('/prices/snapshot/', params);
    return formatToolResult(data.snapshot || {}, [url]);
  },
});

const StockPricesInputSchema = z.object({
  ticker: z
    .string()
    .describe("The stock ticker symbol to fetch historical prices for. For example, 'AAPL' for Apple."),
  interval: z
    .enum(['day', 'week', 'month', 'year'])
    .default('day')
    .describe("The time interval for price data. Defaults to 'day'."),
  start_date: z.string().describe('Start date in YYYY-MM-DD format. Required.'),
  end_date: z.string().describe('End date in YYYY-MM-DD format. Required.'),
});

export const getStockPrices = new DynamicStructuredTool({
  name: 'get_stock_prices',
  description:
    'Retrieves historical price data for a stock over a specified date range, including open, high, low, close prices and volume.',
  schema: StockPricesInputSchema,
  func: async (input) => {
    const ticker = input.ticker.trim().toUpperCase();
    // Under DATA_BACKEND=edgar, historical OHLCV comes from the keyed price provider.
    if (isEdgarBackend() && hasPriceProvider()) {
      try {
        const bars = await edgarStockPrices(ticker, input.interval, input.start_date, input.end_date);
        if (bars.length) return formatToolResult(bars, ['https://polygon.io / tiingo.com (keyed price provider)', FRESHNESS_LIVE_PRICE]);
        logger.info(`[Prices] no bars for ${ticker} ${input.start_date}..${input.end_date}; falling back to FD`);
      } catch (e) {
        logger.warn(`[Prices] history failed (${ticker}); falling back to FD: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const params = {
      ticker,
      interval: input.interval,
      start_date: input.start_date,
      end_date: input.end_date,
    };
    // Cache when the date window is fully closed (OHLCV data is final)
    const endDate = new Date(input.end_date + 'T00:00:00');
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const { data, url } = await api.get('/prices/', params, { cacheable: endDate < today });
    return formatToolResult(data.prices || [], [url]);
  },
});

export const getStockTickers = new DynamicStructuredTool({
  name: 'get_available_stock_tickers',
  description: 'Retrieves the list of available stock tickers that can be used with the stock price tools.',
  schema: z.object({}),
  func: async () => {
    const { data, url } = await api.get('/prices/snapshot/tickers/', {}, { cacheable: true, ttlMs: 24 * 60 * 60 * 1000 });
    return formatToolResult(data.tickers || [], [url]);
  },
});

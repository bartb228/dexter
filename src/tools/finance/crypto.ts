import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { api } from './api.js';
import { formatToolResult } from '../types.js';
import { isEdgarBackend, edgarUnsupported } from './edgar/index.js';
import { edgarCryptoPrices, edgarCryptoSnapshot } from './edgar/prices.js';
import { logger } from '../../utils/logger.js';

const CryptoPriceSnapshotInputSchema = z.object({
  ticker: z
    .string()
    .describe(
      "The crypto ticker symbol to fetch the price snapshot for. For example, 'BTC-USD' for Bitcoin."
    ),
});

export const getCryptoPriceSnapshot = new DynamicStructuredTool({
  name: 'get_crypto_price_snapshot',
  description: `Fetches the most recent price snapshot for a specific cryptocurrency, including the latest price, trading volume, and other open, high, low, and close price data. Ticker format: use 'CRYPTO-USD' for USD prices (e.g., 'BTC-USD') or 'CRYPTO-CRYPTO' for crypto-to-crypto prices (e.g., 'BTC-ETH' for Bitcoin priced in Ethereum).`,
  schema: CryptoPriceSnapshotInputSchema,
  func: async (input) => {
    if (isEdgarBackend()) {
      try {
        const snap = await edgarCryptoSnapshot(input.ticker);
        if (snap) return formatToolResult(snap, ['https://polygon.io / tiingo.com (keyed crypto provider)']);
        logger.info(`[Crypto] no snapshot for ${input.ticker}; falling back to FD`);
      } catch (e) {
        logger.warn(`[Crypto] snapshot failed (${input.ticker}): ${e instanceof Error ? e.message : String(e)}`);
      }
      return edgarUnsupported('Crypto price snapshot', 'No data for that pair from the keyed provider; use a form like BTC-USD.');
    }
    const params = { ticker: input.ticker };
    const { data, url } = await api.get('/crypto/prices/snapshot/', params);
    return formatToolResult(data.snapshot || {}, [url]);
  },
});

const CryptoPricesInputSchema = z.object({
  ticker: z
    .string()
    .describe(
      "The crypto ticker symbol to fetch aggregated prices for. For example, 'BTC-USD' for Bitcoin."
    ),
  interval: z
    .enum(['minute', 'day', 'week', 'month', 'year'])
    .default('day')
    .describe("The time interval for price data. Defaults to 'day'."),
  interval_multiplier: z
    .number()
    .default(1)
    .describe('Multiplier for the interval. Defaults to 1.'),
  start_date: z.string().describe('Start date in YYYY-MM-DD format. Required.'),
  end_date: z.string().describe('End date in YYYY-MM-DD format. Required.'),
});

export const getCryptoPrices = new DynamicStructuredTool({
  name: 'get_crypto_prices',
  description: `Retrieves historical price data for a cryptocurrency over a specified date range, including open, high, low, close prices, and volume. Ticker format: use 'CRYPTO-USD' for USD prices (e.g., 'BTC-USD') or 'CRYPTO-CRYPTO' for crypto-to-crypto prices (e.g., 'BTC-ETH' for Bitcoin priced in Ethereum).`,
  schema: CryptoPricesInputSchema,
  func: async (input) => {
    if (isEdgarBackend()) {
      try {
        const bars = await edgarCryptoPrices(input.ticker, input.interval, input.interval_multiplier, input.start_date, input.end_date);
        if (bars.length) return formatToolResult(bars, ['https://polygon.io / tiingo.com (keyed crypto provider)']);
        logger.info(`[Crypto] no bars for ${input.ticker}; falling back to FD`);
      } catch (e) {
        logger.warn(`[Crypto] history failed (${input.ticker}): ${e instanceof Error ? e.message : String(e)}`);
      }
      return edgarUnsupported('Crypto prices', 'No data for that pair/range from the keyed provider; use a form like BTC-USD.');
    }
    const params = {
      ticker: input.ticker,
      interval: input.interval,
      interval_multiplier: input.interval_multiplier,
      start_date: input.start_date,
      end_date: input.end_date,
    };
    // Cache when the date window is fully closed (OHLCV data is final)
    const endDate = new Date(input.end_date + 'T00:00:00');
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const { data, url } = await api.get('/crypto/prices/', params, { cacheable: endDate < today });
    return formatToolResult(data.prices || [], [url]);
  },
});

export const getCryptoTickers = new DynamicStructuredTool({
  name: 'get_available_crypto_tickers',
  description: `Retrieves the list of available cryptocurrency tickers that can be used with the crypto price tools.`,
  schema: z.object({}),
  func: async () => {
    if (isEdgarBackend()) return edgarUnsupported('A crypto ticker list', 'Pass a pair directly to the crypto price tools, e.g. BTC-USD, ETH-USD.');
    const { data, url } = await api.get('/crypto/prices/tickers/', {}, { cacheable: true, ttlMs: 24 * 60 * 60 * 1000 });
    return formatToolResult(data.tickers || [], [url]);
  },
});

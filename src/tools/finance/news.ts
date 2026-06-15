import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { api } from './api.js';
import { formatToolResult } from '../types.js';
import { TTL_15M } from './utils.js';
import { isEdgarBackend, edgarUnsupported } from './edgar/index.js';
import { checkApiKeyExists } from '../../utils/env.js';
import { braveSearch } from '../search/brave.js';
import { logger } from '../../utils/logger.js';

interface BraveResult { title?: string; url?: string; snippet?: string }

const CompanyNewsInputSchema = z.object({
  ticker: z
    .string()
    .optional()
    .describe("The stock ticker symbol (e.g., 'AAPL'). Omit for broad market news."),
  limit: z
    .number()
    .default(5)
    .describe('Maximum number of news articles to return (default: 5, max: 10).'),
});

export const getCompanyNews = new DynamicStructuredTool({
  name: 'get_company_news',
  description:
    'Retrieves recent news headlines, including title, source, publication date, and URL. Pass a ticker for company-specific news, or omit the ticker for broad market news covering macro, rates, earnings, geopolitics, and more. Also useful when trying to explain broad price moves — omit the ticker to check for market-wide catalysts.',
  schema: CompanyNewsInputSchema,
  func: async (input) => {
    const limit = Math.min(input.limit, 10);
    const ticker = input.ticker?.trim().toUpperCase();

    // Free SEC backend has no news feed → use Brave web search (free). Degrade to a
    // clear message if no search key is configured (instead of a Financial Datasets 401).
    if (isEdgarBackend()) {
      if (!checkApiKeyExists('BRAVE_SEARCH_API_KEY')) {
        return edgarUnsupported('Company news', 'Set BRAVE_SEARCH_API_KEY for free web-sourced news.');
      }
      try {
        const query = ticker ? `${ticker} stock news latest` : 'stock market news today';
        const parsed = JSON.parse((await braveSearch.invoke({ query })) as string);
        const results = ((parsed.data?.results as BraveResult[]) ?? []).slice(0, limit);
        const news = results.map((r) => ({ ticker, title: r.title, url: r.url, source: 'web (Brave)', snippet: r.snippet }));
        return formatToolResult(news, ['https://search.brave.com (web-sourced news via Brave)']);
      } catch (e) {
        logger.warn(`[News] Brave search failed: ${e instanceof Error ? e.message : String(e)}`);
        return edgarUnsupported('Company news', 'Web news search failed; try again or set FINANCIAL_DATASETS_API_KEY.');
      }
    }

    const params: Record<string, string | number | undefined> = { ticker, limit };
    const { data, url } = await api.get('/news', params, { cacheable: true, ttlMs: TTL_15M });
    return formatToolResult((data.news as unknown[]) || [], [url]);
  },
});

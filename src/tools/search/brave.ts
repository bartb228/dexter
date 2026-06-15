import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from '../types.js';
import { logger } from '../../utils/logger.js';

const BRAVE_API_URL = 'https://api.search.brave.com/res/v1/web/search';

interface BraveWebResult {
  title?: string;
  url?: string;
  description?: string;
}

interface BraveResponse {
  web?: {
    results?: BraveWebResult[];
  };
}

async function callBrave(query: string): Promise<BraveResponse> {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!apiKey) {
    throw new Error('[Brave API] BRAVE_SEARCH_API_KEY is not set');
  }

  const url = `${BRAVE_API_URL}?${new URLSearchParams({ q: query, count: '10' }).toString()}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'Accept-Encoding': 'gzip',
      'X-Subscription-Token': apiKey,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`[Brave API] ${response.status}: ${text}`);
  }

  return response.json() as Promise<BraveResponse>;
}

export const braveSearch = new DynamicStructuredTool({
  name: 'web_search',
  description:
    'Search the web for current information on any topic. Returns relevant search results with URLs and content snippets.',
  schema: z.object({
    query: z.string().describe('The search query to look up on the web'),
  }),
  func: async (input) => {
    try {
      const res = await callBrave(input.query);

      const results = res.web?.results ?? [];
      const urls: string[] = [];
      const formattedResults = results.map((r) => {
        if (r.url && !urls.includes(r.url)) {
          urls.push(r.url);
        }
        return {
          title: r.title,
          url: r.url,
          snippet: r.description ?? undefined,
        };
      });

      const data = { results: formattedResults };
      return formatToolResult(data, urls.length ? urls : undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[Brave API] error: ${message}`);
      throw new Error(`[Brave API] ${message}`);
    }
  },
});

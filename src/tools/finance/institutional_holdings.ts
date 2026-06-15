import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { api } from './api.js';
import { formatToolResult } from '../types.js';
import { TTL_1H } from './utils.js';
import { isEdgarBackend, edgarUnsupported, edgarInstitutionalHoldings, edgarInstitutionalInvestors } from './edgar/index.js';
import { logger } from '../../utils/logger.js';

const InstitutionalHoldingsInputSchema = z
  .object({
    ticker: z
      .string()
      .optional()
      .describe("The held-security ticker (e.g. 'AAPL') to find all 13F filers holding it. Provide ticker for 'who holds X' questions."),
    filer_name: z
      .string()
      .optional()
      .describe("Institutional filer name or prefix (e.g. 'CITADEL', 'BERKSHIRE', 'BLACKROCK'). The tool resolves this to the matching filer's CIK automatically. Use this for 'what does X hold' questions when you only know the manager's name."),
    filer_cik: z
      .string()
      .optional()
      .describe("The institutional filer CIK to fetch their 13F holdings (e.g. '0001067983' for Berkshire). Will be zero-padded to 10 digits. Only use this when you already know the CIK; otherwise pass filer_name instead."),
    limit: z
      .number()
      .default(10)
      .describe('Maximum positions to return (default: 10, max: 200).'),
    report_period: z
      .string()
      .optional()
      .describe('Exact report period to filter by (YYYY-MM-DD, e.g. 2025-09-30 for end-of-Q3-2025). Omit all period filters to get the latest quarter.'),
    report_period_gte: z
      .string()
      .optional()
      .describe('Filter for periods on or after this date (YYYY-MM-DD).'),
    report_period_lte: z
      .string()
      .optional()
      .describe('Filter for periods on or before this date (YYYY-MM-DD).'),
    report_period_gt: z
      .string()
      .optional()
      .describe('Filter for periods strictly after this date (YYYY-MM-DD).'),
    report_period_lt: z
      .string()
      .optional()
      .describe('Filter for periods strictly before this date (YYYY-MM-DD).'),
  })
  .refine(
    (v) => [v.ticker, v.filer_name, v.filer_cik].filter(Boolean).length === 1,
    { message: 'Provide exactly one of `ticker`, `filer_name`, or `filer_cik`.' },
  );

async function resolveFilerCik(name: string): Promise<{ cik: string; resolvedName: string } | null> {
  const { data } = await api.get(
    '/institutional-holdings/investors',
    { name },
    { cacheable: true, ttlMs: TTL_1H },
  );
  const investors = (data.investors as Array<{ cik?: string; name?: string }> | undefined) ?? [];
  const first = investors[0];
  if (!first?.cik) return null;
  return { cik: first.cik, resolvedName: first.name ?? name };
}

export const getInstitutionalHoldings = new DynamicStructuredTool({
  name: 'get_institutional_holdings',
  description: `Retrieves SEC 13F institutional holdings. Three query modes (provide exactly one):

- \`ticker: "AAPL"\` → every institutional filer holding that security. Use for "who holds X" questions.
- \`filer_name: "CITADEL"\` → that manager's full reported portfolio. The tool resolves the name to a CIK internally. Use for "what does X hold" questions when you only know the manager's name. This is the preferred mode for manager queries.
- \`filer_cik: "0001067983"\` → same as filer_name but when you already know the exact CIK.

Period filters (report_period / report_period_gte|lte|gt|lt) accept YYYY-MM-DD. Without any period filter, returns the latest reported quarter. Each position includes shares, value_usd, reported_price, accession_number, and a subsidiaries breakdown when voting authority is split across managers.`,
  schema: InstitutionalHoldingsInputSchema,
  func: async (input) => {
    // Free SEC Form 13F (FILER direction). The "who holds <ticker>" direction has no
    // free reverse index → degrade. Manager-by-name/CIK → real holdings from 13F-HR.
    if (isEdgarBackend()) {
      if (input.ticker) {
        return edgarUnsupported(
          '"Who holds <ticker>" (13F by security)',
          'SEC has no free security→filers index — query by manager name or CIK instead (e.g. filer_name: "BERKSHIRE").',
        );
      }
      try {
        const res = await edgarInstitutionalHoldings({
          filerCik: input.filer_cik,
          filerName: input.filer_name,
          limit: Math.min(input.limit, 200),
          report_period: input.report_period,
          gte: input.report_period_gte,
          lte: input.report_period_lte,
          gt: input.report_period_gt,
          lt: input.report_period_lt,
        });
        if (res) {
          return formatToolResult(res, [`https://data.sec.gov (EDGAR 13F-HR: ${res.filer ?? res.cik})`]);
        }
        logger.info(`[EDGAR] no 13F holdings for ${input.filer_name ?? input.filer_cik}; falling back to FD`);
        return edgarUnsupported('Institutional (13F) holdings', 'No 13F-HR found for that filer.');
      } catch (e) {
        logger.warn(`[EDGAR] 13F holdings failed: ${e instanceof Error ? e.message : String(e)}`);
        return edgarUnsupported('Institutional (13F) holdings', 'Failed to fetch the 13F filing.');
      }
    }
    let filerCik = input.filer_cik ? input.filer_cik.padStart(10, '0') : undefined;

    if (!filerCik && input.filer_name) {
      const resolved = await resolveFilerCik(input.filer_name.trim());
      if (!resolved) {
        return formatToolResult(
          { error: `No institutional filer found matching "${input.filer_name}".` },
          [],
        );
      }
      filerCik = resolved.cik.padStart(10, '0');
    }

    const params: Record<string, string | number | undefined> = {
      ticker: input.ticker ? input.ticker.toUpperCase().trim() : undefined,
      filer_cik: filerCik,
      limit: input.limit,
      report_period: input.report_period,
      report_period_gte: input.report_period_gte,
      report_period_lte: input.report_period_lte,
      report_period_gt: input.report_period_gt,
      report_period_lt: input.report_period_lt,
    };
    const { data, url } = await api.get('/institutional-holdings/', params, {
      cacheable: true,
      ttlMs: TTL_1H,
    });
    return formatToolResult(data.institutional_holdings ?? [], [url]);
  },
});

const InstitutionalInvestorsInputSchema = z.object({
  name: z
    .string()
    .optional()
    .describe("Case-insensitive name prefix to filter investors by (e.g. 'BERKSHIRE', 'BLACKROCK'). Omit to list all known investors."),
});

export const getInstitutionalInvestors = new DynamicStructuredTool({
  name: 'get_institutional_investors',
  description: `Look up institutional 13F filers by name prefix and get their CIK. Returns a list of {cik, name} pairs. Use this to resolve a manager name (e.g. 'Berkshire Hathaway') into the filer_cik value to pass to get_institutional_holdings.`,
  schema: InstitutionalInvestorsInputSchema,
  func: async (input) => {
    if (isEdgarBackend()) {
      try {
        const res = await edgarInstitutionalInvestors(input.name ?? '');
        return formatToolResult(res, ['https://www.sec.gov/cgi-bin/browse-edgar (EDGAR company search)']);
      } catch (e) {
        logger.warn(`[EDGAR] investor search failed: ${e instanceof Error ? e.message : String(e)}`);
        return edgarUnsupported('Institutional (13F) investor search');
      }
    }
    const params: Record<string, string | undefined> = {
      name: input.name,
    };
    const { data, url } = await api.get('/institutional-holdings/investors', params, {
      cacheable: true,
      ttlMs: TTL_1H,
    });
    return formatToolResult(data.investors ?? [], [url]);
  },
});

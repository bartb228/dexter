import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { api, stripFieldsDeep } from './api.js';
import { formatToolResult } from '../types.js';
import { TTL_24H } from './utils.js';
import {
  isEdgarBackend,
  edgarServesPeriod,
  edgarIncomeStatements,
  edgarBalanceSheets,
  edgarCashFlowStatements,
  edgarAllFinancials,
  fundamentalsFreshness,
} from './edgar/index.js';
import { logger } from '../../utils/logger.js';

const REDUNDANT_FINANCIAL_FIELDS = ['accession_number', 'currency', 'period'] as const;

const FinancialStatementsInputSchema = z.object({
  ticker: z
    .string()
    .describe(
      "The stock ticker symbol to fetch financial statements for. For example, 'AAPL' for Apple."
    ),
  period: z
    .enum(['annual', 'quarterly', 'ttm'])
    .describe(
      "The reporting period for the financial statements. 'annual' for yearly, 'quarterly' for quarterly, and 'ttm' for trailing twelve months."
    ),
  limit: z
    .number()
    .default(4)
    .describe(
      'Maximum number of report periods to return (default: 4). Returns the most recent N periods based on the period type. Increase this for longer historical analysis when needed.'
    ),
  report_period_gt: z
    .string()
    .optional()
    .describe('Filter for financial statements with report periods after this date (YYYY-MM-DD).'),
  report_period_gte: z
    .string()
    .optional()
    .describe(
      'Filter for financial statements with report periods on or after this date (YYYY-MM-DD).'
    ),
  report_period_lt: z
    .string()
    .optional()
    .describe('Filter for financial statements with report periods before this date (YYYY-MM-DD).'),
  report_period_lte: z
    .string()
    .optional()
    .describe(
      'Filter for financial statements with report periods on or before this date (YYYY-MM-DD).'
    ),
});

function createParams(input: z.infer<typeof FinancialStatementsInputSchema>): Record<string, string | number | undefined> {
  return {
    ticker: input.ticker,
    period: input.period,
    limit: input.limit,
    report_period_gt: input.report_period_gt,
    report_period_gte: input.report_period_gte,
    report_period_lt: input.report_period_lt,
    report_period_lte: input.report_period_lte,
  };
}

export const getIncomeStatements = new DynamicStructuredTool({
  name: 'get_income_statements',
  description: `Fetches a company's income statements, detailing its revenues, expenses, net income, etc. over a reporting period. Useful for evaluating a company's profitability and operational efficiency.`,
  schema: FinancialStatementsInputSchema,
  func: async (input) => {
    // Free SEC EDGAR backend (DATA_BACKEND=edgar) for annual/quarterly; FD otherwise
    // or on any EDGAR failure (non-destructive fallback).
    if (isEdgarBackend() && edgarServesPeriod(input.period)) {
      try {
        const statements = await edgarIncomeStatements(
          input.ticker,
          input.period as 'annual' | 'quarterly',
          input.limit,
        );
        if (statements.length) {
          return formatToolResult(
            stripFieldsDeep(statements, REDUNDANT_FINANCIAL_FIELDS),
            [`https://data.sec.gov (EDGAR companyfacts: ${input.ticker.toUpperCase()})`, await fundamentalsFreshness(input.ticker)],
          );
        }
        logger.info(`[EDGAR] no income statements for ${input.ticker} (${input.period}); falling back to FD`);
      } catch (e) {
        logger.warn(`[EDGAR] income statements failed (${input.ticker}); falling back to FD: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const params = createParams(input);
    const { data, url } = await api.get('/financials/income-statements/', params, { cacheable: true, ttlMs: TTL_24H });
    return formatToolResult(
      stripFieldsDeep(data.income_statements || {}, REDUNDANT_FINANCIAL_FIELDS),
      [url]
    );
  },
});

export const getBalanceSheets = new DynamicStructuredTool({
  name: 'get_balance_sheets',
  description: `Retrieves a company's balance sheets, providing a snapshot of its assets, liabilities, shareholders' equity, etc. at a specific point in time. Useful for assessing a company's financial position.`,
  schema: FinancialStatementsInputSchema,
  func: async (input) => {
    if (isEdgarBackend() && edgarServesPeriod(input.period)) {
      try {
        const sheets = await edgarBalanceSheets(input.ticker, input.period as 'annual' | 'quarterly', input.limit);
        if (sheets.length) {
          return formatToolResult(
            stripFieldsDeep(sheets, REDUNDANT_FINANCIAL_FIELDS),
            [`https://data.sec.gov (EDGAR companyfacts: ${input.ticker.toUpperCase()})`, await fundamentalsFreshness(input.ticker)],
          );
        }
        logger.info(`[EDGAR] no balance sheets for ${input.ticker} (${input.period}); falling back to FD`);
      } catch (e) {
        logger.warn(`[EDGAR] balance sheets failed (${input.ticker}); falling back to FD: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const params = createParams(input);
    const { data, url } = await api.get('/financials/balance-sheets/', params, { cacheable: true, ttlMs: TTL_24H });
    return formatToolResult(
      stripFieldsDeep(data.balance_sheets || {}, REDUNDANT_FINANCIAL_FIELDS),
      [url]
    );
  },
});

export const getCashFlowStatements = new DynamicStructuredTool({
  name: 'get_cash_flow_statements',
  description: `Retrieves a company's cash flow statements, showing how cash is generated and used across operating, investing, and financing activities. Useful for understanding a company's liquidity and solvency.`,
  schema: FinancialStatementsInputSchema,
  func: async (input) => {
    if (isEdgarBackend() && edgarServesPeriod(input.period)) {
      try {
        const flows = await edgarCashFlowStatements(input.ticker, input.period as 'annual' | 'quarterly', input.limit);
        if (flows.length) {
          return formatToolResult(
            stripFieldsDeep(flows, REDUNDANT_FINANCIAL_FIELDS),
            [`https://data.sec.gov (EDGAR companyfacts: ${input.ticker.toUpperCase()})`, await fundamentalsFreshness(input.ticker)],
          );
        }
        logger.info(`[EDGAR] no cash flow statements for ${input.ticker} (${input.period}); falling back to FD`);
      } catch (e) {
        logger.warn(`[EDGAR] cash flow statements failed (${input.ticker}); falling back to FD: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const params = createParams(input);
    const { data, url } = await api.get('/financials/cash-flow-statements/', params, { cacheable: true, ttlMs: TTL_24H });
    return formatToolResult(
      stripFieldsDeep(data.cash_flow_statements || {}, REDUNDANT_FINANCIAL_FIELDS),
      [url]
    );
  },
});

export const getAllFinancialStatements = new DynamicStructuredTool({
  name: 'get_all_financial_statements',
  description: `Retrieves all three financial statements (income statements, balance sheets, and cash flow statements) for a company in a single API call. This is more efficient than calling each statement type separately when you need all three for comprehensive financial analysis.`,
  schema: FinancialStatementsInputSchema,
  func: async (input) => {
    if (isEdgarBackend() && edgarServesPeriod(input.period)) {
      try {
        const all = await edgarAllFinancials(input.ticker, input.period as 'annual' | 'quarterly', input.limit);
        if (all && all.income_statements.length) {
          return formatToolResult(
            stripFieldsDeep(all, REDUNDANT_FINANCIAL_FIELDS),
            [`https://data.sec.gov (EDGAR companyfacts: ${input.ticker.toUpperCase()})`, await fundamentalsFreshness(input.ticker)],
          );
        }
        logger.info(`[EDGAR] no combined financials for ${input.ticker} (${input.period}); falling back to FD`);
      } catch (e) {
        logger.warn(`[EDGAR] combined financials failed (${input.ticker}); falling back to FD: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const params = createParams(input);
    const { data, url } = await api.get('/financials/', params, { cacheable: true, ttlMs: TTL_24H });
    return formatToolResult(
      stripFieldsDeep(data.financials || {}, REDUNDANT_FINANCIAL_FIELDS),
      [url]
    );
  },
});


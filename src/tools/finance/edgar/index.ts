/**
 * EDGAR backend entry point. Dexter's finance fetchers dispatch here when
 * `DATA_BACKEND=edgar`; otherwise the paid Financial Datasets path is used.
 */
import { getCik, getCompanyFacts, companyFactsCacheAgeHours, FACTS_TTL_HOURS } from './client.js';
import { formatToolResult } from '../../types.js';
import {
  buildIncomeStatements,
  buildBalanceSheets,
  buildCashFlowStatements,
  type IncomeStatement,
  type BalanceSheet,
  type CashFlowStatement,
} from './fundamentals.js';

/** True when the free SEC EDGAR backend is selected. FD remains the default. */
export function isEdgarBackend(): boolean {
  return (process.env.DATA_BACKEND || '').toLowerCase() === 'edgar';
}

/** Honest degradation for a capability the free SEC backend can't serve — returns a
 *  clear, actionable result instead of a confusing Financial Datasets 401. */
export function edgarUnsupported(feature: string, hint = ''): string {
  return formatToolResult(
    {
      supported: false,
      backend: 'edgar',
      message:
        `${feature} is not available on the free SEC EDGAR backend.` +
        (hint ? ` ${hint}` : '') +
        ` To enable it, set FINANCIAL_DATASETS_API_KEY and remove DATA_BACKEND=edgar.`,
    },
    [],
  );
}

// ── freshness stamping ──────────────────────────────────────────────────────────
// Appended to a tool's sourceUrls so the agent (and user) can see how fresh the data
// is. Fundamentals come from the 24h companyfacts cache; prices/filings/insider are live.
export const FRESHNESS_LIVE_PRICE = 'freshness: live — real-time price provider (not cached)';
export const FRESHNESS_LIVE_SEC = 'freshness: live — SEC submissions feed (not cached)';

/** Freshness label for companyfacts-derived results (financials, key ratios). */
export async function fundamentalsFreshness(ticker: string): Promise<string> {
  const cik = await getCik(ticker);
  const age = cik ? companyFactsCacheAgeHours(cik) : null;
  if (age === null) return 'freshness: companyfacts just fetched from SEC (live)';
  return `freshness: companyfacts cached ${age.toFixed(1)}h ago (auto-refreshes after ${FACTS_TTL_HOURS}h; run edgar_refresh to force)`;
}

/** EDGAR serves annual + quarterly fundamentals; `ttm` falls back to FD (returns null). */
export function edgarServesPeriod(period: string): boolean {
  return period === 'annual' || period === 'quarterly';
}

export { fetchInsiderTrades as edgarInsiderTrades } from './insider.js';
export { edgarKeyRatiosSnapshot, edgarHistoricalKeyRatios } from './metrics.js';
export { edgarFilings, edgarFilingText } from './filings.js';
export { clearEdgarCache } from './client.js';

/**
 * Income statements from SEC companyfacts, shaped like FD's `income_statements`.
 * Returns [] for an unknown ticker. Throws EdgarError if EDGAR_USER_AGENT is unset
 * (surfaced to the caller, which logs and degrades).
 */
export async function edgarIncomeStatements(
  ticker: string,
  period: 'annual' | 'quarterly',
  limit: number,
): Promise<IncomeStatement[]> {
  const cik = await getCik(ticker);
  if (!cik) return [];
  const facts = await getCompanyFacts(cik);
  return buildIncomeStatements(facts, ticker, period, limit);
}

export async function edgarBalanceSheets(
  ticker: string,
  period: 'annual' | 'quarterly',
  limit: number,
): Promise<BalanceSheet[]> {
  const cik = await getCik(ticker);
  if (!cik) return [];
  const facts = await getCompanyFacts(cik);
  return buildBalanceSheets(facts, ticker, period, limit);
}

export async function edgarCashFlowStatements(
  ticker: string,
  period: 'annual' | 'quarterly',
  limit: number,
): Promise<CashFlowStatement[]> {
  const cik = await getCik(ticker);
  if (!cik) return [];
  const facts = await getCompanyFacts(cik);
  return buildCashFlowStatements(facts, ticker, period, limit);
}

/**
 * All three statements in one companyfacts fetch (FD's `/financials/` shape:
 * `{ income_statements, balance_sheets, cash_flow_statements }`). Returns null
 * for an unknown ticker so the caller can fall back to FD.
 */
export async function edgarAllFinancials(
  ticker: string,
  period: 'annual' | 'quarterly',
  limit: number,
): Promise<{ income_statements: IncomeStatement[]; balance_sheets: BalanceSheet[]; cash_flow_statements: CashFlowStatement[] } | null> {
  const cik = await getCik(ticker);
  if (!cik) return null;
  const facts = await getCompanyFacts(cik);
  return {
    income_statements: buildIncomeStatements(facts, ticker, period, limit),
    balance_sheets: buildBalanceSheets(facts, ticker, period, limit),
    cash_flow_statements: buildCashFlowStatements(facts, ticker, period, limit),
  };
}

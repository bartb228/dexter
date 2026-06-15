/**
 * EDGAR backend entry point. Dexter's finance fetchers dispatch here when
 * `DATA_BACKEND=edgar`; otherwise the paid Financial Datasets path is used.
 */
import { getCik, getCompanyFacts } from './client.js';
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

/** EDGAR serves annual + quarterly fundamentals; `ttm` falls back to FD (returns null). */
export function edgarServesPeriod(period: string): boolean {
  return period === 'annual' || period === 'quarterly';
}

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

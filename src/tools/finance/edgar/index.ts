/**
 * EDGAR backend entry point. Dexter's finance fetchers dispatch here when
 * `DATA_BACKEND=edgar`; otherwise the paid Financial Datasets path is used.
 */
import { getCik, getCompanyFacts } from './client.js';
import { buildIncomeStatements, type IncomeStatement } from './fundamentals.js';

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

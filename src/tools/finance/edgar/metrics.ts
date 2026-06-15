/**
 * Derive a key-ratios snapshot and historical ratios from SEC companyfacts (+ a
 * latest price for the valuation ratios). Field names match Dexter's formatKeyRatios
 * (market_cap, pe_ratio, roe, debt_to_equity, …). Only well-defined ratios are
 * emitted; anything whose inputs are missing for a period is null (never guessed).
 */
import { getCik, getCompanyFacts } from './client.js';
import { buildIncomeStatements, buildBalanceSheets, buildCashFlowStatements, type IncomeStatement, type BalanceSheet, type CashFlowStatement } from './fundamentals.js';
import { edgarStockSnapshot } from './prices.js';

type Period = 'annual' | 'quarterly';
type Ratios = Record<string, number | string | null>;

/** Safe divide: null unless both inputs are present and the denominator is non-zero. */
function div(a: number | null | undefined, b: number | null | undefined): number | null {
  return a != null && b != null && b !== 0 ? a / b : null;
}

/** Period-over-period growth rate (prev must be a positive base). */
function growth(curr: number | null | undefined, prev: number | null | undefined): number | null {
  return curr != null && prev != null && prev !== 0 ? (curr - prev) / Math.abs(prev) : null;
}

/** Compose the fundamentals-only ratios shared by snapshot + historical rows. */
function fundamentalRatios(inc: IncomeStatement, bal: BalanceSheet | undefined, cf: CashFlowStatement | undefined, prev: IncomeStatement | undefined): Ratios {
  const equity = bal?.shareholders_equity ?? null;
  const debt = bal?.total_debt ?? null;
  return {
    report_period: inc.report_period,
    eps: inc.earnings_per_share,
    gross_margin: div(inc.gross_profit, inc.revenue),
    operating_margin: div(inc.operating_income, inc.revenue),
    net_margin: div(inc.net_income, inc.revenue),
    roe: div(inc.net_income, equity),
    roa: div(inc.net_income, bal?.total_assets ?? null),
    current_ratio: div(bal?.current_assets ?? null, bal?.current_liabilities ?? null),
    quick_ratio: bal && bal.current_assets != null && bal.current_liabilities != null
      ? div((bal.current_assets) - (bal.inventory ?? 0), bal.current_liabilities)
      : null,
    debt_to_equity: div(debt, equity),
    debt_to_assets: div(debt, bal?.total_assets ?? null),
    book_value_per_share: div(equity, inc.shares),
    free_cash_flow_per_share: div(cf?.free_cash_flow ?? null, inc.shares),
    revenue_growth_rate: growth(inc.revenue, prev?.revenue),
    earnings_growth_rate: growth(inc.net_income, prev?.net_income),
  };
}

/** Latest snapshot: fundamentals ratios + price-derived valuation ratios. */
export async function edgarKeyRatiosSnapshot(ticker: string): Promise<Ratios | null> {
  const cik = await getCik(ticker);
  if (!cik) return null;
  const facts = await getCompanyFacts(cik);
  const inc = buildIncomeStatements(facts, ticker, 'annual', 2);
  if (!inc.length) return null;
  const bal = buildBalanceSheets(facts, ticker, 'annual', 1)[0];
  const cf = buildCashFlowStatements(facts, ticker, 'annual', 1)[0];
  const i0 = inc[0];
  const base = fundamentalRatios(i0, bal, cf, inc[1]);

  const snap = await edgarStockSnapshot(ticker);
  const price = typeof snap?.price === 'number' ? (snap.price as number) : null;
  const mc = price != null && i0.shares != null ? price * i0.shares : null;
  const ebitda = i0.operating_income != null ? i0.operating_income + (cf?.depreciation_and_amortization ?? 0) : null;
  const enterprise_value = mc != null ? mc + (bal?.total_debt ?? 0) - (bal?.cash_and_equivalents ?? 0) : null;

  return {
    ticker: ticker.toUpperCase(),
    ...base,
    price,
    market_cap: mc,
    pe_ratio: div(price, i0.earnings_per_share),
    price_to_book: div(mc, bal?.shareholders_equity ?? null),
    price_to_sales: div(mc, i0.revenue),
    enterprise_value,
    ev_to_ebitda: div(enterprise_value, ebitda),
  };
}

/** Historical per-period ratios (fundamentals-derived; valuation ratios need a price and are omitted). */
export async function edgarHistoricalKeyRatios(ticker: string, period: Period, limit: number): Promise<Ratios[]> {
  const cik = await getCik(ticker);
  if (!cik) return [];
  const facts = await getCompanyFacts(cik);
  // +1 period so the oldest row still has a prior for growth.
  const inc = buildIncomeStatements(facts, ticker, period, limit + 1);
  const bal = buildBalanceSheets(facts, ticker, period, limit + 1);
  const cf = buildCashFlowStatements(facts, ticker, period, limit + 1);
  const balByEnd = new Map(bal.map((b) => [b.report_period, b]));
  const cfByEnd = new Map(cf.map((c) => [c.report_period, c]));

  const rows: Ratios[] = [];
  for (let k = 0; k < Math.min(inc.length, limit); k++) {
    const i = inc[k];
    rows.push({
      ticker: ticker.toUpperCase(),
      period,
      fiscal_period: i.fiscal_period,
      ...fundamentalRatios(i, balByEnd.get(i.report_period), cfByEnd.get(i.report_period), inc[k + 1]),
    });
  }
  return rows;
}

/**
 * Assemble Financial-Datasets-shaped statements from SEC companyfacts.
 *
 * Carries over the correctness lessons from the ai-hedge-fund backend:
 *  - RECENCY-AWARE concept selection (ISS-003): when several us-gaap tags can supply
 *    a metric (e.g. revenue), pick the tag whose data reaches the LATEST period, so a
 *    stale legacy tag can't shadow the current one (the NVDA net-margin bug).
 *  - PERIOD ALIGNMENT (ISS-004/005): a period row only mixes facts that share the
 *    same period-end, never composing across mismatched periods.
 *
 * Covers ANNUAL (10-K / fp=FY) — the most verifiable case — plus a best-effort
 * quarterly path. `ttm` is not served here (caller falls back to FD).
 *
 * Concept kinds: FLOW concepts (income, cash-flow) are durations with start+end;
 * INSTANT concepts (balance sheet) are point-in-time with only `end`.
 */
import type { CompanyFacts, ConceptFact } from './client.js';
import { conceptFacts } from './client.js';

type Period = 'annual' | 'quarterly';

export interface IncomeStatement {
  ticker: string;
  report_period: string;
  fiscal_period: string;
  period: Period;
  revenue: number | null;
  cost_of_revenue: number | null;
  gross_profit: number | null;
  operating_income: number | null;
  net_income: number | null;
  earnings_per_share: number | null;
  shares: number | null;
}

export interface BalanceSheet {
  ticker: string;
  report_period: string;
  fiscal_period: string;
  period: Period;
  total_assets: number | null;
  current_assets: number | null;
  cash_and_equivalents: number | null;
  inventory: number | null;
  total_liabilities: number | null;
  current_liabilities: number | null;
  total_debt: number | null;
  shareholders_equity: number | null;
  retained_earnings: number | null;
}

export interface CashFlowStatement {
  ticker: string;
  report_period: string;
  fiscal_period: string;
  period: Period;
  net_cash_flow_from_operations: number | null;
  capital_expenditure: number | null;
  free_cash_flow: number | null;
  net_cash_flow_from_investing: number | null;
  net_cash_flow_from_financing: number | null;
  depreciation_and_amortization: number | null;
  dividends_and_other_cash_distributions: number | null;
}

// Concept chains (ordered best→fallback). Selection is recency-aware, NOT order-first.
const FLOW = {
  revenue: ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'RevenueFromContractWithCustomerIncludingAssessedTax', 'SalesRevenueNet'],
  cost_of_revenue: ['CostOfRevenue', 'CostOfGoodsAndServicesSold', 'CostOfGoodsSold'],
  gross_profit: ['GrossProfit'],
  operating_income: ['OperatingIncomeLoss'],
  net_income: ['NetIncomeLoss'],
  earnings_per_share: ['EarningsPerShareDiluted', 'EarningsPerShareBasic'],
  shares: ['WeightedAverageNumberOfDilutedSharesOutstanding', 'WeightedAverageNumberOfSharesOutstandingBasic'],
  operating_cash_flow: ['NetCashProvidedByUsedInOperatingActivities', 'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations'],
  capex: ['PaymentsToAcquirePropertyPlantAndEquipment', 'PaymentsToAcquireProductiveAssets'],
  investing_cf: ['NetCashProvidedByUsedInInvestingActivities'],
  financing_cf: ['NetCashProvidedByUsedInFinancingActivities'],
  dep_amort: ['DepreciationDepletionAndAmortization', 'DepreciationAmortizationAndAccretionNet', 'DepreciationAndAmortization'],
  dividends: ['PaymentsOfDividendsCommonStock', 'PaymentsOfDividends'],
} as const;

const INSTANT = {
  total_assets: ['Assets'],
  current_assets: ['AssetsCurrent'],
  cash: ['CashAndCashEquivalentsAtCarryingValue', 'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents'],
  inventory: ['InventoryNet'],
  total_liabilities: ['Liabilities'],
  current_liabilities: ['LiabilitiesCurrent'],
  equity: ['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest'],
  retained_earnings: ['RetainedEarningsAccumulatedDeficit'],
  long_term_debt: ['LongTermDebtNoncurrent', 'LongTermDebt'],
  current_debt: ['LongTermDebtCurrent', 'DebtCurrent'],
} as const;

function dayspan(f: ConceptFact): number | null {
  if (!f.start || !f.end) return null;
  return (Date.parse(f.end) - Date.parse(f.start)) / 86_400_000;
}

/** Does a fact qualify for the requested period + concept kind? */
function qualifies(f: ConceptFact, period: Period, instant: boolean): boolean {
  if (instant) {
    // Balance-sheet (point-in-time): annual = year-end balances from 10-Ks.
    return period === 'annual' ? f.form === '10-K' : f.form === '10-Q';
  }
  if (period === 'annual') return f.fp === 'FY' && f.form === '10-K';
  // 10-Q discrete-quarter fact: ~90-day span (excludes the YTD durations a 10-Q also carries).
  if (f.form !== '10-Q') return false;
  const s = dayspan(f);
  return s === null ? true : s >= 80 && s <= 100;
}

/**
 * Pick the concept from a chain whose qualifying facts reach the latest period-end
 * (recency-aware), then return that concept's qualifying facts.
 */
function selectFacts(facts: CompanyFacts, chain: readonly string[], period: Period, instant: boolean): ConceptFact[] {
  let best: ConceptFact[] = [];
  let bestEnd = '';
  for (const concept of chain) {
    const all = conceptFacts(facts, concept).filter((f) => qualifies(f, period, instant));
    if (!all.length) continue;
    const latest = all.reduce((m, f) => (f.end > m ? f.end : m), '');
    if (latest > bestEnd) {
      bestEnd = latest;
      best = all;
    }
  }
  return best;
}

/** Map period-end → value, deduped (prefer the filing with the latest fiscal year). */
function byPeriodEnd(facts: ConceptFact[]): Map<string, number> {
  const out = new Map<string, ConceptFact>();
  for (const f of facts) {
    const prev = out.get(f.end);
    if (!prev || (f.fy ?? 0) >= (prev.fy ?? 0)) out.set(f.end, f);
  }
  return new Map([...out].map(([end, f]) => [end, f.val]));
}

/** Period-ends for a metric map, most-recent-first, capped at limit. */
function topEnds(anchor: Map<string, number>, limit: number): string[] {
  return [...anchor.keys()].sort((a, b) => b.localeCompare(a)).slice(0, limit);
}

export function buildIncomeStatements(facts: CompanyFacts, ticker: string, period: Period, limit: number): IncomeStatement[] {
  const revBy = byPeriodEnd(selectFacts(facts, FLOW.revenue, period, false));
  const costBy = byPeriodEnd(selectFacts(facts, FLOW.cost_of_revenue, period, false));
  const grossBy = byPeriodEnd(selectFacts(facts, FLOW.gross_profit, period, false));
  const opBy = byPeriodEnd(selectFacts(facts, FLOW.operating_income, period, false));
  const niBy = byPeriodEnd(selectFacts(facts, FLOW.net_income, period, false));
  const epsBy = byPeriodEnd(selectFacts(facts, FLOW.earnings_per_share, period, false));
  const shBy = byPeriodEnd(selectFacts(facts, FLOW.shares, period, false));

  return topEnds(revBy, limit).map((end) => {
    const revenue = revBy.get(end) ?? null;
    const cost = costBy.get(end) ?? null;
    // Period-aligned gross profit: reported value, else revenue−cost (same period only).
    const gross = grossBy.get(end) ?? (revenue !== null && cost !== null ? revenue - cost : null);
    return {
      ticker: ticker.toUpperCase(),
      report_period: end,
      fiscal_period: period === 'annual' ? 'FY' : 'Q',
      period,
      revenue,
      cost_of_revenue: cost,
      gross_profit: gross,
      operating_income: opBy.get(end) ?? null,
      net_income: niBy.get(end) ?? null,
      earnings_per_share: epsBy.get(end) ?? null,
      shares: shBy.get(end) ?? null,
    };
  });
}

export function buildBalanceSheets(facts: CompanyFacts, ticker: string, period: Period, limit: number): BalanceSheet[] {
  const assetsBy = byPeriodEnd(selectFacts(facts, INSTANT.total_assets, period, true));
  const curAssetsBy = byPeriodEnd(selectFacts(facts, INSTANT.current_assets, period, true));
  const cashBy = byPeriodEnd(selectFacts(facts, INSTANT.cash, period, true));
  const invBy = byPeriodEnd(selectFacts(facts, INSTANT.inventory, period, true));
  const liabBy = byPeriodEnd(selectFacts(facts, INSTANT.total_liabilities, period, true));
  const curLiabBy = byPeriodEnd(selectFacts(facts, INSTANT.current_liabilities, period, true));
  const equityBy = byPeriodEnd(selectFacts(facts, INSTANT.equity, period, true));
  const reBy = byPeriodEnd(selectFacts(facts, INSTANT.retained_earnings, period, true));
  const ltDebtBy = byPeriodEnd(selectFacts(facts, INSTANT.long_term_debt, period, true));
  const curDebtBy = byPeriodEnd(selectFacts(facts, INSTANT.current_debt, period, true));

  // Total assets anchors the rows (every balance sheet reports it).
  return topEnds(assetsBy, limit).map((end) => {
    const lt = ltDebtBy.get(end);
    const cur = curDebtBy.get(end);
    // Period-aligned total debt: sum of whichever debt legs exist for THIS period-end.
    const totalDebt = lt === undefined && cur === undefined ? null : (lt ?? 0) + (cur ?? 0);
    return {
      ticker: ticker.toUpperCase(),
      report_period: end,
      fiscal_period: period === 'annual' ? 'FY' : 'Q',
      period,
      total_assets: assetsBy.get(end) ?? null,
      current_assets: curAssetsBy.get(end) ?? null,
      cash_and_equivalents: cashBy.get(end) ?? null,
      inventory: invBy.get(end) ?? null,
      total_liabilities: liabBy.get(end) ?? null,
      current_liabilities: curLiabBy.get(end) ?? null,
      total_debt: totalDebt,
      shareholders_equity: equityBy.get(end) ?? null,
      retained_earnings: reBy.get(end) ?? null,
    };
  });
}

export function buildCashFlowStatements(facts: CompanyFacts, ticker: string, period: Period, limit: number): CashFlowStatement[] {
  const ocfBy = byPeriodEnd(selectFacts(facts, FLOW.operating_cash_flow, period, false));
  const capexBy = byPeriodEnd(selectFacts(facts, FLOW.capex, period, false));
  const invBy = byPeriodEnd(selectFacts(facts, FLOW.investing_cf, period, false));
  const finBy = byPeriodEnd(selectFacts(facts, FLOW.financing_cf, period, false));
  const daBy = byPeriodEnd(selectFacts(facts, FLOW.dep_amort, period, false));
  const divBy = byPeriodEnd(selectFacts(facts, FLOW.dividends, period, false));

  // Operating cash flow anchors the rows.
  return topEnds(ocfBy, limit).map((end) => {
    const ocf = ocfBy.get(end) ?? null;
    const capex = capexBy.get(end) ?? null;
    // Period-aligned FCF: OCF − capex, only when both exist for THIS period-end.
    const fcf = ocf !== null && capex !== null ? ocf - capex : null;
    return {
      ticker: ticker.toUpperCase(),
      report_period: end,
      fiscal_period: period === 'annual' ? 'FY' : 'Q',
      period,
      net_cash_flow_from_operations: ocf,
      capital_expenditure: capex,
      free_cash_flow: fcf,
      net_cash_flow_from_investing: invBy.get(end) ?? null,
      net_cash_flow_from_financing: finBy.get(end) ?? null,
      depreciation_and_amortization: daBy.get(end) ?? null,
      dividends_and_other_cash_distributions: divBy.get(end) ?? null,
    };
  });
}

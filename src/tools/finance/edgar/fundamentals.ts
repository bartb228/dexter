/**
 * Assemble Financial-Datasets-shaped income statements from SEC companyfacts.
 *
 * Carries over the correctness lessons from the ai-hedge-fund backend:
 *  - RECENCY-AWARE concept selection (ISS-003): when several us-gaap tags can supply
 *    a metric (e.g. revenue), pick the tag whose data reaches the LATEST period, so a
 *    stale legacy tag can't shadow the current one (the NVDA net-margin bug).
 *  - PERIOD ALIGNMENT (ISS-004/005): a period row only mixes facts that share the
 *    same period-end, never composing across mismatched periods.
 *
 * Slice 1 covers ANNUAL (10-K / fp=FY) — the most verifiable case — plus a
 * best-effort quarterly path. `ttm` is not served here (caller falls back to FD).
 */
import type { CompanyFacts, ConceptFact } from './client.js';
import { conceptFacts } from './client.js';

export interface IncomeStatement {
  ticker: string;
  report_period: string;
  fiscal_period: string;
  period: 'annual' | 'quarterly';
  revenue: number | null;
  cost_of_revenue: number | null;
  gross_profit: number | null;
  operating_income: number | null;
  net_income: number | null;
  earnings_per_share: number | null;
  shares: number | null;
}

// Concept chains (ordered best→fallback). Selection is recency-aware, NOT order-first.
const CHAINS = {
  revenue: ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'RevenueFromContractWithCustomerIncludingAssessedTax', 'SalesRevenueNet'],
  cost_of_revenue: ['CostOfRevenue', 'CostOfGoodsAndServicesSold', 'CostOfGoodsSold'],
  gross_profit: ['GrossProfit'],
  operating_income: ['OperatingIncomeLoss'],
  net_income: ['NetIncomeLoss'],
  earnings_per_share: ['EarningsPerShareDiluted', 'EarningsPerShareBasic'],
  shares: ['WeightedAverageNumberOfDilutedSharesOutstanding', 'WeightedAverageNumberOfSharesOutstandingBasic'],
} as const;

function isAnnual(f: ConceptFact): boolean {
  return f.fp === 'FY' && f.form === '10-K';
}
function dayspan(f: ConceptFact): number | null {
  if (!f.start || !f.end) return null;
  return (Date.parse(f.end) - Date.parse(f.start)) / 86_400_000;
}
function isQuarterly(f: ConceptFact): boolean {
  // 10-Q discrete-quarter fact: ~90-day span (excludes the YTD durations a 10-Q also carries).
  if (f.form !== '10-Q') return false;
  const s = dayspan(f);
  return s === null ? true : s >= 80 && s <= 100;
}

/**
 * Pick the concept from a chain whose qualifying facts reach the latest period-end
 * (recency-aware). Returns the chosen concept's facts for the requested period type.
 */
function selectFacts(facts: CompanyFacts, chain: readonly string[], annual: boolean): ConceptFact[] {
  let best: ConceptFact[] = [];
  let bestEnd = '';
  for (const concept of chain) {
    const all = conceptFacts(facts, concept).filter((f) => (annual ? isAnnual(f) : isQuarterly(f)));
    if (!all.length) continue;
    const latest = all.reduce((m, f) => (f.end > m ? f.end : m), '');
    if (latest > bestEnd) {
      bestEnd = latest;
      best = all;
    }
  }
  return best;
}

/** Dedupe facts to one per period-end (prefer the 10-K/10-Q filing, else latest fy). */
function byPeriodEnd(facts: ConceptFact[]): Map<string, number> {
  const out = new Map<string, ConceptFact>();
  for (const f of facts) {
    const prev = out.get(f.end);
    if (!prev || (f.fy ?? 0) >= (prev.fy ?? 0)) out.set(f.end, f);
  }
  return new Map([...out].map(([end, f]) => [end, f.val]));
}

export function buildIncomeStatements(
  facts: CompanyFacts,
  ticker: string,
  period: 'annual' | 'quarterly',
  limit: number,
): IncomeStatement[] {
  const annual = period === 'annual';
  // Revenue is the anchor: its period-ends define the rows (period-aligned).
  const revBy = byPeriodEnd(selectFacts(facts, CHAINS.revenue, annual));
  const costBy = byPeriodEnd(selectFacts(facts, CHAINS.cost_of_revenue, annual));
  const grossBy = byPeriodEnd(selectFacts(facts, CHAINS.gross_profit, annual));
  const opBy = byPeriodEnd(selectFacts(facts, CHAINS.operating_income, annual));
  const niBy = byPeriodEnd(selectFacts(facts, CHAINS.net_income, annual));
  const epsBy = byPeriodEnd(selectFacts(facts, CHAINS.earnings_per_share, annual));
  const shBy = byPeriodEnd(selectFacts(facts, CHAINS.shares, annual));

  const periodEnds = [...revBy.keys()].sort((a, b) => b.localeCompare(a)).slice(0, limit);

  return periodEnds.map((end) => {
    const revenue = revBy.get(end) ?? null;
    const cost = costBy.get(end) ?? null;
    // Period-aligned gross profit: reported value, else revenue−cost (same period only).
    const gross = grossBy.get(end) ?? (revenue !== null && cost !== null ? revenue - cost : null);
    return {
      ticker: ticker.toUpperCase(),
      report_period: end,
      fiscal_period: annual ? 'FY' : 'Q',
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

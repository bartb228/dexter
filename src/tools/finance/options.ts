/**
 * Options chain with implied volatility + greeks, from the Polygon (Massive)
 * options snapshot API — the only vendor in this stack that exposes vendor-computed
 * IV. Requires POLYGON_API_KEY entitled to options (Options Starter tier or higher);
 * the equity-aggregates tier returns 403 NOT_AUTHORIZED for the snapshot.
 *
 *   /v3/snapshot/options/{ticker}      -> chain (IV/greeks per contract)
 *   /v3/snapshot/options/{ticker}/{c}  -> single contract (reliable IV even after hours)
 *   /v2/aggs/ticker/{ticker}/prev      -> underlying spot (snapshot omits it in the chain)
 *
 * Output is filtered to a near-the-money strike window over the nearest expirations
 * so the chain stays small; the model gets an ATM IV term-structure summary plus the
 * per-contract rows.
 */
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from '../types.js';
import { logger } from '../../utils/logger.js';

const POLYGON_BASE = 'https://api.polygon.io';
const TICKER_RE = /^[A-Za-z0-9.\-]{1,15}$/;
const MAX_CONTRACTS = 80; // bound tokens returned to the model

/** Resolve a usable Polygon key (rejecting the `.env` placeholder). */
function polygonKey(): string {
  const v = process.env.POLYGON_API_KEY;
  return v && v.trim() !== '' && !v.trim().startsWith('your-') ? v.trim() : '';
}

/** True when an options-capable Polygon key is configured. */
export function optionsAvailable(): boolean {
  return polygonKey() !== '';
}

// ── Polygon snapshot response shapes (only the fields we read) ──────────────────
interface PolyGreeks {
  delta?: number;
  gamma?: number;
  theta?: number;
  vega?: number;
}
interface PolyDetails {
  contract_type?: string;
  expiration_date?: string;
  strike_price?: number;
  ticker?: string;
}
interface PolyDay {
  volume?: number;
  close?: number;
}
export interface PolyContract {
  details?: PolyDetails;
  greeks?: PolyGreeks;
  implied_volatility?: number;
  open_interest?: number;
  day?: PolyDay;
}
interface PolySnapshotChain {
  results?: PolyContract[];
  next_url?: string;
}
interface PolySnapshotSingle {
  results?: PolyContract;
}

/** Normalised, model-facing contract row. */
export interface OptionRow {
  expiration: string;
  type: 'call' | 'put';
  strike: number;
  iv: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  open_interest: number | null;
  volume: number | null;
  last: number | null;
  dte: number;
}

const round = (n: number | undefined, dp: number): number | null =>
  typeof n === 'number' && isFinite(n) ? Number(n.toFixed(dp)) : null;

/** Whole days from today (UTC) to an ISO date, floored at 0. */
function daysToExpiry(iso: string): number {
  const exp = new Date(`${iso}T00:00:00Z`).getTime();
  const today = new Date();
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.max(0, Math.round((exp - todayUtc) / 86_400_000));
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Underlying spot from the entitled prev-close aggregate (the chain omits it). */
async function fetchSpot(ticker: string, key: string): Promise<number | null> {
  try {
    const res = await fetch(`${POLYGON_BASE}/v2/aggs/ticker/${encodeURIComponent(ticker)}/prev?apiKey=${key}`);
    if (!res.ok) return null;
    const body = (await res.json()) as { results?: Array<{ c?: number }> };
    return body.results?.[0]?.c ?? null;
  } catch {
    return null;
  }
}

/** One snapshot-chain page over a strike/expiration/type filter. */
async function fetchChain(
  ticker: string,
  key: string,
  opts: { strikeGte?: number; strikeLte?: number; expGte: string; expLte?: string; type?: 'call' | 'put' },
): Promise<PolyContract[]> {
  const q = new URLSearchParams({ limit: '250', sort: 'expiration_date', order: 'asc', apiKey: key });
  if (opts.strikeGte !== undefined) q.set('strike_price.gte', String(Math.floor(opts.strikeGte)));
  if (opts.strikeLte !== undefined) q.set('strike_price.lte', String(Math.ceil(opts.strikeLte)));
  q.set('expiration_date.gte', opts.expGte);
  if (opts.expLte) q.set('expiration_date.lte', opts.expLte);
  if (opts.type) q.set('contract_type', opts.type);

  const res = await fetch(`${POLYGON_BASE}/v3/snapshot/options/${encodeURIComponent(ticker)}?${q}`);
  if (!res.ok) {
    const detail = res.status === 403 ? '403 NOT_AUTHORIZED (key lacks options entitlement)' : `${res.status} ${res.statusText}`;
    throw new Error(`Polygon options snapshot failed: ${detail}`);
  }
  const body = (await res.json()) as PolySnapshotChain;
  return body.results ?? [];
}

/** Single-contract snapshot — reliably carries IV/greeks when the chain row is blank. */
async function fetchContractGreeks(
  underlying: string,
  optionTicker: string,
  key: string,
): Promise<{ iv?: number; greeks?: PolyGreeks }> {
  try {
    const res = await fetch(
      `${POLYGON_BASE}/v3/snapshot/options/${encodeURIComponent(underlying)}/${encodeURIComponent(optionTicker)}?apiKey=${key}`,
    );
    if (!res.ok) return {};
    const body = (await res.json()) as PolySnapshotSingle;
    return { iv: body.results?.implied_volatility, greeks: body.results?.greeks };
  } catch {
    return {};
  }
}

/** Map a raw Polygon contract to a normalised row (exported for tests). */
export function toRow(c: PolyContract): OptionRow | null {
  const d = c.details;
  const type = d?.contract_type;
  if (!d?.expiration_date || typeof d.strike_price !== 'number' || (type !== 'call' && type !== 'put')) {
    return null;
  }
  return {
    expiration: d.expiration_date,
    type,
    strike: d.strike_price,
    iv: round(c.implied_volatility, 4),
    delta: round(c.greeks?.delta, 4),
    gamma: round(c.greeks?.gamma, 4),
    theta: round(c.greeks?.theta, 4),
    vega: round(c.greeks?.vega, 4),
    open_interest: typeof c.open_interest === 'number' ? c.open_interest : null,
    volume: typeof c.day?.volume === 'number' ? c.day.volume : null,
    last: round(c.day?.close, 2),
    dte: daysToExpiry(d.expiration_date),
  };
}

interface IvSummaryRow {
  expiration: string;
  dte: number;
  atm_strike: number;
  atm_call_iv: number | null;
  atm_put_iv: number | null;
}

/** ATM IV per expiration (strike nearest spot), forming an IV term structure (exported for tests). */
export function buildIvSummary(rows: OptionRow[], spot: number | null): IvSummaryRow[] {
  if (spot === null) return [];
  const byExp = new Map<string, OptionRow[]>();
  for (const r of rows) {
    const list = byExp.get(r.expiration) ?? [];
    list.push(r);
    byExp.set(r.expiration, list);
  }
  const summary: IvSummaryRow[] = [];
  for (const [expiration, list] of byExp) {
    const atmStrike = list.reduce((best, r) =>
      Math.abs(r.strike - spot) < Math.abs(best - spot) ? r.strike : best, list[0].strike);
    const atm = list.filter((r) => r.strike === atmStrike);
    const call = atm.find((r) => r.type === 'call');
    const put = atm.find((r) => r.type === 'put');
    summary.push({
      expiration,
      dte: list[0].dte,
      atm_strike: atmStrike,
      atm_call_iv: call?.iv ?? null,
      atm_put_iv: put?.iv ?? null,
    });
  }
  return summary.sort((a, b) => a.dte - b.dte);
}

export const OPTIONS_CHAIN_DESCRIPTION = `
Fetches an equity **options chain with implied volatility (IV) and greeks** (delta,
gamma, theta, vega) plus open interest and volume, from the Polygon (Massive) options
snapshot. Returns a near-the-money slice over the nearest expirations and an ATM IV
term-structure summary.

## When to Use

- Implied volatility for a stock's options (ATM IV, IV by strike/expiration, IV term structure).
- Option greeks (delta/gamma/theta/vega) or open interest for specific contracts.
- "What's AAPL's 30-day IV", "show NVDA calls expiring next month", "put skew on SPY".

## When NOT to Use

- Underlying stock/crypto prices, news, insider/institutional data (use get_market_data).
- Financial statements or ratios (use get_financials). Price forecasts (use kronos_predict).

## Notes

- US-listed equities/ETFs only. IV/greeks are vendor-computed by Polygon.
- Coverage is fullest during market hours; after the close, illiquid strikes may report
  null IV (the ATM summary back-fills from the per-contract snapshot where possible).
- Not investment advice.
`.trim();

const OptionsChainInputSchema = z.object({
  ticker: z.string().describe('Underlying equity/ETF ticker, e.g. AAPL, SPY, NVDA.'),
  expiration: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD')
    .optional()
    .describe('Specific expiration date YYYY-MM-DD. Omit to use the nearest expirations.'),
  option_type: z
    .enum(['call', 'put', 'both'])
    .default('both')
    .describe("Filter by contract type. Defaults to 'both'."),
  moneyness_pct: z
    .number()
    .min(0.01)
    .max(1)
    .default(0.15)
    .describe('Strike window as a fraction around spot (0.15 = ±15%). Defaults to 0.15.'),
  max_expirations: z
    .number()
    .int()
    .min(1)
    .max(8)
    .default(2)
    .describe('How many of the nearest expirations to include when no expiration is given. Defaults to 2.'),
});

export const getOptionsChain = new DynamicStructuredTool({
  name: 'get_options_chain',
  description:
    'Fetch an equity options chain with implied volatility (IV) and greeks (delta/gamma/theta/vega), open interest, and volume, plus an ATM IV term-structure summary. Use for IV, greeks, and options activity. US equities/ETFs only; not investment advice.',
  schema: OptionsChainInputSchema,
  func: async (input) => {
    const ticker = input.ticker.trim().toUpperCase();
    if (!TICKER_RE.test(ticker)) {
      return formatToolResult({ error: `Invalid ticker '${input.ticker}'. Use a plain symbol like AAPL.` }, []);
    }
    const key = polygonKey();
    if (!key) {
      return formatToolResult(
        { error: 'Options data needs POLYGON_API_KEY (Polygon/Massive) entitled to options. Set it in .env.' },
        [],
      );
    }

    const type = input.option_type === 'both' ? undefined : input.option_type;
    const spot = await fetchSpot(ticker, key);
    const window = spot !== null
      ? { strikeGte: spot * (1 - input.moneyness_pct), strikeLte: spot * (1 + input.moneyness_pct) }
      : {};

    let contracts: PolyContract[];
    try {
      contracts = await fetchChain(ticker, key, {
        ...window,
        expGte: input.expiration ?? todayIso(),
        expLte: input.expiration,
        type,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logger.warn(`[Options] ${ticker}: ${message}`);
      return formatToolResult({ error: message }, []);
    }

    let rows = contracts.map(toRow).filter((r): r is OptionRow => r !== null);
    if (rows.length === 0) {
      return formatToolResult(
        { ticker, spot, error: `No options found for ${ticker}${input.expiration ? ` expiring ${input.expiration}` : ''} in the ±${Math.round(input.moneyness_pct * 100)}% strike window.` },
        [],
      );
    }

    // Keep only the nearest N expirations when no specific date was requested.
    if (!input.expiration) {
      const keep = new Set([...new Set(rows.map((r) => r.expiration))].sort().slice(0, input.max_expirations));
      rows = rows.filter((r) => keep.has(r.expiration));
    }

    rows.sort((a, b) => a.dte - b.dte || a.strike - b.strike || a.type.localeCompare(b.type));

    // Back-fill IV/greeks for each expiration's ATM contracts when the chain left them
    // blank (common after hours) — the per-contract snapshot still computes them.
    const summarySeed = buildIvSummary(rows, spot);
    await Promise.all(
      summarySeed.flatMap((s) =>
        rows
          .filter((r) => r.expiration === s.expiration && r.strike === s.atm_strike && r.iv === null)
          .map(async (r) => {
            const found = contracts.find(
              (c) => c.details?.expiration_date === r.expiration && c.details?.strike_price === r.strike && c.details?.contract_type === r.type,
            );
            const optTicker = found?.details?.ticker;
            if (!optTicker) return;
            const { iv, greeks } = await fetchContractGreeks(ticker, optTicker, key);
            r.iv = round(iv, 4);
            r.delta = round(greeks?.delta, 4) ?? r.delta;
            r.gamma = round(greeks?.gamma, 4) ?? r.gamma;
            r.theta = round(greeks?.theta, 4) ?? r.theta;
            r.vega = round(greeks?.vega, 4) ?? r.vega;
          }),
      ),
    );

    const truncated = rows.length > MAX_CONTRACTS;
    const shown = truncated ? rows.slice(0, MAX_CONTRACTS) : rows;

    return formatToolResult(
      {
        ticker,
        spot,
        as_of: todayIso(),
        source: 'Polygon (Massive) options snapshot',
        iv_summary: buildIvSummary(shown, spot),
        contracts: shown,
        ...(truncated ? { note: `Showing ${MAX_CONTRACTS} of ${rows.length} contracts; narrow with expiration/option_type/moneyness_pct.` } : {}),
      },
      ['https://polygon.io (Massive) options snapshot — IV + greeks'],
    );
  },
});

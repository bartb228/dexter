/**
 * Options chain with implied volatility + greeks. Primary source is the Polygon
 * (Massive) options snapshot — the entitled vendor that exposes vendor-computed IV.
 * When no options-entitled POLYGON_API_KEY is set (or the Polygon call fails, e.g.
 * 403 NOT_AUTHORIZED on a non-entitled key), it falls back to CBOE's free
 * delayed-quotes feed (~15-min delayed) so IV/greeks work with no paid key.
 *
 *   Polygon /v3/snapshot/options/{ticker}      -> chain (IV/greeks per contract)
 *   Polygon /v3/snapshot/options/{ticker}/{c}  -> single contract (reliable IV after hours)
 *   Polygon /v2/aggs/ticker/{ticker}/prev      -> underlying spot (snapshot omits it)
 *   CBOE    /global/delayed_quotes/options/{sym}.json -> full chain + spot (free, delayed)
 *
 * Both providers normalise to the same OptionRow shape and share the tail
 * (near-the-money window, nearest expirations, ATM IV term-structure summary), so the
 * model-facing output is identical regardless of which vendor answered.
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

/** The free CBOE delayed-quotes fallback is on unless explicitly disabled. */
export function cboeEnabled(): boolean {
  const v = (process.env.OPTIONS_CBOE_FALLBACK ?? '').trim().toLowerCase();
  return v !== 'false' && v !== '0' && v !== 'off' && v !== 'no';
}

/**
 * True when options data can be served — an entitled Polygon key, or the free CBOE
 * fallback. CBOE needs no key, so options are available by default.
 */
export function optionsAvailable(): boolean {
  return polygonKey() !== '' || cboeEnabled();
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

// ── Shared tail (provider-agnostic) ─────────────────────────────────────────────

/** Keep only the nearest `maxExpirations` expiration dates. */
function narrowToNearest(rows: OptionRow[], maxExpirations: number): OptionRow[] {
  const keep = new Set([...new Set(rows.map((r) => r.expiration))].sort().slice(0, maxExpirations));
  return rows.filter((r) => keep.has(r.expiration));
}

/** Truncate to a token budget and build the final model-facing result. */
function formatChain(
  ticker: string,
  spot: number | null,
  rows: OptionRow[],
  source: string,
  sourceUrl: string,
): string {
  const truncated = rows.length > MAX_CONTRACTS;
  const shown = truncated ? rows.slice(0, MAX_CONTRACTS) : rows;
  return formatToolResult(
    {
      ticker,
      spot,
      as_of: todayIso(),
      source,
      iv_summary: buildIvSummary(shown, spot),
      contracts: shown,
      ...(truncated ? { note: `Showing ${MAX_CONTRACTS} of ${rows.length} contracts; narrow with expiration/option_type/moneyness_pct.` } : {}),
    },
    [sourceUrl],
  );
}

// ── CBOE free delayed-quotes provider ───────────────────────────────────────────
// Equities/ETFs: /options/{SYM}.json ; cash indices use a leading underscore (_SPX).
const CBOE_BASE = 'https://cdn.cboe.com/api/global/delayed_quotes/options';

interface CboeContract {
  option?: string; // OCC symbol, e.g. "AAPL260803C00205000"
  iv?: number; // decimal fraction (matches Polygon), NOT percent
  delta?: number;
  gamma?: number;
  theta?: number;
  vega?: number;
  open_interest?: number;
  volume?: number;
  last_trade_price?: number;
}
interface CboeResponse {
  data?: { options?: CboeContract[]; current_price?: number; close?: number };
}

/**
 * Parse an OCC option symbol from the right (roots vary in length):
 * last 8 = strike×1000, char[-9] = C/P, [-15..-9] = YYMMDD, remainder = root.
 * Exported for tests.
 */
export function parseOccSymbol(occ: string): { expiration: string; type: 'call' | 'put'; strike: number } | null {
  if (typeof occ !== 'string' || occ.length < 16) return null;
  const s = occ.trim().toUpperCase();
  const strikePart = s.slice(-8);
  const cp = s.charAt(s.length - 9);
  const datePart = s.slice(s.length - 15, s.length - 9);
  if (!/^\d{8}$/.test(strikePart) || !/^\d{6}$/.test(datePart) || (cp !== 'C' && cp !== 'P')) return null;
  const month = Number(datePart.slice(2, 4));
  const day = Number(datePart.slice(4, 6));
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return {
    expiration: `20${datePart.slice(0, 2)}-${datePart.slice(2, 4)}-${datePart.slice(4, 6)}`,
    type: cp === 'C' ? 'call' : 'put',
    strike: Number(strikePart) / 1000,
  };
}

/** Map a raw CBOE delayed-quote contract to a normalised row (exported for tests). */
export function cboeRowFromContract(c: CboeContract): OptionRow | null {
  const parsed = c.option ? parseOccSymbol(c.option) : null;
  if (!parsed) return null;
  const last = typeof c.last_trade_price === 'number' && c.last_trade_price > 0 ? c.last_trade_price : undefined;
  return {
    expiration: parsed.expiration,
    type: parsed.type,
    strike: parsed.strike,
    iv: round(c.iv, 4),
    delta: round(c.delta, 4),
    gamma: round(c.gamma, 4),
    theta: round(c.theta, 4),
    vega: round(c.vega, 4),
    open_interest: typeof c.open_interest === 'number' ? c.open_interest : null,
    volume: typeof c.volume === 'number' ? c.volume : null,
    last: round(last, 2),
    dte: daysToExpiry(parsed.expiration),
  };
}

async function fetchCboeRaw(sym: string): Promise<CboeResponse | null> {
  try {
    const res = await fetch(`${CBOE_BASE}/${encodeURIComponent(sym)}.json`);
    if (!res.ok) return null;
    return (await res.json()) as CboeResponse;
  } catch {
    return null;
  }
}

/** Fetch + normalise a full CBOE chain (never throws — returns an error shape instead). */
async function fetchCboe(ticker: string): Promise<{ spot: number | null; rows: OptionRow[] } | { error: string }> {
  let body = await fetchCboeRaw(ticker);
  if (!body?.data?.options?.length) body = await fetchCboeRaw(`_${ticker}`); // retry as a cash index
  const data = body?.data;
  if (!data?.options?.length) return { error: `No CBOE options data for ${ticker}.` };
  const spot =
    typeof data.current_price === 'number' ? data.current_price : typeof data.close === 'number' ? data.close : null;
  const rows = data.options.map(cboeRowFromContract).filter((r): r is OptionRow => r !== null);
  if (rows.length === 0) return { error: `CBOE returned no parseable option contracts for ${ticker}.` };
  return { spot, rows };
}

export const OPTIONS_CHAIN_DESCRIPTION = `
Fetches an equity **options chain with implied volatility (IV) and greeks** (delta,
gamma, theta, vega) plus open interest and volume, from the Polygon (Massive) options
snapshot — or a free CBOE ~15-min-delayed feed when no options-entitled key is set.
Returns a near-the-money slice over the nearest expirations and an ATM IV
term-structure summary.

## When to Use

- Implied volatility for a stock's options (ATM IV, IV by strike/expiration, IV term structure).
- Option greeks (delta/gamma/theta/vega) or open interest for specific contracts.
- "What's AAPL's 30-day IV", "show NVDA calls expiring next month", "put skew on SPY".

## When NOT to Use

- Underlying stock/crypto prices, news, insider/institutional data (use get_market_data).
- Financial statements or ratios (use get_financials). Price forecasts (use kronos_predict).

## Notes

- US-listed equities/ETFs only. IV/greeks are vendor-computed (Polygon, or CBOE on the
  free fallback). The result's \`source\` field names which vendor answered; CBOE data is
  ~15-min delayed.
- Coverage is fullest during market hours; after the close, illiquid strikes may report
  null IV (on Polygon the ATM summary back-fills from the per-contract snapshot).
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

type OptionsChainInput = z.infer<typeof OptionsChainInputSchema>;

/**
 * Polygon (Massive) path. THROWS on a hard failure (non-OK snapshot, e.g. a 403 from a
 * non-entitled key) so the caller can fall through to CBOE; a successful-but-empty chain
 * returns its own message (no fallback — the vendor answered, there just wasn't anything).
 */
async function runPolygon(ticker: string, input: OptionsChainInput, key: string): Promise<string> {
  const type = input.option_type === 'both' ? undefined : input.option_type;
  const spot = await fetchSpot(ticker, key);
  const window = spot !== null
    ? { strikeGte: spot * (1 - input.moneyness_pct), strikeLte: spot * (1 + input.moneyness_pct) }
    : {};

  const contracts = await fetchChain(ticker, key, {
    ...window,
    expGte: input.expiration ?? todayIso(),
    expLte: input.expiration,
    type,
  });

  let rows = contracts.map(toRow).filter((r): r is OptionRow => r !== null);
  if (rows.length === 0) {
    return formatToolResult(
      { ticker, spot, error: `No options found for ${ticker}${input.expiration ? ` expiring ${input.expiration}` : ''} in the ±${Math.round(input.moneyness_pct * 100)}% strike window.` },
      [],
    );
  }

  // Keep only the nearest N expirations when no specific date was requested.
  if (!input.expiration) rows = narrowToNearest(rows, input.max_expirations);

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

  return formatChain(ticker, spot, rows, 'Polygon (Massive) options snapshot', 'https://polygon.io (Massive) options snapshot — IV + greeks');
}

/**
 * CBOE free delayed-quotes path. Never throws (fetchCboe returns an error shape). CBOE
 * returns the whole chain already carrying IV/greeks, so filtering is client-side and no
 * per-contract back-fill is needed.
 */
async function runCboe(ticker: string, input: OptionsChainInput): Promise<string> {
  const fetched = await fetchCboe(ticker);
  if ('error' in fetched) return formatToolResult({ ticker, error: fetched.error }, []);
  const { spot } = fetched;

  const type = input.option_type === 'both' ? undefined : input.option_type;
  let rows = fetched.rows.filter((r) => {
    if (type && r.type !== type) return false;
    if (input.expiration && r.expiration !== input.expiration) return false;
    if (spot !== null && (r.strike < spot * (1 - input.moneyness_pct) || r.strike > spot * (1 + input.moneyness_pct))) return false;
    return true;
  });

  if (rows.length === 0) {
    return formatToolResult(
      { ticker, spot, error: `No options found for ${ticker}${input.expiration ? ` expiring ${input.expiration}` : ''} in the ±${Math.round(input.moneyness_pct * 100)}% strike window (CBOE).` },
      [],
    );
  }

  if (!input.expiration) rows = narrowToNearest(rows, input.max_expirations);
  rows.sort((a, b) => a.dte - b.dte || a.strike - b.strike || a.type.localeCompare(b.type));

  return formatChain(ticker, spot, rows, 'CBOE delayed quotes (~15-min delayed)', 'https://www.cboe.com/delayed_quotes/ — free delayed options (IV + greeks)');
}

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

    // Polygon primary when an entitled key is configured; fall through to CBOE on a hard
    // failure (e.g. 403 from a non-entitled key) unless the fallback is disabled.
    const key = polygonKey();
    if (key) {
      try {
        return await runPolygon(ticker, input, key);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        logger.warn(`[Options] ${ticker}: Polygon path failed (${message})${cboeEnabled() ? '; falling back to CBOE delayed quotes' : ''}`);
        if (!cboeEnabled()) return formatToolResult({ error: message }, []);
      }
    }

    if (cboeEnabled()) return await runCboe(ticker, input);

    return formatToolResult(
      { error: 'Options data needs POLYGON_API_KEY (Polygon/Massive) entitled to options, or the free CBOE fallback enabled (OPTIONS_CBOE_FALLBACK).' },
      [],
    );
  },
});

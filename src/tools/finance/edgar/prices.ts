/**
 * Free/keyed daily price provider for the EDGAR backend — Polygon primary, Tiingo
 * fallback (both keyed; the same keys ai-hedge-fund uses). SEC EDGAR has no market
 * prices, so under DATA_BACKEND=edgar these providers replace Financial Datasets.
 *
 * Output matches FD's price shapes: historical bars are
 * `{ date, open, high, low, close, volume }`; a snapshot is the latest bar plus
 * `price` (= close). Both providers degrade to [] / null on any error so the
 * caller can fall back to FD.
 */
import { logger } from '../../../utils/logger.js';

export interface PriceBar {
  date: string; // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

type Interval = 'day' | 'week' | 'month' | 'year';

function hasKey(name: string): boolean {
  const v = process.env[name];
  return !!v && v.trim() !== '' && !v.trim().startsWith('your-');
}

/** True when a keyed price provider is configured (Polygon or Tiingo). */
export function hasPriceProvider(): boolean {
  return hasKey('POLYGON_API_KEY') || hasKey('TIINGO_API_KEY');
}

// ── Polygon (aggregates) ───────────────────────────────────────────────────────
async function polygonBars(ticker: string, interval: Interval, start: string, end: string): Promise<PriceBar[]> {
  const key = process.env.POLYGON_API_KEY;
  if (!key) return [];
  const sym = encodeURIComponent(ticker.toUpperCase());
  const q = new URLSearchParams({ adjusted: 'true', sort: 'asc', limit: '50000', apiKey: key });
  const url = `https://api.polygon.io/v2/aggs/ticker/${sym}/range/1/${interval}/${start}/${end}?${q}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Polygon ${res.status}`);
  const body = (await res.json()) as { results?: Array<{ t: number; o: number; h: number; l: number; c: number; v: number }> };
  return (body.results ?? []).map((b) => ({
    date: new Date(b.t).toISOString().slice(0, 10),
    open: b.o,
    high: b.h,
    low: b.l,
    close: b.c,
    volume: b.v,
  }));
}

// ── Tiingo (daily) ─────────────────────────────────────────────────────────────
async function tiingoBars(ticker: string, start: string, end: string): Promise<PriceBar[]> {
  const key = process.env.TIINGO_API_KEY;
  if (!key) return [];
  const sym = encodeURIComponent(ticker.toLowerCase());
  const q = new URLSearchParams({ startDate: start, endDate: end, format: 'json', token: key });
  const res = await fetch(`https://api.tiingo.com/tiingo/daily/${sym}/prices?${q}`);
  if (!res.ok) throw new Error(`Tiingo ${res.status}`);
  const rows = (await res.json()) as Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }>;
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => ({
    date: String(r.date).slice(0, 10),
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    volume: r.volume,
  }));
}

/**
 * Historical OHLCV bars (chronological). Polygon first; Tiingo fallback (Tiingo is
 * daily-only, so it serves `day` requests). Returns [] when all providers fail.
 */
export async function edgarStockPrices(ticker: string, interval: Interval, start: string, end: string): Promise<PriceBar[]> {
  try {
    const bars = await polygonBars(ticker, interval, start, end);
    if (bars.length) return bars;
  } catch (e) {
    logger.warn(`[Prices] Polygon failed (${ticker}): ${e instanceof Error ? e.message : String(e)}`);
  }
  if (interval === 'day') {
    try {
      return await tiingoBars(ticker, start, end);
    } catch (e) {
      logger.warn(`[Prices] Tiingo failed (${ticker}): ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return [];
}

/**
 * Latest-close snapshot derived from the most recent daily bar (last ~7 days).
 * Returns FD-snapshot shape `{ price, close, open, high, low, volume, time }` or
 * null when no recent bar is available.
 */
export async function edgarStockSnapshot(ticker: string): Promise<Record<string, unknown> | null> {
  // Look back a week to skip weekends/holidays; dates are UTC ISO.
  const today = new Date();
  const end = today.toISOString().slice(0, 10);
  const start = new Date(today.getTime() - 7 * 86_400_000).toISOString().slice(0, 10);
  const bars = await edgarStockPrices(ticker, 'day', start, end);
  if (!bars.length) return null;
  const last = bars[bars.length - 1];
  return {
    ticker: ticker.toUpperCase(),
    price: last.close,
    close: last.close,
    open: last.open,
    high: last.high,
    low: last.low,
    volume: last.volume,
    time: last.date,
  };
}

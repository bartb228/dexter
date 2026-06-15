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
 * Near-real-time quote from Tiingo's free IEX endpoint (current-day, ~15-min delayed) —
 * gives a CURRENT price rather than the previous daily close. Returns null on miss.
 */
async function tiingoIexQuote(ticker: string): Promise<Record<string, unknown> | null> {
  const key = process.env.TIINGO_API_KEY;
  if (!key) return null;
  const sym = encodeURIComponent(ticker.toUpperCase());
  const res = await fetch(`https://api.tiingo.com/iex/?tickers=${sym}&token=${encodeURIComponent(key)}`);
  if (!res.ok) throw new Error(`Tiingo IEX ${res.status}`);
  const arr = (await res.json()) as Array<{ last?: number; tngoLast?: number; prevClose?: number; open?: number; high?: number; low?: number; volume?: number; timestamp?: string }>;
  const q = Array.isArray(arr) ? arr[0] : null;
  const price = q?.tngoLast ?? q?.last ?? q?.prevClose;
  if (!q || price == null) return null;
  return {
    ticker: ticker.toUpperCase(),
    price,
    close: price,
    prev_close: q.prevClose ?? null,
    open: q.open ?? null,
    high: q.high ?? null,
    low: q.low ?? null,
    volume: q.volume ?? null,
    time: q.timestamp ?? null,
    source: 'tiingo-iex (near-real-time, ~15-min delayed)',
  };
}

/**
 * Current-price snapshot: prefer the near-real-time Tiingo IEX quote (today's price);
 * fall back to the most recent daily bar's close (last ~7 days) if IEX is unavailable.
 * Returns FD-snapshot shape `{ price, close, open, high, low, volume, time }` or null.
 */
export async function edgarStockSnapshot(ticker: string): Promise<Record<string, unknown> | null> {
  // Near-real-time first so "current price" isn't a stale prior close.
  try {
    const live = await tiingoIexQuote(ticker);
    if (live) return live;
  } catch (e) {
    logger.warn(`[Prices] Tiingo IEX failed (${ticker}); falling back to last daily close: ${e instanceof Error ? e.message : String(e)}`);
  }
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

// ── crypto (Polygon X: aggregates → Tiingo crypto) ───────────────────────────────
type CryptoInterval = 'minute' | 'day' | 'week' | 'month' | 'year';

/** Map an FD-style crypto ticker ("BTC-USD") to provider symbols (Polygon "X:BTCUSD", Tiingo "btcusd"). */
function cryptoSyms(fdTicker: string): { polygon: string; tiingo: string } {
  const bare = fdTicker.toUpperCase().replace(/[-/]/g, '');
  return { polygon: `X:${bare}`, tiingo: bare.toLowerCase() };
}

async function polygonCryptoBars(fdTicker: string, interval: CryptoInterval, multiplier: number, start: string, end: string): Promise<PriceBar[]> {
  const key = process.env.POLYGON_API_KEY;
  if (!key) return [];
  const sym = encodeURIComponent(cryptoSyms(fdTicker).polygon);
  const mult = Math.max(1, Math.floor(multiplier));
  const q = new URLSearchParams({ adjusted: 'true', sort: 'asc', limit: '50000', apiKey: key });
  const res = await fetch(`https://api.polygon.io/v2/aggs/ticker/${sym}/range/${mult}/${interval}/${start}/${end}?${q}`);
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

async function tiingoCryptoBars(fdTicker: string, start: string, end: string): Promise<PriceBar[]> {
  const key = process.env.TIINGO_API_KEY;
  if (!key) return [];
  const q = new URLSearchParams({ tickers: cryptoSyms(fdTicker).tiingo, startDate: start, endDate: end, resampleFreq: '1day', token: key });
  const res = await fetch(`https://api.tiingo.com/tiingo/crypto/prices?${q}`);
  if (!res.ok) throw new Error(`Tiingo ${res.status}`);
  const data = (await res.json()) as Array<{ priceData?: Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }> }>;
  const rows = Array.isArray(data) && data[0]?.priceData ? data[0].priceData : [];
  return rows.map((r) => ({ date: String(r.date).slice(0, 10), open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume }));
}

/** Historical crypto OHLCV: Polygon first; Tiingo daily fallback. Returns [] on failure. */
export async function edgarCryptoPrices(fdTicker: string, interval: CryptoInterval, multiplier: number, start: string, end: string): Promise<PriceBar[]> {
  try {
    const bars = await polygonCryptoBars(fdTicker, interval, multiplier, start, end);
    if (bars.length) return bars;
  } catch (e) {
    logger.warn(`[Prices] Polygon crypto failed (${fdTicker}): ${e instanceof Error ? e.message : String(e)}`);
  }
  if (interval === 'day') {
    try {
      return await tiingoCryptoBars(fdTicker, start, end);
    } catch (e) {
      logger.warn(`[Prices] Tiingo crypto failed (${fdTicker}): ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return [];
}

/** Latest-close crypto snapshot from the most recent daily bar. */
export async function edgarCryptoSnapshot(fdTicker: string): Promise<Record<string, unknown> | null> {
  const today = new Date();
  const end = today.toISOString().slice(0, 10);
  const start = new Date(today.getTime() - 7 * 86_400_000).toISOString().slice(0, 10);
  const bars = await edgarCryptoPrices(fdTicker, 'day', 1, start, end);
  if (!bars.length) return null;
  const last = bars[bars.length - 1];
  return {
    ticker: fdTicker.toUpperCase(),
    price: last.close,
    close: last.close,
    open: last.open,
    high: last.high,
    low: last.low,
    volume: last.volume,
    time: last.date,
  };
}

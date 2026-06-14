/**
 * Free SEC EDGAR data client (TypeScript port of the ai-hedge-fund Python backend).
 *
 * Replaces the paid Financial Datasets API for US-equity fundamentals. SEC's
 * `data.sec.gov` XBRL companyfacts API is plain JSON, so this stays a self-contained
 * TS module — no Python runtime. Dexter routes to it when `DATA_BACKEND=edgar`.
 *
 * SEC rules honored: a descriptive `EDGAR_USER_AGENT` is MANDATORY (SEC blocks
 * traffic without one), and requests are paced to ≤10 req/s. Responses are cached
 * to `.dexter/cache/edgar/` (companyfacts is large; ticker→CIK map is small).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'fs';
import { dexterPath } from '../../../utils/paths.js';
import { logger } from '../../../utils/logger.js';

const SEC_TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
const SEC_FACTS_URL = (cik: string) => `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`;
const CACHE_DIR = dexterPath('cache/edgar');
const TICKERS_TTL_MS = 24 * 60 * 60 * 1000; // 1 day
const FACTS_TTL_MS = 24 * 60 * 60 * 1000; // 1 day
const MIN_REQUEST_SPACING_MS = 110; // ≤10 req/s with margin

export class EdgarError extends Error {}

/** SEC requires a descriptive User-Agent (e.g. "QuantStack you@example.com"). */
function userAgent(): string {
  const ua = process.env.EDGAR_USER_AGENT;
  if (!ua || !ua.trim()) {
    throw new EdgarError(
      'EDGAR_USER_AGENT is not set. SEC requires a descriptive User-Agent ' +
        '(e.g. EDGAR_USER_AGENT="YourApp your@email.com"). Set it to use DATA_BACKEND=edgar.',
    );
  }
  return ua.trim();
}

// ── process-wide rate limiter (≤10 req/s) ──────────────────────────────────────
let lastRequestAt = 0;
async function paced<T>(fn: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const wait = MIN_REQUEST_SPACING_MS - (now - lastRequestAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
  return fn();
}

function ensureCacheDir(): void {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
}

function readCache<T>(file: string, ttlMs: number): T | null {
  try {
    if (!existsSync(file)) return null;
    if (Date.now() - statSync(file).mtimeMs > ttlMs) return null;
    return JSON.parse(readFileSync(file, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function writeCacheSafe(file: string, data: unknown): void {
  try {
    ensureCacheDir();
    writeFileSync(file, JSON.stringify(data));
  } catch (e) {
    logger.warn(`[EDGAR] cache write failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await paced(() => fetch(url, { headers: { 'User-Agent': userAgent(), Accept: 'application/json' } }));
  if (!res.ok) throw new EdgarError(`SEC request failed ${res.status} for ${url}`);
  return res.json() as Promise<T>;
}

// ── ticker → CIK ────────────────────────────────────────────────────────────────
interface TickerEntry { cik_str: number; ticker: string; title: string }
let tickerMapCache: Map<string, string> | null = null;

async function loadTickerMap(): Promise<Map<string, string>> {
  if (tickerMapCache) return tickerMapCache;
  const file = `${CACHE_DIR}/company_tickers.json`;
  let raw = readCache<Record<string, TickerEntry>>(file, TICKERS_TTL_MS);
  if (!raw) {
    raw = await fetchJson<Record<string, TickerEntry>>(SEC_TICKERS_URL);
    writeCacheSafe(file, raw);
  }
  const map = new Map<string, string>();
  for (const entry of Object.values(raw)) {
    if (entry?.ticker && typeof entry.cik_str === 'number') {
      map.set(entry.ticker.toUpperCase(), String(entry.cik_str).padStart(10, '0'));
    }
  }
  tickerMapCache = map;
  return map;
}

/**
 * Resolve a ticker to its zero-padded 10-digit CIK. Handles dual-class share
 * classes: SEC uses a DASH (BRK-B) while users often type a DOT (BRK.B), so we
 * try the symbol as-is, then swap dot↔dash. Returns null if unknown.
 */
export async function getCik(ticker: string): Promise<string | null> {
  const map = await loadTickerMap();
  const t = ticker.toUpperCase().trim();
  return map.get(t) ?? map.get(t.replace(/\./g, '-')) ?? map.get(t.replace(/-/g, '.')) ?? null;
}

// ── companyfacts ─────────────────────────────────────────────────────────────
export interface ConceptFact {
  end: string; // period-end YYYY-MM-DD
  start?: string; // period-start (duration concepts only)
  val: number;
  fy?: number;
  fp?: string; // FY, Q1..Q4
  form?: string; // 10-K, 10-Q, ...
  frame?: string;
}
export interface CompanyFacts {
  cik: number;
  entityName: string;
  facts: { 'us-gaap'?: Record<string, { units: Record<string, ConceptFact[]> }>; [taxon: string]: unknown };
}

export async function getCompanyFacts(cik: string): Promise<CompanyFacts> {
  const file = `${CACHE_DIR}/facts_${cik}.json`;
  const cached = readCache<CompanyFacts>(file, FACTS_TTL_MS);
  if (cached) return cached;
  const data = await fetchJson<CompanyFacts>(SEC_FACTS_URL(cik));
  writeCacheSafe(file, data);
  return data;
}

/**
 * All facts for a us-gaap concept under its USD (or USD/shares, or pure) unit.
 * Returns [] when the concept or a numeric unit is absent.
 */
export function conceptFacts(facts: CompanyFacts, concept: string): ConceptFact[] {
  const node = facts.facts?.['us-gaap']?.[concept];
  if (!node?.units) return [];
  // Prefer USD; fall back to USD/shares (EPS) or the first numeric unit (shares).
  const units = node.units;
  const key = units['USD'] ? 'USD' : units['USD/shares'] ? 'USD/shares' : Object.keys(units)[0];
  return key ? (units[key] ?? []) : [];
}

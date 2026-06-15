/**
 * Free SEC Form 4 insider transactions (TS port of the ai-hedge-fund parser).
 *
 * Flow: ticker→CIK → submissions feed → recent Form 4 filings → fetch each raw
 * ownership XML → parse non-derivative transactions. Shares are SIGNED from the
 * Acquired/Disposed code (A = +, D = −), NOT the transaction code — an open-market
 * sale is code S with A/D = D, so the sign comes from A/D.
 *
 * Form 4 XML uses camelCase element names; linkedom is HTML-mode (it lowercases
 * tags), so we use targeted string extraction over the fixed Form 4 schema. DTD /
 * ENTITY payloads are rejected before parsing (XXE / billion-laughs backstop).
 *
 * Output matches FD's `insider_trades` shape (name/title/transaction_shares/…) plus
 * a few display aliases (full_name/officer_title/transaction_type/shares/price_per_share)
 * so both the LLM (raw JSON) and the get_market_data formatter render correctly.
 */
import { getCik, getSubmissions, fetchText, type Submissions } from './client.js';
import { logger } from '../../../utils/logger.js';

export interface InsiderTrade {
  ticker: string;
  issuer: string | null;
  name: string | null;
  title: string | null;
  is_board_director: boolean | null;
  transaction_date: string | null;
  transaction_shares: number | null;
  transaction_price_per_share: number | null;
  transaction_value: number | null;
  shares_owned_before_transaction: number | null;
  shares_owned_after_transaction: number | null;
  security_title: string | null;
  filing_date: string | null;
  // display aliases for formatInsiderTrades:
  full_name: string | null;
  officer_title: string | null;
  transaction_type: 'buy' | 'sell' | null;
  shares: number | null;
  price_per_share: number | null;
}

function inner(scope: string, tag: string): string | null {
  const m = scope.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? m[1] : null;
}
/** Text of <tag>, unwrapping a nested <value> when present (Form 4 wraps most fields). */
function tagText(scope: string, tag: string): string | null {
  const block = inner(scope, tag);
  if (block === null) return null;
  const v = inner(block, 'value');
  const out = (v !== null ? v : block).trim();
  return out || null;
}
function tagNum(scope: string, tag: string): number | null {
  const t = tagText(scope, tag);
  if (t === null) return null;
  const n = Number(t.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}
function allBlocks(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'gi'))].map((m) => m[1]);
}

/** Parse one Form 4 ownership XML into signed insider trades. Returns [] on anything unsafe/malformed. */
export function parseForm4(xml: string, ticker: string, filingDate: string): InsiderTrade[] {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
    logger.warn('[EDGAR] Form 4 rejected: DTD/ENTITY payload');
    return [];
  }
  const issuer = tagText(xml, 'issuerName');
  const name = tagText(xml, 'rptOwnerName');
  const officerTitle = tagText(xml, 'officerTitle');
  const isDirectorRaw = tagText(xml, 'isDirector');
  const isDirector = isDirectorRaw === null ? null : isDirectorRaw === '1' || isDirectorRaw.toLowerCase() === 'true';
  const title = officerTitle ?? (isDirector ? 'Director' : null);

  const trades: InsiderTrade[] = [];
  for (const block of allBlocks(xml, 'nonDerivativeTransaction')) {
    const ad = tagText(block, 'transactionAcquiredDisposedCode');
    const sign = ad === 'D' ? -1 : 1;
    const sharesRaw = tagNum(block, 'transactionShares');
    const shares = sharesRaw === null ? null : sign * sharesRaw;
    const price = tagNum(block, 'transactionPricePerShare');
    const value = shares !== null && price !== null ? shares * price : null;
    const after = tagNum(block, 'sharesOwnedFollowingTransaction');
    const before = after !== null && shares !== null ? after - shares : null;
    trades.push({
      ticker: ticker.toUpperCase(),
      issuer,
      name,
      title,
      is_board_director: isDirector,
      transaction_date: tagText(block, 'transactionDate'),
      transaction_shares: shares,
      transaction_price_per_share: price,
      transaction_value: value,
      shares_owned_before_transaction: before,
      shares_owned_after_transaction: after,
      security_title: tagText(block, 'securityTitle'),
      filing_date: filingDate,
      full_name: name,
      officer_title: title,
      transaction_type: shares === null ? null : shares >= 0 ? 'buy' : 'sell',
      shares,
      price_per_share: price,
    });
  }
  return trades;
}

interface Form4Filing { accession: string; doc: string; filingDate: string }

/** Form 4 filings within [startDate, endDate], newest-first. */
export function recentForm4Filings(subs: Submissions, endDate?: string, startDate?: string): Form4Filing[] {
  const r = subs.filings?.recent;
  if (!r?.form) return [];
  const out: Form4Filing[] = [];
  for (let i = 0; i < r.form.length; i++) {
    if (r.form[i] !== '4') continue;
    const fd = r.filingDate?.[i] ?? '';
    if (startDate && fd < startDate) continue;
    if (endDate && fd > endDate) continue;
    out.push({ accession: r.accessionNumber?.[i] ?? '', doc: r.primaryDocument?.[i] ?? '', filingDate: fd });
  }
  return out.sort((a, b) => b.filingDate.localeCompare(a.filingDate));
}

/** Raw ownership XML URL: strip any XSL subdir (xslF345X05/) to the basename at the accession root. */
export function form4Url(cik: string, accession: string, doc: string): string {
  const accNoDash = accession.replace(/-/g, '');
  const cikInt = String(Number(cik)); // SEC Archives path uses the CIK without leading zeros
  const base = doc.split('/').pop() ?? doc;
  return `https://www.sec.gov/Archives/edgar/data/${cikInt}/${accNoDash}/${base}`;
}

const MAX_FILINGS = 60; // bound requests (each is rate-paced)

/**
 * Insider trades from SEC Form 4, FD-shaped. Iterates recent filings newest-first,
 * accumulating signed transactions up to `limit`. Returns [] for an unknown ticker.
 */
export async function fetchInsiderTrades(
  ticker: string,
  opts: { limit?: number; endDate?: string; startDate?: string } = {},
): Promise<InsiderTrade[]> {
  const limit = opts.limit ?? 10;
  const cik = await getCik(ticker);
  if (!cik) return [];
  const subs = await getSubmissions(cik);
  const filings = recentForm4Filings(subs, opts.endDate, opts.startDate).slice(0, MAX_FILINGS);

  const trades: InsiderTrade[] = [];
  for (const f of filings) {
    if (trades.length >= limit) break;
    try {
      const xml = await fetchText(form4Url(cik, f.accession, f.doc));
      trades.push(...parseForm4(xml, ticker, f.filingDate));
    } catch (e) {
      logger.warn(`[EDGAR] Form 4 fetch/parse failed (${ticker} ${f.accession}): ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return trades.slice(0, limit);
}

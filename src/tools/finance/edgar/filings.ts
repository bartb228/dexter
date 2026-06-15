/**
 * Free SEC filings via EDGAR — metadata from the submissions feed and document
 * text from the Archives. Under DATA_BACKEND=edgar this replaces Financial
 * Datasets' /filings/ and /filings/items/ endpoints.
 *
 * Note on items: FD pre-segments filings into named items (Item-1A, etc.). EDGAR
 * serves the raw primary document, so the item tools return the FULL filing text
 * (HTML→text) for the agent to read — not pre-cut sections. Correct content, free.
 */
import { getCik, getSubmissions, fetchText } from './client.js';

export interface FilingMeta {
  ticker: string;
  filing_type: string;
  accession_number: string;
  filing_date: string;
  primary_document: string;
  url: string;
}

/** Archives URL for a filing document: CIK without leading zeros, accession without dashes. */
function archiveUrl(cik: string, accession: string, doc: string): string {
  const accNoDash = accession.replace(/-/g, '');
  const cikInt = String(Number(cik));
  return `https://www.sec.gov/Archives/edgar/data/${cikInt}/${accNoDash}/${doc}`;
}

/** Filing metadata (most-recent-first), optionally filtered by form type(s). */
export async function edgarFilings(ticker: string, filingTypes?: string[], limit = 10): Promise<FilingMeta[]> {
  const cik = await getCik(ticker);
  if (!cik) return [];
  const r = (await getSubmissions(cik)).filings?.recent;
  if (!r?.form) return [];
  const want = filingTypes && filingTypes.length ? new Set(filingTypes) : null;
  const out: FilingMeta[] = [];
  for (let i = 0; i < r.form.length; i++) {
    const form = r.form[i];
    if (want && !want.has(form)) continue;
    const accession = r.accessionNumber?.[i] ?? '';
    const doc = r.primaryDocument?.[i] ?? '';
    out.push({
      ticker: ticker.toUpperCase(),
      filing_type: form,
      accession_number: accession,
      filing_date: r.filingDate?.[i] ?? '',
      primary_document: doc,
      url: doc ? archiveUrl(cik, accession, doc) : '',
    });
  }
  out.sort((a, b) => b.filing_date.localeCompare(a.filing_date));
  return out.slice(0, limit);
}

const MAX_TEXT = 400_000; // protect context against pathologically large filings

/** Strip HTML to readable text: drop script/style, tags→space, decode common entities. */
function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*\n\s*/g, '\n\n')
    .trim();
}

export interface FilingText {
  ticker: string;
  accession_number: string;
  filing_type: string;
  filing_date: string;
  url: string;
  text: string;
  truncated: boolean;
  note: string;
}

/** Full primary-document text for a filing accession. Returns null if not found. */
export async function edgarFilingText(ticker: string, accessionNumber: string): Promise<FilingText | null> {
  const cik = await getCik(ticker);
  if (!cik) return null;
  const r = (await getSubmissions(cik)).filings?.recent;
  if (!r?.accessionNumber) return null;
  const target = accessionNumber.replace(/-/g, '');
  const i = r.accessionNumber.findIndex((a) => a.replace(/-/g, '') === target);
  if (i < 0) return null;
  const doc = r.primaryDocument?.[i] ?? '';
  if (!doc) return null;
  const url = archiveUrl(cik, accessionNumber, doc);
  const raw = await fetchText(url);
  const full = htmlToText(raw);
  const truncated = full.length > MAX_TEXT;
  return {
    ticker: ticker.toUpperCase(),
    accession_number: accessionNumber,
    filing_type: r.form?.[i] ?? '',
    filing_date: r.filingDate?.[i] ?? '',
    url,
    text: truncated ? full.slice(0, MAX_TEXT) : full,
    truncated,
    note: 'EDGAR returns the full filing document text (item-level segmentation is not available on the free backend); locate sections within the text.',
  };
}

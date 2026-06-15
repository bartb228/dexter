/**
 * Free SEC Form 13F institutional holdings (FILER direction).
 *
 * Flow: filer CIK (given, or resolved from a name via EDGAR company search) →
 * submissions feed → latest 13F-HR → discover the information-table XML in the
 * accession (the `.xml` that isn't primary_doc/xsl) → parse the holdings.
 *
 * Same string-extraction approach as the Form 4 insider parser. The "who holds
 * <ticker>" direction is NOT supported on free data — SEC has no security→filers
 * reverse index — so that path degrades upstream.
 */
import { getSubmissions, fetchText, type Submissions } from './client.js';
import { logger } from '../../../utils/logger.js';

export interface Holding {
  name_of_issuer: string | null;
  title_of_class: string | null;
  cusip: string | null;
  value_usd: number | null;
  shares: number | null;
  shares_type: string | null;
  investment_discretion: string | null;
}
export interface InstitutionalHoldings {
  filer: string | null;
  cik: string;
  report_period: string | null;
  filing_date: string | null;
  total_value_usd: number;
  n_positions: number;
  positions: Holding[];
  note: string;
}

function inner(scope: string, tag: string): string | null {
  const m = scope.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? m[1] : null;
}
function tagText(scope: string, tag: string): string | null {
  const b = inner(scope, tag);
  if (b === null) return null;
  const v = inner(b, 'value');
  const out = (v !== null ? v : b).trim();
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

/** Resolve a manager name → CIK via EDGAR company search (browse-edgar atom). */
export async function resolveFilerCik(name: string): Promise<{ cik: string; name: string } | null> {
  const q = encodeURIComponent(name.trim());
  const url = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&company=${q}&type=13F-HR&output=atom&count=3`;
  try {
    const atom = await fetchText(url);
    const cikM = atom.match(/<cik>(\d+)<\/cik>/i);
    if (!cikM) return null;
    const nameM = atom.match(/<conformed-name>([^<]+)<\/conformed-name>/i);
    return { cik: cikM[1].padStart(10, '0'), name: nameM ? nameM[1].trim() : name };
  } catch (e) {
    logger.warn(`[13F] filer name resolution failed (${name}): ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

interface PickOpts { report_period?: string; gte?: string; lte?: string; gt?: string; lt?: string }

function pick13F(subs: Submissions, o: PickOpts): { accession: string; reportDate: string; filingDate: string } | null {
  const r = subs.filings?.recent;
  if (!r?.form) return null;
  const out: Array<{ accession: string; reportDate: string; filingDate: string }> = [];
  for (let i = 0; i < r.form.length; i++) {
    if (!r.form[i].startsWith('13F-HR')) continue;
    const rp = r.reportDate?.[i] ?? '';
    // A date filter excludes a filing with a missing reportDate (don't let it slip through).
    if (o.report_period && rp !== o.report_period) continue;
    if (o.gte && (!rp || rp < o.gte)) continue;
    if (o.lte && (!rp || rp > o.lte)) continue;
    if (o.gt && (!rp || rp <= o.gt)) continue;
    if (o.lt && (!rp || rp >= o.lt)) continue;
    out.push({ accession: r.accessionNumber?.[i] ?? '', reportDate: rp, filingDate: r.filingDate?.[i] ?? '' });
  }
  out.sort((a, b) => (b.reportDate || b.filingDate).localeCompare(a.reportDate || a.filingDate));
  return out[0] ?? null;
}

/** Find the information-table XML in an accession (the .xml that isn't the cover/xsl). */
async function infoTableUrl(cik: string, accession: string): Promise<string | null> {
  const accNoDash = accession.replace(/-/g, '');
  const base = `https://www.sec.gov/Archives/edgar/data/${String(Number(cik))}/${accNoDash}`;
  const idx = JSON.parse(await fetchText(`${base}/index.json`)) as { directory?: { item?: Array<{ name?: string }> } };
  const items = idx.directory?.item ?? [];
  const it = items.find((x) => {
    const n = (x.name ?? '').toLowerCase();
    return n.endsWith('.xml') && !n.includes('/') && n !== 'primary_doc.xml' && !n.includes('xsl') && !n.includes('primary_doc');
  });
  return it?.name ? `${base}/${it.name}` : null;
}

function parseInfoTable(xml: string): Holding[] {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
    logger.warn('[13F] info table rejected: DTD/ENTITY payload');
    return [];
  }
  return allBlocks(xml, 'infoTable').map((b) => {
    const shrs = inner(b, 'shrsOrPrnAmt') ?? b;
    return {
      name_of_issuer: tagText(b, 'nameOfIssuer'),
      title_of_class: tagText(b, 'titleOfClass'),
      cusip: tagText(b, 'cusip'),
      value_usd: tagNum(b, 'value'),
      shares: tagNum(shrs, 'sshPrnamt'),
      shares_type: tagText(shrs, 'sshPrnamtType'),
      investment_discretion: tagText(b, 'investmentDiscretion'),
    };
  });
}

export async function edgarInstitutionalHoldings(opts: {
  filerCik?: string;
  filerName?: string;
  limit?: number;
} & PickOpts): Promise<InstitutionalHoldings | null> {
  let cik = opts.filerCik ? opts.filerCik.padStart(10, '0') : null;
  let filerName: string | null = null;
  if (!cik && opts.filerName) {
    const r = await resolveFilerCik(opts.filerName);
    if (!r) return null;
    cik = r.cik;
    filerName = r.name;
  }
  if (!cik) return null;

  const subs = await getSubmissions(cik);
  filerName = filerName ?? subs.name ?? null;
  const f = pick13F(subs, opts);
  if (!f) return null;

  const url = await infoTableUrl(cik, f.accession);
  if (!url) return null;

  const all = parseInfoTable(await fetchText(url));
  all.sort((a, b) => (b.value_usd ?? 0) - (a.value_usd ?? 0));
  const total = all.reduce((s, p) => s + (p.value_usd ?? 0), 0);
  return {
    filer: filerName,
    cik,
    report_period: f.reportDate || null,
    filing_date: f.filingDate || null,
    total_value_usd: total,
    n_positions: all.length,
    positions: all.slice(0, Math.min(opts.limit ?? 10, 200)),
    note: 'SEC Form 13F-HR; value_usd is the filing’s reported value (whole USD).',
  };
}

/** Resolve institutional investor name(s) → {name, cik} via EDGAR company search. */
export async function edgarInstitutionalInvestors(name: string): Promise<{ investors: Array<{ name: string; cik: string }> }> {
  const r = await resolveFilerCik(name);
  return { investors: r ? [{ name: r.name, cik: r.cik }] : [] };
}

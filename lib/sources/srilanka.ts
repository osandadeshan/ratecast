import { SRI_LANKA_META, USER_AGENT } from "../config";
import { getBytes, getText } from "./http";
import { readXlsxSheet, type SheetRow } from "./srilanka-xlsx";

/**
 * Sri Lanka-specific series from the Central Bank of Sri Lanka (CBSL), all keyless and automatic.
 * The USD→LKR leg carries most of the SGD→LKR variance, so these are the inputs most likely to matter.
 *
 * - Daily indicative USD/LKR spot rate and SGD/LKR indicative rate: CBSL's exchange-rate lookup
 *   (an HTML form POST that returns a table; history back to 2006).
 * - Monthly policy rate (OPR) and 3-month Treasury bill yield: statistical table 4.04 (.xlsx).
 * - Monthly workers' remittances and tourism earnings (USD mn): tables 2.14.2 / 2.14.1 (.xlsx).
 *
 * The .xlsx file names carry their publication date (table4.04_20261012.xlsx), so each fetch first
 * reads the statistics page and picks the newest link. Monthly values are dated at month end.
 */

export interface Point {
  date: string;
  value: number;
}

const CBSL = "https://www.cbsl.gov.lk";
const SPOT_URL = `${CBSL}/cbsl_custom/exrates/exrates_results_spot_mid.php`;
const INDICATIVE_URL = `${CBSL}/cbsl_custom/exrates/exrates_results.php`;
const MONETARY_PAGE = `${CBSL}/en/statistics/statistical-tables/monetary-sector`;
const EXTERNAL_PAGE = `${CBSL}/en/statistics/statistical-tables/external-sector`;
const PRICES_PAGE = `${CBSL}/en/statistics/statistical-tables/real-sector/prices-wages-employment`;

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const monthIndex = (s: string | undefined) => MONTHS.indexOf((s ?? "").trim().toLowerCase());
const monthEnd = (year: number, month0: number) => new Date(Date.UTC(year, month0 + 1, 0)).toISOString().slice(0, 10);
const todayUtc = () => new Date().toISOString().slice(0, 10);

/** Form POST (CBSL's rate lookup has no GET endpoint). Same UA / timeout / no-store rules as http.ts. */
async function postForm(url: string, fields: [string, string][], timeoutMs = 25_000): Promise<string> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "User-Agent": USER_AGENT, "Content-Type": "application/x-www-form-urlencoded", Accept: "text/html,*/*;q=0.8" },
    body: new URLSearchParams(fields).toString(),
    signal: AbortSignal.timeout(timeoutMs),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.text();
}

/** CBSL rate lookup result: table rows "<td>YYYY-MM-DD</td><td>332.3516</td>…" (first rate column = LKR per unit). */
export function parseCbslRateTable(html: string): Point[] {
  const out = new Map<string, number>();
  for (const row of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...row[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) => c[1].replace(/<[^>]+>/g, "").trim());
    const v = Number(cells[1]?.replace(/,/g, ""));
    if (/^\d{4}-\d{2}-\d{2}$/.test(cells[0] ?? "") && Number.isFinite(v) && v > 0) out.set(cells[0], v);
  }
  return [...out.entries()].map(([date, value]) => ({ date, value })).sort((a, b) => a.date.localeCompare(b.date));
}

async function fetchCbslRates(url: string, currency: string, start: string, what: string): Promise<Point[]> {
  const html = await postForm(url, [
    ["lookupPage", "lookup_daily_exchange_rates.php"],
    ["startRange", "2006-11-11"],
    ["rangeType", "dates"],
    ["txtStart", start],
    ["txtEnd", todayUtc()],
    ["chk_cur[]", currency],
    ["submit_button", "Submit"],
  ]);
  const out = parseCbslRateTable(html);
  if (!out.length) throw new Error(`CBSL ${what}: no rows parsed (form or table layout changed?)`);
  return out;
}

/** Daily indicative USD/LKR spot rate (LKR per 1 USD), business days only. */
export const fetchCbslUsdSpot = (start: string) => fetchCbslRates(SPOT_URL, "USD~US Dollar", start, "USD spot");

/** Daily indicative SGD/LKR rate (LKR per 1 SGD), business days only. */
export const fetchCbslSgdIndicative = (start: string) =>
  fetchCbslRates(INDICATIVE_URL, "SGD~Singapore Dollar", start, "SGD indicative");

/** Newest "sheets/<prefix>_YYYYMMDD[_e].xlsx" link on a CBSL statistics page (the date is in the name). */
export function latestSheetUrl(pageHtml: string, prefix: string): string | null {
  const re = new RegExp(`href="([^"]*sheets/${prefix.replace(/\./g, "\\.")}_(\\d{8})(?:_e)?\\.xlsx)"`, "g");
  let best: { url: string; stamp: string } | null = null;
  for (const m of pageHtml.matchAll(re)) if (!best || m[2] > best.stamp) best = { url: m[1], stamp: m[2] };
  return best ? new URL(best.url, CBSL).toString() : null;
}

async function fetchSheet(page: string, prefix: string): Promise<SheetRow[]> {
  const url = latestSheetUrl(await getText(page), prefix);
  if (!url) throw new Error(`CBSL: no ${prefix}_*.xlsx link on ${page}`);
  return readXlsxSheet(await getBytes(url));
}

/**
 * Table 4.04 "Interest Rates - Monthly": the year is in column B (January rows only), the month in C.
 * Returns one column as month-end points; non-numeric cells ("-", ranges like "8.00-8.50") are skipped.
 */
export function parseInterestRates(rows: SheetRow[], column: string): Point[] {
  const out: Point[] = [];
  let year = 0;
  for (const r of rows) {
    if (/^\d{4}$/.test(r.B ?? "")) year = Number(r.B);
    const m = monthIndex(r.C);
    if (!year || m < 0) continue;
    const v = Number(r[column]);
    if (r[column] !== undefined && Number.isFinite(v) && v > 0) out.push({ date: monthEnd(year, m), value: v });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** Column letters in table 4.04 (checked against the header on 2026-11-11). */
const COL_OPR = "D"; // Overnight Policy Rate (from late 2024)
const COL_TBILL_3M = "H"; // Treasury bills, primary market yield, 3-month

async function fetchInterest(column: string, start: string, what: string): Promise<Point[]> {
  const rows = await fetchSheet(MONETARY_PAGE, "table4.04");
  // Guard against a column shift: the header row must still name what we expect in that column.
  const header = rows.slice(0, 8).map((r) => r[column] ?? "").join(" ");
  const expect = column === COL_OPR ? /Overnight Policy Rate/i : /Primary Market|3-Month|Treasury Bills/i;
  if (!expect.test(header)) throw new Error(`CBSL table 4.04: column ${column} is no longer ${what} (layout changed)`);
  const out = parseInterestRates(rows, column).filter((p) => p.date >= start);
  if (!out.length) throw new Error(`CBSL table 4.04: no ${what} values`);
  return out;
}

export const fetchCbslPolicyRate = (start: string) => fetchInterest(COL_OPR, start, "policy rate (OPR)");
export const fetchCbslTbill3m = (start: string) => fetchInterest(COL_TBILL_3M, start, "3-month T-bill yield");

/**
 * Tables 2.14.x (remittances, tourism): one header row of years (C=2009, D=2010, …), then one row per
 * month with the name in column B ("Total" and footnote rows are ignored). Returns month-end points
 * in USD mn; zero/empty cells are skipped.
 */
export function parseMonthByYearTable(rows: SheetRow[]): Point[] {
  // Year cells may carry footnote marks: "2026 (b)(c)".
  const yearOf = (v: string) => v.match(/^((?:19|20)\d{2})(?:\s*\([a-z]\))*$/)?.[1];
  const header = rows.find((r) => Object.values(r).filter((v) => yearOf(v)).length >= 5);
  if (!header) return [];
  const years = Object.entries(header).flatMap(([col, v]) => (yearOf(v) ? [[col, yearOf(v)!] as const] : []));
  const out: Point[] = [];
  for (const r of rows) {
    const m = monthIndex(r.B);
    if (m < 0) continue;
    for (const [col, y] of years) {
      const v = Number(r[col]);
      if (r[col] !== undefined && Number.isFinite(v) && v > 0) out.push({ date: monthEnd(Number(y), m), value: v });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

async function fetchMonthly(prefix: string, title: RegExp, start: string, what: string): Promise<Point[]> {
  const rows = await fetchSheet(EXTERNAL_PAGE, prefix);
  if (!title.test(rows.slice(0, 3).map((r) => Object.values(r).join(" ")).join(" "))) {
    throw new Error(`CBSL ${prefix}: sheet is no longer "${what}" (layout changed)`);
  }
  const out = parseMonthByYearTable(rows).filter((p) => p.date >= start);
  if (!out.length) throw new Error(`CBSL ${prefix}: no ${what} values`);
  return out;
}

export const fetchCbslRemittances = (start: string) =>
  fetchMonthly("table2.14.2", /Workers.? Remittances/i, start, "workers' remittances");
export const fetchCbslTourism = (start: string) => fetchMonthly("table2.14.1", /Earnings from Tourism/i, start, "tourism earnings");

/**
 * "Movements of the Colombo Consumer Price Index (CCPI)": rows "2026 October" in column B; the
 * year-on-year % change of the headline CCPI is the column whose header row says "Year-on-Year"
 * (G on 2026-11-14). Month-end points. The sheet keeps only the last ~13 months, so history builds up
 * in market_data run by run.
 */
export function parseCcpiYoy(rows: SheetRow[]): Point[] {
  const head = rows.find((r) => Object.values(r).some((v) => /Year-on-Year/i.test(v)));
  const col = head && Object.entries(head).find(([, v]) => /Year-on-Year/i.test(v))?.[0];
  if (!col) return [];
  const out: Point[] = [];
  for (const r of rows) {
    const m = (r.B ?? "").trim().match(/^(\d{4})\s+([A-Za-z]+)$/);
    const mi = m ? monthIndex(m[2]) : -1;
    const v = Number(r[col]);
    if (m && mi >= 0 && r[col] !== undefined && r[col] !== "" && Number.isFinite(v)) out.push({ date: monthEnd(Number(m[1]), mi), value: Math.round(v * 100) / 100 });
  }
  const uniq = new Map(out.map((p) => [p.date, p]));
  return [...uniq.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export async function fetchCbslCcpiYoy(start: string): Promise<Point[]> {
  const rows = await fetchSheet(PRICES_PAGE, "CCPI_and_CCPI_CORE");
  if (!/Colombo Consumer Price Index/i.test(rows.slice(0, 3).map((r) => Object.values(r).join(" ")).join(" "))) {
    throw new Error("CBSL CCPI: sheet is no longer the Colombo CPI (layout changed)");
  }
  const out = parseCcpiYoy(rows).filter((p) => p.date >= start);
  if (!out.length) throw new Error("CBSL CCPI: no year-on-year values");
  return out;
}

/**
 * Everything the integrator needs to wire these into market_data / MACRO_FACTORS.
 * - series: market_data name (data: never rename once stored).
 * - lagDays: days after a point's date before the 09:30 SGT sync can rely on having it
 *   (monthly points are dated at month end; lags are conservative, from observed publication dates).
 * - transform: "log" for levels/prices, "diff" for rates in percentage points.
 * - frequency / maxStaleDays: how far a value may be carried forward before it counts as missing.
 * - source: source_health key (series from the same download share one).
 */
const labelOf = (s: string) => SRI_LANKA_META.find((m) => m.series === s)?.label ?? s;

export const SRI_LANKA_SERIES = [
  {
    series: "lk_usd_spot",
    label: labelOf("lk_usd_spot"),
    lagDays: 1,
    transform: "log",
    frequency: "daily",
    maxStaleDays: 7,
    source: "cbsl-fx",
    fetch: fetchCbslUsdSpot,
  },
  {
    series: "lk_sgd_ind",
    label: labelOf("lk_sgd_ind"),
    lagDays: 1,
    transform: "log",
    frequency: "daily",
    maxStaleDays: 7,
    source: "cbsl-fx",
    fetch: fetchCbslSgdIndicative,
  },
  {
    series: "lk_opr",
    label: labelOf("lk_opr"),
    lagDays: 60,
    transform: "diff",
    frequency: "monthly",
    maxStaleDays: 100,
    source: "cbsl-rates",
    fetch: fetchCbslPolicyRate,
  },
  {
    series: "lk_tbill3m",
    label: labelOf("lk_tbill3m"),
    lagDays: 60,
    transform: "diff",
    frequency: "monthly",
    maxStaleDays: 100,
    source: "cbsl-rates",
    fetch: fetchCbslTbill3m,
  },
  {
    series: "lk_remit",
    label: labelOf("lk_remit"),
    lagDays: 45,
    transform: "log",
    frequency: "monthly",
    maxStaleDays: 80,
    source: "cbsl-external",
    fetch: fetchCbslRemittances,
  },
  {
    series: "lk_tourism",
    label: labelOf("lk_tourism"),
    lagDays: 45,
    transform: "log",
    frequency: "monthly",
    maxStaleDays: 80,
    source: "cbsl-external",
    fetch: fetchCbslTourism,
  },
  {
    // Context only (not in LANKA_FACTORS): the sheet holds ~13 months, too short to learn from yet.
    // DCS publishes on the month's last working day (Oct 2026 on 2026-10-30), so 5 days is conservative.
    series: "lk_ccpi_yoy",
    label: labelOf("lk_ccpi_yoy"),
    lagDays: 5,
    transform: "diff",
    frequency: "monthly",
    maxStaleDays: 45,
    source: "cbsl-prices",
    fetch: fetchCbslCcpiYoy,
  },
] as const;

export type SriLankaSeries = (typeof SRI_LANKA_SERIES)[number]["series"];

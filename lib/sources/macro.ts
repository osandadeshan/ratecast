import { getText } from "./http";

/**
 * Macro factors for the `macro` model, keyless and with years of history:
 * - US Treasury daily par yield curve (CSV per year): 2-year yield = market's expected Fed path.
 * - FRED Brent crude (DCOILBRENTEU, CSV). EIA-sourced, so it lags ~1 week; MACRO_FACTORS.lagDays
 *   in lib/config.ts makes replay and live use the same delay.
 * Values are stored in market_data under the series names below.
 */

export interface Point {
  date: string;
  value: number;
}

const treasuryUrl = (year: number) =>
  "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/" +
  `${year}/all?type=daily_treasury_yield_curve&field_tdr_date_value=${year}&page&_format=csv`;

const fredUrl = (id: string, start: string) => `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=${start}`;

/**
 * home.treasury.gov delays any request whose User-Agent contains a "+https://…" bot-style URL by
 * ~18 s (measured 2026-11-11: the app's default UA took 17–19 s, this plain one ~0.4 s, same
 * 200 response). A plain client name is still honest, so Treasury alone gets this override.
 */
const TREASURY_REQUEST = { userAgent: "RateCast/1.0", accept: "text/csv,*/*;q=0.8", timeoutMs: 40_000 };

/** Split one CSV line (Treasury quotes header cells). */
const cells = (line: string) => line.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));

/** Parse a Treasury yield-curve CSV and return one column ("2 Yr") as points. Columns vary by year. */
export function parseTreasuryCsv(csv: string, column = "2 Yr"): Point[] {
  const lines = csv.trim().split(/\r?\n/);
  const header = cells(lines[0] ?? "");
  const col = header.indexOf(column);
  if (col < 0) return [];
  const out: Point[] = [];
  for (const line of lines.slice(1)) {
    const c = cells(line);
    const m = c[0]?.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    const v = Number(c[col]);
    if (m && c[col] !== "" && Number.isFinite(v)) out.push({ date: `${m[3]}-${m[1]}-${m[2]}`, value: v });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

export async function fetchTreasury2y(years: number[]): Promise<Point[]> {
  // One year at a time, to stay polite to home.treasury.gov.
  const out: Point[] = [];
  for (const y of years) out.push(...parseTreasuryCsv(await getText(treasuryUrl(y), TREASURY_REQUEST)));
  if (!out.length) throw new Error("Treasury CSV: no '2 Yr' values (layout changed?)");
  return out;
}

/** FRED graph CSV: "observation_date,SERIES" then "YYYY-MM-DD,value" ("." = missing). */
export function parseFredCsv(csv: string): Point[] {
  const out: Point[] = [];
  for (const line of csv.trim().split(/\r?\n/).slice(1)) {
    const [date, raw] = line.split(",");
    const v = Number(raw);
    if (/^\d{4}-\d{2}-\d{2}$/.test(date ?? "") && raw !== "." && Number.isFinite(v) && v > 0) out.push({ date, value: v });
  }
  return out;
}

/** Fed broad trade-weighted dollar index (DTWEXBGS, H.10, weekly release of daily values). */
export async function fetchUsdBroad(start: string): Promise<Point[]> {
  const out = parseFredCsv(await getText(fredUrl("DTWEXBGS", start), 25_000));
  if (!out.length) throw new Error("FRED DTWEXBGS: no values");
  return out;
}

export async function fetchBrent(start: string): Promise<Point[]> {
  const out = parseFredCsv(await getText(fredUrl("DCOILBRENTEU", start), 25_000));
  if (!out.length) throw new Error("FRED DCOILBRENTEU: no values");
  return out;
}

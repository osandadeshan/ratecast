import { addDays } from "../dates";
import type { EventRecord } from "../predict/events";
import { getBytes, getJSON, getText } from "./http";
import { compact, pdfText } from "./pdf";

/**
 * Policy-event calendars, all fetched automatically (no hand-entered dates):
 * - Fed: FOMC page (history + next year's schedule) and the Fed calendar JSON (fallback).
 * - CBSL: the Monetary Policy Review list (every past review date, from the PDF file names) and
 *   the latest review PDF, which states the date of the next one.
 * - CBSL RSS: IMF programme news, recorded after the fact.
 * Each source fails independently; sync records its health in `source_health`.
 */

export interface SourceResult {
  source: string;
  events: EventRecord[];
  error?: string;
  /** Not a failure, but worth showing (e.g. "next date not announced yet"). */
  note?: string;
}

const FED_PAGE = "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm";
const FED_JSON = "https://www.federalreserve.gov/json/calendar.json";
const CBSL_MPR = "https://www.cbsl.gov.lk/en/press/press-releases/monetary-policy-review";
const CBSL_RSS = "https://www.cbsl.gov.lk/en/rss.xml";

/** The FOMC publishes its schedule more than a year ahead; assume it was public 300 days before. */
const FOMC_LEAD_DAYS = 300;

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
/** 1-12 for a full month name or its 3-letter abbreviation ("Apr"), else 0. */
const monthNum = (name: string) => {
  const n = name.toLowerCase();
  return MONTHS.findIndex((m) => m === n || m.slice(0, 3) === n) + 1;
};
const iso = (y: number, m: number, d: number) =>
  `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

function htmlTokens(html: string): string[] {
  return html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, "\u0001")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .split("\u0001")
    .map((t) => t.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function fomcEvent(date: string, unscheduled: boolean, source: string, url: string): EventRecord {
  return {
    kind: "fomc",
    eventDate: date,
    knownSince: unscheduled ? date : addDays(date, -FOMC_LEAD_DAYS),
    source,
    title: unscheduled ? "FOMC decision (unscheduled meeting)" : "FOMC rate decision",
    url,
  };
}

/** Parse "YYYY FOMC Meetings" sections: a month token ("June", "Apr/May") then days ("16-17*"). */
export function parseFomcPage(html: string): EventRecord[] {
  const tokens = htmlTokens(html);
  const out: EventRecord[] = [];
  let year = 0;
  for (let i = 0; i < tokens.length - 1; i++) {
    const head = tokens[i].match(/^(\d{4}) FOMC Meetings$/);
    if (head) {
      year = Number(head[1]);
      continue;
    }
    if (!year) continue;
    const mon = tokens[i].match(/^([A-Z][a-z]+)(?:\/([A-Z][a-z]+))?$/);
    if (!mon || monthNum(mon[1]) < 1) continue;
    const days = tokens[i + 1].match(/^(\d{1,2})(?:-(\d{1,2}))?\*?\s*(?:\((unscheduled|notation vote|cancelled)\))?$/i);
    if (!days) continue;
    const note = days[3]?.toLowerCase();
    if (note === "notation vote" || note === "cancelled") continue;
    const start = Number(days[1]);
    const end = days[2] ? Number(days[2]) : start;
    const m = mon[2] && end < start ? monthNum(mon[2]) : monthNum(mon[1]);
    if (m < 1) continue;
    // Jan/Feb style meetings that roll into the next month stay within the same year.
    out.push(fomcEvent(iso(year, m, end), note === "unscheduled", "fed-page", FED_PAGE));
  }
  return out;
}

interface FedCalendar {
  events: { type?: string; title?: string; month?: string; days?: string }[];
}

export function parseFomcJson(cal: FedCalendar): EventRecord[] {
  const out: EventRecord[] = [];
  for (const e of cal.events ?? []) {
    if (e.type !== "FOMC" || !/^\s*fomc meeting\s*$/i.test(e.title ?? "") || !e.month) continue;
    const [y, m] = e.month.split("-").map(Number);
    const day = Number(String(e.days ?? "").match(/(\d{1,2})\s*$/)?.[1]);
    if (y && m && day) out.push(fomcEvent(iso(y, m, day), false, "fed-json", FED_JSON));
  }
  return out;
}

export async function fetchFomc(): Promise<SourceResult[]> {
  const [page, json] = await Promise.allSettled([getText(FED_PAGE), getJSON<FedCalendar>(FED_JSON)]);
  const res: SourceResult[] = [];
  res.push(
    page.status === "fulfilled"
      ? { source: "fed-page", events: parseFomcPage(page.value) }
      : { source: "fed-page", events: [], error: String(page.reason) },
  );
  res.push(
    json.status === "fulfilled"
      ? { source: "fed-json", events: parseFomcJson(json.value) }
      : { source: "fed-json", events: [], error: String(json.reason) },
  );
  for (const r of res) if (!r.error && r.events.length === 0) r.error = "parsed 0 meetings (page layout changed?)";
  return res;
}

/** Past CBSL reviews from the list page: press_YYYYMMDD_Monetary_Policy_Review_No_N_YYYY_*.pdf */
export function parseCbslList(html: string): { date: string; url: string }[] {
  const seen = new Map<string, string>();
  for (const m of html.matchAll(/href="([^"]*press_(\d{4})(\d{2})(\d{2})_Monetary_Policy_Review[^"]*\.pdf)"/gi)) {
    const date = `${m[2]}-${m[3]}-${m[4]}`;
    if (!seen.has(date)) seen.set(date, new URL(m[1], CBSL_MPR).toString());
  }
  return [...seen.entries()].map(([date, url]) => ({ date, url })).sort((a, b) => a.date.localeCompare(b.date));
}

/** "The release of the next regular statement ... will be on 20 November 2026." */
export function parseCbslNextDate(text: string): string | null {
  const t = compact(text);
  const m = t.match(
    /next(?:regular)?statement.{0,80}?(?:on|for)(\d{1,2})(January|February|March|April|May|June|July|August|September|October|November|December),?(\d{4})/i,
  );
  return m ? iso(Number(m[3]), monthNum(m[2]), Number(m[1])) : null;
}

export async function fetchCbslReviews(): Promise<SourceResult> {
  const source = "cbsl-mpr";
  try {
    const list = parseCbslList(await getText(CBSL_MPR));
    if (!list.length) return { source, events: [], error: "no review PDFs found (page layout changed?)" };
    const events: EventRecord[] = list.map((r, i) => {
      const prev = list[i - 1];
      // Each statement announces the next review date, so it was public from the previous review on.
      const knownSince = prev && r.date > prev.date && r.date <= addDays(prev.date, 120) ? prev.date : addDays(r.date, -56);
      return { kind: "cbsl_policy", eventDate: r.date, knownSince, source, title: "CBSL monetary policy review", url: r.url };
    });
    const latest = list[list.length - 1];
    const next = parseCbslNextDate(pdfText(await getBytes(latest.url)));
    if (!next) {
      // The year's last review (Nov/Dec) doesn't name the next one: CBSL publishes a new yearly
      // schedule instead, and the first review of the new year names its successor again.
      const yearEnd = Number(latest.date.slice(5, 7)) >= 11;
      return yearEnd
        ? { source, events, note: "next review date not announced yet (year-end statement)" }
        : { source, events, error: `next review date not found in ${latest.url}` };
    }
    if (next > latest.date) {
      events.push({
        kind: "cbsl_policy",
        eventDate: next,
        knownSince: latest.date,
        source,
        title: "CBSL monetary policy review (scheduled)",
        url: latest.url,
      });
    }
    return { source, events };
  } catch (e) {
    return { source, events: [], error: (e as Error).message };
  }
}

/** "The Committee decided to lower / maintain / raise the target range ..." */
export function classifyFomc(html: string): string | null {
  const t = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const m = t.match(/decided to (lower|reduce|cut|maintain|keep|raise|increase)\b[^.]{0,60}target range/i);
  if (!m) return null;
  const v = m[1].toLowerCase();
  return v === "maintain" || v === "keep" ? "hold" : v === "raise" || v === "increase" ? "hike" : "cut";
}

/** CBSL headline, e.g. "The Central Bank of Sri Lanka keeps the OPR unchanged" / "further reduces the OPR". */
export function classifyCbsl(text: string): string | null {
  const t = compact(text);
  const head = t.match(/TheCentralBankofSriLanka(.{0,120}?)(?:TheMonetaryPolicyBoard|$)/i)?.[1] ?? "";
  if (!head) return null;
  // "increases" contains "eases", so test tightening words first.
  if (/increases|raises|tightens|hikes/i.test(head)) return "hike";
  if (/reduces|lowers|eases|cuts|decreases/i.test(head)) return "cut";
  if (/keeps|maintains|unchanged|holds|leaves/i.test(head)) return "hold";
  return null;
}

export function classifyImf(title: string): string {
  if (/staff[- ]level agreement/i.test(title)) return "sla";
  if (/executive board|approv|disburse/i.test(title)) return "board";
  return "other";
}

const fomcStatementUrl = (date: string) =>
  `https://www.federalreserve.gov/newsevents/pressreleases/monetary${date.replaceAll("-", "")}a.htm`;

/**
 * Classify past events that have no outcome yet by reading their own statement (FOMC HTML,
 * CBSL review PDF). Bounded per run so a first sync stays fast; the rest follow on later runs.
 */
export async function fetchOutcomes(
  pending: EventRecord[],
  maxFetches = 32,
): Promise<{ results: { kind: string; eventDate: string; outcome: string }[]; error?: string }> {
  const results: { kind: string; eventDate: string; outcome: string }[] = [];
  const errors: string[] = [];
  for (const e of pending.slice(0, maxFetches)) {
    try {
      let outcome: string | null = null;
      if (e.kind === "fomc") {
        outcome = classifyFomc(await getText(fomcStatementUrl(e.eventDate)));
      } else if (e.kind === "cbsl_policy") {
        // Only the review's own PDF (file name carries its date), never the previous statement.
        if (!e.url || !e.url.includes(`press_${e.eventDate.replaceAll("-", "")}_`)) continue;
        outcome = classifyCbsl(pdfText(await getBytes(e.url)));
      } else if (e.kind === "imf") {
        outcome = classifyImf(e.title);
      }
      results.push({ kind: e.kind, eventDate: e.eventDate, outcome: outcome ?? "unclear" });
    } catch (err) {
      errors.push(`${e.kind} ${e.eventDate}: ${(err as Error).message}`);
    }
  }
  return { results, error: errors.length ? errors.slice(0, 3).join("; ") : undefined };
}

const IMF_RE = /\bIMF\b|International Monetary Fund|Extended Fund Facility|\bEFF\b|staff[- ]level agreement/i;

function decode(x: string): string {
  return x
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

/** IMF-related CBSL press releases, dated in Sri Lanka time. Recorded after the fact. */
export function parseCbslRss(xml: string): EventRecord[] {
  const out: EventRecord[] = [];
  for (const item of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const title = decode(item[1].match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "");
    const link = decode(item[1].match(/<link>([\s\S]*?)<\/link>/)?.[1] ?? "") || null;
    const pub = item[1].match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1];
    if (!title || !pub || !IMF_RE.test(title)) continue;
    const t = new Date(pub);
    if (Number.isNaN(t.getTime())) continue;
    const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Colombo", year: "numeric", month: "2-digit", day: "2-digit" }).format(t);
    out.push({ kind: "imf", eventDate: date, knownSince: date, source: "cbsl-rss", title, url: link, outcome: classifyImf(title) });
  }
  return out;
}

export async function fetchCbslRss(): Promise<SourceResult> {
  try {
    const xml = await getText(CBSL_RSS);
    if (!xml.includes("<item>")) return { source: "cbsl-rss", events: [], error: "feed has no items" };
    return { source: "cbsl-rss", events: parseCbslRss(xml) };
  } catch (e) {
    return { source: "cbsl-rss", events: [], error: (e as Error).message };
  }
}

export async function fetchAllEvents(): Promise<SourceResult[]> {
  const [fed, cbsl, rss] = await Promise.all([fetchFomc(), fetchCbslReviews(), fetchCbslRss()]);
  return [...fed, cbsl, rss];
}

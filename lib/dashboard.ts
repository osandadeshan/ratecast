import { cacheLife } from "next/cache";
import { DECIMALS, HORIZON_BUCKETS, MACRO_FACTORS, PAIRS, SRI_LANKA_META, TARGETS, type Target, bucketOf } from "./config";
import { addDays, addMonths, dateRange, monthBounds, todayISO } from "./dates";
import { db, ensureSchema, hasDb } from "./db";
import { EVENT_KINDS, type EventKind } from "./predict/events";
import type { LearnedStats } from "./predict/learning";
import { type CrossCheck } from "./sources/market";
import { type LiveQuote, fetchWiseComparison } from "./sources/wise";

export interface MonthDay {
  date: string;
  kind: "past" | "today" | "future";
  actual: number | null;
  provisional: boolean; // actual comes from today's live quote, not Wise's daily close
  predicted: number | null;
  lower80: number | null;
  upper80: number | null;
  madeOn: string | null;
  delta: number | null; // actual - predicted
  pctError: number | null;
  lastMonth: number | null; // rate on the same day-of-month last month
  events: string[]; // short labels of policy events announced on this date ("Fed", "CBSL")
}

export interface EventView {
  kind: string;
  label: string;
  short: string;
  date: string;
  title: string;
  url: string | null;
  outcome: string | null; // cut | hold | hike | sla | board | other | unclear, filled after the event
}

export interface SourceHealthView {
  source: string;
  label: string;
  ok: boolean; // last attempt succeeded and it succeeded within STALE_DAYS
  lastOkAt: string | null;
  error: string | null;
  note: string | null;
}

export interface DeltaRow {
  targetDate: string;
  madeOn: string;
  predicted: number;
  actual: number;
  delta: number;
  pctError: number;
}

export interface AccuracyRow {
  bucket: number;
  label: string;
  n: number;
  ensembleMae: number | null;
  naiveMae: number | null;
  within: number | null; // % of predictions within 0.25%
}

export interface CurrencyDashboard {
  target: Target;
  /** "SGD", "USD": the currency you send. */
  base: string;
  /** "LKR", "USD": the currency received. */
  quote: string;
  label: string; // "SGD → LKR"
  decimals: number;
  live: LiveQuote | null;
  liveSource: "wise-live" | "db" | "none";
  previousClose: { date: string; rate: number } | null;
  lastMonthSameDay: { date: string; rate: number } | null;
  tomorrow: MonthDay | null;
  monthEnd: MonthDay | null;
  month: MonthDay[];
  recentDeltas: DeltaRow[];
  accuracy: AccuracyRow[];
  stats: LearnedStats | null;
  market: {
    trend30dPct: number | null;
    vol30dPct: number | null;
    usdBasket30dPct: number | null;
    crossChecks: (CrossCheck & { diffPct: number | null })[];
  };
}

export interface Dashboard {
  today: string;
  monthLabel: string;
  dbConfigured: boolean;
  lastSync: { at: string; status: string; message: string | null } | null;
  currencies: CurrencyDashboard[];
  events: { upcoming: EventView[]; recent: EventView[]; health: SourceHealthView[] };
  /** Latest macro factor values (inputs of the `macro` model). change30d: pp for yields, % for prices. */
  macro: {
    series: string;
    label: string;
    value: number;
    date: string;
    change30d: number | null;
    unit: "pp" | "%";
    /** Sri Lanka series: shown only on LKR pairs. */
    lanka: boolean;
    /** Display format of the level. */
    format: "pct" | "usd" | "lkr" | "usdmn";
  }[];
}

const STALE_DAYS = 3;
const SOURCE_LABEL: Record<string, string> = {
  "fed-page": "Fed FOMC calendar page",
  "fed-json": "Fed calendar feed",
  "cbsl-mpr": "CBSL policy review list",
  "cbsl-rss": "CBSL press releases (RSS)",
  treasury: "US Treasury yield curve",
  "fred-brent": "FRED Brent oil price",
  "cbsl-fx": "CBSL official exchange rates",
  "cbsl-rates": "CBSL policy rate and T-bill yields",
  "cbsl-external": "CBSL remittances and tourism",
  "wise-history:LKR": "Wise SGD → LKR history",
  "wise-history:USD": "Wise SGD → USD history",
  "wise-history:USDLKR": "Wise USD → LKR history",
  outcomes: "Decision outcomes (statements)",
};

function eventView(r: {
  kind: string;
  event_date: string;
  title: string;
  url: string | null;
  outcome: string | null;
}): EventView {
  const k = EVENT_KINDS[r.kind as EventKind];
  return {
    kind: r.kind,
    label: k?.label ?? r.kind,
    short: k?.short ?? r.kind,
    date: r.event_date,
    title: r.title,
    url: r.url,
    outcome: r.outcome,
  };
}

async function cachedLiveQuote(target: Target): Promise<LiveQuote> {
  "use cache";
  cacheLife({ stale: 60, revalidate: 300, expire: 3600 });
  return fetchWiseComparison(target);
}

async function liveQuote(target: Target): Promise<LiveQuote | null> {
  try {
    return await cachedLiveQuote(target);
  } catch {
    return null;
  }
}

const BUCKET_LABEL: Record<number, string> = { 1: "1 day", 3: "2–3 days", 7: "4–7 days", 14: "8–14 days", 31: "15–31 days" };

export async function getDashboard(): Promise<Dashboard> {
  const today = todayISO();
  const { start, end } = monthBounds(today);
  const monthLabel = new Date(start + "T00:00:00Z").toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

  if (!hasDb()) {
    const currencies = await Promise.all(
      TARGETS.map(async (t) => {
        const live = await liveQuote(t);
        return emptyCurrency(t, live, start, end, today);
      }),
    );
    return {
      today,
      monthLabel,
      dbConfigured: false,
      lastSync: null,
      currencies,
      events: { upcoming: [], recent: [], health: [] },
      macro: [],
    };
  }

  await ensureSchema();
  const sql = db();
  const [lastSync] = await sql`
    SELECT finished_at, started_at, status, message FROM sync_runs ORDER BY id DESC LIMIT 1`;

  const [eventRows, healthRows, macroRows] = await Promise.all([
    sql`SELECT kind, event_date::text AS event_date, title, url, outcome FROM events
        WHERE known_since <= ${today}
          AND event_date BETWEEN ${addDays(today, -45)} AND ${addDays(today, 75)}
        ORDER BY event_date`,
    sql`SELECT source, last_ok_at, last_error_at, last_error, last_note FROM source_health ORDER BY source`,
    sql`SELECT series, date::text AS date, value FROM market_data
        WHERE series = ANY(${[...MACRO_FACTORS, ...SRI_LANKA_META].map((f) => f.series as string)})
          AND date >= ${addDays(today, -500)}
        ORDER BY date`,
  ]);
  const macro: Dashboard["macro"] = [];
  const FORMAT: Record<string, Dashboard["macro"][number]["format"]> = {
    brent: "usd",
    lk_usd_spot: "lkr",
    lk_sgd_ind: "lkr",
    lk_remit: "usdmn",
    lk_tourism: "usdmn",
  };
  const factorList = [
    ...MACRO_FACTORS.map((f) => ({ series: f.series as string, label: f.label as string, transform: f.transform as string, lanka: false })),
    ...SRI_LANKA_META.map((f) => ({ series: f.series as string, label: f.label as string, transform: f.transform as string, lanka: true })),
  ];
  for (const f of factorList) {
    const pts = macroRows.filter((r) => r.series === f.series);
    const latest = pts.at(-1);
    if (!latest) continue;
    // Monthly flows are seasonal: compare with a year earlier. Everything else: ~30 days earlier.
    const yoy = f.series === "lk_remit" || f.series === "lk_tourism";
    const ref = [...pts].reverse().find((p) => p.date <= addDays(latest.date, yoy ? -360 : -30));
    const change30d = !ref ? null : f.transform === "diff" ? latest.value - ref.value : (latest.value / ref.value - 1) * 100;
    macro.push({
      series: f.series,
      label: yoy ? `${f.label} · vs a year earlier` : f.label,
      value: latest.value,
      date: latest.date,
      change30d,
      unit: f.transform === "diff" ? "pp" : "%",
      lanka: f.lanka,
      format: FORMAT[f.series] ?? "pct",
    });
  }
  const evs = eventRows.map((r) => eventView(r as never));
  const monthEvents = new Map<string, string[]>();
  for (const e of evs) monthEvents.set(e.date, [...(monthEvents.get(e.date) ?? []), e.short]);
  const staleBefore = Date.now() - STALE_DAYS * 86_400_000;
  const health: SourceHealthView[] = healthRows.map((h) => {
    const okAt: Date | null = h.last_ok_at;
    const errAt: Date | null = h.last_error_at;
    const failingNow = errAt !== null && (okAt === null || errAt > okAt);
    return {
      source: h.source,
      label: SOURCE_LABEL[h.source] ?? h.source,
      ok: !failingNow && okAt !== null && okAt.getTime() >= staleBefore,
      lastOkAt: okAt ? okAt.toISOString() : null,
      error: failingNow ? h.last_error : null,
      note: h.last_note,
    };
  });

  const currencies = await Promise.all(TARGETS.map((t) => currencyDashboard(t, today, start, end, monthEvents)));
  return {
    today,
    monthLabel,
    dbConfigured: true,
    lastSync: lastSync
      ? { at: (lastSync.finished_at ?? lastSync.started_at).toISOString(), status: lastSync.status, message: lastSync.message }
      : null,
    currencies,
    events: {
      upcoming: evs.filter((e) => e.date >= today),
      recent: evs.filter((e) => e.date < today).reverse(),
      health,
    },
    macro,
  };
}

const pairInfo = (t: Target) => ({ base: PAIRS[t].base, quote: PAIRS[t].quote, label: PAIRS[t].label });

/** CBSL's own fixing for this pair, shown as a cross-check (LKR pairs only). */
const CBSL_SERIES: Partial<Record<Target, string>> = { LKR: "lk_sgd_ind", USDLKR: "lk_usd_spot" };

function emptyCurrency(target: Target, live: LiveQuote | null, start: string, end: string, today: string): CurrencyDashboard {
  return {
    target,
    ...pairInfo(target),
    decimals: DECIMALS[target],
    live,
    liveSource: live ? "wise-live" : "none",
    previousClose: null,
    lastMonthSameDay: null,
    tomorrow: null,
    monthEnd: null,
    month: dateRange(start, end).map((date) => ({
      date,
      kind: date < today ? "past" : date === today ? "today" : "future",
      actual: date === today && live ? live.midRate : null,
      provisional: date === today,
      predicted: null,
      lower80: null,
      upper80: null,
      madeOn: null,
      delta: null,
      pctError: null,
      lastMonth: null,
      events: [],
    })),
    recentDeltas: [],
    accuracy: [],
    stats: null,
    market: { trend30dPct: null, vol30dPct: null, usdBasket30dPct: null, crossChecks: [] },
  };
}

async function currencyDashboard(
  target: Target,
  today: string,
  start: string,
  end: string,
  monthEvents: Map<string, string[]>,
): Promise<CurrencyDashboard> {
  const sql = db();
  const histFrom = addMonths(start, -1);
  const [history, preds, deltas, errAgg, statsRow, basketRows, crossRows, liveFresh, dbLive] = await Promise.all([
    sql`SELECT date::text AS date, rate, source FROM rates_history
        WHERE currency = ${target} AND date >= ${addDays(histFrom, -35)} AND date <= ${end} ORDER BY date`,
    // For each day of the month: the most recent final forecast made BEFORE that day.
    sql`SELECT DISTINCT ON (target_date) target_date::text AS target_date, made_on::text AS made_on,
               predicted, lower80, upper80
        FROM predictions
        WHERE currency = ${target} AND model = 'ensemble' AND target_date BETWEEN ${start} AND ${addDays(end, 1)}
          AND made_on < target_date AND made_on <= ${today}
        ORDER BY target_date, made_on DESC`,
    sql`SELECT target_date::text AS target_date, made_on::text AS made_on, predicted, actual, delta, pct_error
        FROM prediction_errors
        WHERE currency = ${target} AND model = 'ensemble' AND horizon = 1
        ORDER BY target_date DESC LIMIT 14`,
    sql`SELECT model, horizon, count(*)::int AS n, avg(abs(pct_error)) AS mae,
               avg(CASE WHEN abs(pct_error) <= 0.25 THEN 1 ELSE 0 END) * 100 AS within
        , extract(dow from target_date)::int AS dow
        FROM prediction_errors
        WHERE currency = ${target} AND model IN ('ensemble', 'naive') AND target_date > ${addDays(today, -60)}
        GROUP BY model, horizon, dow`,
    sql`SELECT stats FROM model_stats WHERE currency = ${target} ORDER BY as_of DESC LIMIT 1`,
    sql`SELECT date::text AS date, value FROM market_data
        WHERE series = 'usd_basket' AND date >= ${addDays(today, -40)} ORDER BY date`,
    sql`SELECT series, date::text AS date, value FROM market_data
        WHERE (series LIKE ${"xc:" + target + ":%"} OR series = ${CBSL_SERIES[target] ?? "-"})
          AND date >= ${addDays(today, -7)} ORDER BY date DESC`,
    liveQuote(target),
    sql`SELECT date::text AS date, mid_rate, providers, fetched_at FROM live_quotes
        WHERE currency = ${target} ORDER BY fetched_at DESC LIMIT 1`,
  ]);

  const rates = new Map<string, { rate: number; source: string }>();
  for (const h of history) rates.set(h.date, { rate: h.rate, source: h.source });
  const predBy = new Map(preds.map((p) => [p.target_date as string, p]));

  let live: LiveQuote | null = liveFresh;
  let liveSource: CurrencyDashboard["liveSource"] = live ? "wise-live" : "none";
  if (!live && dbLive[0]) {
    const r = dbLive[0];
    live = {
      target,
      date: r.date,
      fetchedAt: r.fetched_at.toISOString(),
      midRate: r.mid_rate,
      sendAmount: 1000,
      providers: r.providers,
    };
    liveSource = "db";
  }

  const month: MonthDay[] = dateRange(start, end).map((date) => {
    const kind: MonthDay["kind"] = date < today ? "past" : date === today ? "today" : "future";
    const h = rates.get(date);
    let actual = h?.rate ?? null;
    let provisional = h ? h.source !== "wise" : false;
    if (kind === "today" && live && live.date === today) {
      actual = live.midRate;
      provisional = true;
    }
    if (kind === "future") actual = null;
    const p = predBy.get(date);
    const lm = rates.get(addMonths(date, -1));
    const predicted = p?.predicted ?? null;
    const delta = actual !== null && predicted !== null && !provisional ? actual - predicted : null;
    return {
      date,
      kind,
      actual,
      provisional,
      predicted,
      lower80: p?.lower80 ?? null,
      upper80: p?.upper80 ?? null,
      madeOn: p?.made_on ?? null,
      delta,
      pctError: delta !== null && actual ? ((predicted! - actual) / actual) * 100 : null,
      lastMonth: lm?.rate ?? null,
      events: monthEvents.get(date) ?? [],
    };
  });

  const tomorrowDate = addDays(today, 1);
  const tp = predBy.get(tomorrowDate);
  const tomorrow: MonthDay | null =
    month.find((d) => d.date === tomorrowDate) ??
    (tp
      ? {
          date: tomorrowDate,
          kind: "future",
          actual: null,
          provisional: false,
          predicted: tp.predicted,
          lower80: tp.lower80,
          upper80: tp.upper80,
          madeOn: tp.made_on,
          delta: null,
          pctError: null,
          lastMonth: null,
          events: monthEvents.get(tomorrowDate) ?? [],
        }
      : null);
  const monthEnd = end > today ? month[month.length - 1] : null;

  const officialDates = [...rates.entries()].filter(([d, r]) => r.source === "wise" && d < today).map(([d]) => d).sort();
  const prevDate = officialDates.at(-1);
  const lmDate = addMonths(today, -1);
  const lmRate = rates.get(lmDate);

  // accuracy per horizon bucket
  // Days the market is shut (Sunday on Wise) repeat the day before: scoring them would flatter accuracy.
  const shut = new Set(((statsRow[0]?.stats as LearnedStats | undefined)?.nonTradingDow ?? [0]) as number[]);
  const agg = new Map<string, { n: number; sumMae: number; sumWithin: number }>();
  for (const r of errAgg) {
    if (shut.has(r.dow)) continue;
    const key = `${r.model}:${bucketOf(r.horizon)}`;
    const a = agg.get(key) ?? { n: 0, sumMae: 0, sumWithin: 0 };
    a.n += r.n;
    a.sumMae += r.mae * r.n;
    a.sumWithin += r.within * r.n;
    agg.set(key, a);
  }
  const accuracy: AccuracyRow[] = HORIZON_BUCKETS.map((b) => {
    const e = agg.get(`ensemble:${b}`);
    const nv = agg.get(`naive:${b}`);
    return {
      bucket: b,
      label: BUCKET_LABEL[b],
      n: e?.n ?? 0,
      ensembleMae: e ? e.sumMae / e.n : null,
      naiveMae: nv ? nv.sumMae / nv.n : null,
      within: e ? e.sumWithin / e.n : null,
    };
  });

  // market context
  const official = officialDates.map((d) => rates.get(d)!.rate);
  const last30 = official.slice(-31);
  const trend30dPct = last30.length > 1 ? (last30[last30.length - 1] / last30[0] - 1) * 100 : null;
  const rets = last30.slice(1).map((v, i) => Math.log(v / last30[i]));
  const m = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
  const vol30dPct = rets.length > 2 ? Math.sqrt(rets.reduce((s, x) => s + (x - m) ** 2, 0) / (rets.length - 1)) * 100 : null;
  const usdBasket30dPct =
    basketRows.length > 1 ? (Math.exp(basketRows[basketRows.length - 1].value - basketRows[0].value) - 1) * 100 : null;

  const seen = new Set<string>();
  const crossChecks: CurrencyDashboard["market"]["crossChecks"] = [];
  for (const r of crossRows) {
    const source = (r.series as string).startsWith("xc:") ? (r.series as string).split(":")[2] : "CBSL official";
    if (seen.has(source)) continue;
    seen.add(source);
    crossChecks.push({
      source,
      rate: r.value,
      asOf: r.date,
      diffPct: live ? (r.value / live.midRate - 1) * 100 : null,
    });
  }

  return {
    target,
    ...pairInfo(target),
    decimals: DECIMALS[target],
    live,
    liveSource,
    previousClose: prevDate ? { date: prevDate, rate: rates.get(prevDate)!.rate } : null,
    lastMonthSameDay: lmRate ? { date: lmDate, rate: lmRate.rate } : null,
    tomorrow,
    monthEnd,
    month,
    recentDeltas: deltas.map((d) => ({
      targetDate: d.target_date,
      madeOn: d.made_on,
      predicted: d.predicted,
      actual: d.actual,
      delta: d.delta,
      pctError: d.pct_error,
    })),
    accuracy,
    stats: (statsRow[0]?.stats as LearnedStats) ?? null,
    market: { trend30dPct, vol30dPct, usdBasket30dPct, crossChecks },
  };
}

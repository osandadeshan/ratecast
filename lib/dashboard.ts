import { cacheLife } from "next/cache";
import { DECIMALS, HORIZON_BUCKETS, MODEL_VERSION, MACRO_FACTORS, PAIRS, SRI_LANKA_META, TARGETS, type Target, bucketOf } from "./config";
import { addDays, addMonths, dateRange, monthBounds, todayISO } from "./dates";
import { db, ensureSchema, hasDb } from "./db";
import { type Performance, type ScoredRow, computePerformance, direction } from "./performance";
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
  delta: number | null; // predicted − actual (positive = forecast was too high)
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
  /** Rolling accuracy (7/30/90 days), 1/7/14/30-day horizons, bias, trend. null without data. */
  performance: Performance | null;
  /** Yesterday's next-day forecast vs Wise's rate for yesterday, and today's forecast vs the live rate. */
  daily: {
    yesterday: { date: string; predicted: number; actual: number; madeOn: string; origin: string | null } | null;
    today: { date: string; predicted: number; live: number | null; madeOn: string } | null;
  };
  /** Where the 30-day forecast points (only a direction if today's rate is outside its 80% range). */
  outlook: "up" | "down" | "no clear direction" | null;
  /** Which models currently carry weight, and the model version that made today's forecast. */
  model: {
    active: string[];
    version: string | null;
    trainedOn: string | null;
    historyFrom: string | null;
    historyDays: number;
  };
  market: {
    trend30dPct: number | null;
    vol30dPct: number | null;
    usdBasket30dPct: number | null;
    crossChecks: (CrossCheck & { diffPct: number | null })[];
  };
}

export interface SeriesFreshness {
  series: string;
  label: string;
  feeds: string;
  first: string | null;
  latest: string | null;
  points: number;
  ageDays: number | null;
  late: boolean;
}

export interface VersionView {
  version: string;
  firstRun: string;
  backtestOn: string | null;
  /** Per pair: next-day..31-day error of the final forecast vs the random walk (skill < 1 = better). */
  pairs: { pair: string; label: string; n: number; mae: number; naiveMae: number; skill: number; coverage: number }[];
  previous: string | null;
  comparison: { pair: string; label: string; skill: number; prevSkill: number; verdict: "better" | "worse" | "same" }[] | null;
}

export interface LearningLogView {
  pair: string;
  label: string;
  date: string;
  bucket: number;
  item: string;
  change: "promoted" | "demoted";
  t: number | null;
}

export interface Dashboard {
  today: string;
  /** Model versions, newest first, with their automatic backtest and comparison with the previous one. */
  versions: VersionView[];
  /** What the learner switched on or off recently (newest first). */
  learningLog: LearningLogView[];
  /** Every stored series: coverage and freshness. */
  freshness: SeriesFreshness[];
  notIntegrated: typeof NOT_INTEGRATED;
  /** Version of the forecasting code serving this page. */
  modelVersion: string;
  /** Pair with the highest 30-day next-day error relative to the random walk on it (null: not enough data). */
  hardest: { target: Target; label: string; mape: number; naiveMape: number | null } | null;
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
  "wise-live:LKR": "Wise live SGD → LKR",
  "wise-live:USD": "Wise live SGD → USD",
  "wise-live:USDLKR": "Wise live USD → LKR",
  "cross-rate": "Cross-rate check (SGD→LKR = SGD→USD × USD→LKR)",
};

/**
 * Every data series the app stores, with what it feeds and its newest data date. `maxAgeDays` is the
 * age beyond which the data counts as late (publication delay + slack); monthly CBSL tables lag 1–2 months.
 */
const SERIES_CATALOG: { series: string; table: "rates" | "market"; label: string; feeds: string; maxAgeDays: number }[] = [
  { series: "LKR", table: "rates", label: "Wise SGD → LKR daily rate", feeds: "actuals, every model", maxAgeDays: 3 },
  { series: "USD", table: "rates", label: "Wise SGD → USD daily rate", feeds: "actuals, every model", maxAgeDays: 3 },
  { series: "USDLKR", table: "rates", label: "Wise USD → LKR daily rate", feeds: "actuals, every model", maxAgeDays: 3 },
  { series: "usd_basket", table: "market", label: "ECB reference rates (USD basket)", feeds: "market model", maxAgeDays: 5 },
  { series: "ust2y", table: "market", label: "US Treasury 2-year yield", feeds: "macro model", maxAgeDays: 5 },
  { series: "brent", table: "market", label: "Brent oil (FRED)", feeds: "macro model", maxAgeDays: 14 },
  { series: "lk_usd_spot", table: "market", label: "CBSL USD/LKR indicative rate", feeds: "lanka, cbsl_gap", maxAgeDays: 5 },
  { series: "lk_sgd_ind", table: "market", label: "CBSL SGD/LKR indicative rate", feeds: "lanka, cbsl_gap", maxAgeDays: 5 },
  { series: "lk_opr", table: "market", label: "CBSL policy rate", feeds: "lanka", maxAgeDays: 100 },
  { series: "lk_tbill3m", table: "market", label: "Sri Lanka 3-month T-bill yield", feeds: "lanka", maxAgeDays: 100 },
  { series: "lk_remit", table: "market", label: "Sri Lanka workers' remittances", feeds: "lanka", maxAgeDays: 100 },
  { series: "lk_tourism", table: "market", label: "Sri Lanka tourism earnings", feeds: "lanka", maxAgeDays: 100 },
];

/** Sources looked at and not used, with the reason. Shown so nothing is implied to be integrated. */
export const NOT_INTEGRATED: { name: string; reason: string }[] = [
  { name: "MAS (Singapore) statements and data", reason: "statement links aren't in the page HTML and the data API is in maintenance; being investigated" },
  { name: "CBSL foreign reserves", reason: "only in a weekly PDF the built-in reader can't extract" },
  { name: "Sri Lanka and Singapore inflation (CPI)", reason: "not added yet: monthly, published weeks late; candidate input under test" },
  { name: "US inflation and jobs reports", reason: "not added yet: planned as release-day events that widen the range" },
  { name: "US dollar index (DXY)", reason: "proprietary; the free Fed broad dollar index is a planned candidate" },
  { name: "Financial news and sentiment", reason: "no reliable keyless feed with history to test against (GDELT times out, news RSS blocked)" },
  { name: "IMF and World Bank data", reason: "yearly figures, too slow for daily rates; IMF programme news is used as events" },
];

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
      versions: [],
      learningLog: [],
      modelVersion: MODEL_VERSION,
      hardest: null,
      freshness: [],
      notIntegrated: NOT_INTEGRATED,
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

  const [eventRows, healthRows, macroRows, coverRows, versionRows, logRows] = await Promise.all([
    sql`SELECT kind, event_date::text AS event_date, title, url, outcome FROM events
        WHERE known_since <= ${today}
          AND event_date BETWEEN ${addDays(today, -45)} AND ${addDays(today, 75)}
        ORDER BY event_date`,
    sql`SELECT source, last_ok_at, last_error_at, last_error, last_note FROM source_health ORDER BY source`,
    sql`SELECT series, date::text AS date, value FROM market_data
        WHERE series = ANY(${[...MACRO_FACTORS, ...SRI_LANKA_META].map((f) => f.series as string)})
          AND date >= ${addDays(today, -500)}
        ORDER BY date`,
    sql`SELECT 'rates' AS t, currency AS series, min(date)::text AS first, max(date)::text AS latest, count(*)::int AS n
          FROM rates_history WHERE source = 'wise' GROUP BY currency
        UNION ALL
        SELECT 'market', series, min(date)::text, max(date)::text, count(*)::int
          FROM market_data WHERE series NOT LIKE 'xc:%' GROUP BY series`,
    sql`SELECT version, first_run::text AS first_run, backtest_on::text AS backtest_on, backtest, previous, comparison
        FROM model_versions ORDER BY first_run DESC, created_at DESC LIMIT 10`,
    sql`SELECT currency, as_of::text AS as_of, bucket, item, change, t_stat FROM learning_log
        ORDER BY as_of DESC, currency, bucket LIMIT 30`,
  ]);
  const label = (t: string) => {
    const p = PAIRS[t as Target];
    return p ? `${p.base} → ${p.quote}` : t;
  };
  type Bt = { pairs: { pair: string; overall: { n: number; mae: number; naiveMae: number; skill: number; coverage: number } }[] };
  const versions: VersionView[] = versionRows.map((v) => ({
    version: v.version,
    firstRun: v.first_run,
    backtestOn: v.backtest_on,
    pairs: ((v.backtest as Bt | null)?.pairs ?? []).map((p) => ({ pair: p.pair, label: label(p.pair), ...p.overall })),
    previous: v.previous,
    comparison: (v.comparison as VersionView["comparison"])?.map((c) => ({ ...c, label: label(c.pair) })) ?? null,
  }));
  const learningLog: LearningLogView[] = logRows.map((l) => ({
    pair: l.currency,
    label: label(l.currency),
    date: l.as_of,
    bucket: l.bucket,
    item: l.item,
    change: l.change,
    t: l.t_stat,
  }));
  const dayMs = 86_400_000;
  const freshness: SeriesFreshness[] = SERIES_CATALOG.map((c) => {
    const r = coverRows.find((x) => x.t === c.table && x.series === c.series);
    const ageDays = r?.latest ? Math.round((Date.parse(today) - Date.parse(r.latest)) / dayMs) : null;
    return {
      series: c.series,
      label: c.label,
      feeds: c.feeds,
      first: r?.first ?? null,
      latest: r?.latest ?? null,
      points: r?.n ?? 0,
      ageDays,
      late: ageDays === null || ageDays > c.maxAgeDays,
    };
  });
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
  // Hardest pair: highest next-day error over the last 30 days (raw %, the error a user feels).
  const ranked = currencies
    .map((c) => ({ c, w: c.performance?.windows.find((w) => w.days === 30) }))
    .filter((x) => x.w && x.w.n >= 10 && x.w.mape != null)
    .sort((a, b) => b.w!.mape! - a.w!.mape!);
  const hardest = ranked[0]
    ? { target: ranked[0].c.target, label: ranked[0].c.label, mape: ranked[0].w!.mape!, naiveMape: ranked[0].w!.naiveMape }
    : null;
  return {
    today,
    versions,
    learningLog,
    modelVersion: MODEL_VERSION,
    hardest,
    freshness,
    notIntegrated: NOT_INTEGRATED,
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
    performance: null,
    daily: { yesterday: null, today: null },
    outlook: null,
    model: { active: [], version: null, trainedOn: null, historyFrom: null, historyDays: 0 },
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
  const [history, preds, deltas, errAgg, statsRow, basketRows, crossRows, liveFresh, dbLive, scored, cover, todayPred] = await Promise.all([
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
    // Scored final + baseline forecasts for the performance panel (horizons 1/7/14/30, last ~120 days).
    sql`SELECT e.model, e.horizon, e.made_on::text AS made_on, e.target_date::text AS target_date,
               e.predicted, e.actual, e.pct_error, p.lower80, p.upper80, p.origin
        FROM prediction_errors e JOIN predictions p ON p.id = e.prediction_id
        WHERE e.currency = ${target} AND e.model IN ('ensemble', 'naive') AND e.horizon IN (1, 7, 14, 30)
          AND e.target_date > ${addDays(today, -120)}`,
    sql`SELECT min(date)::text AS first, count(*)::int AS n FROM rates_history WHERE currency = ${target} AND source = 'wise'`,
    sql`SELECT made_on::text AS made_on, model_version, predicted, lower80, upper80 FROM predictions
        WHERE currency = ${target} AND model = 'ensemble' AND made_on = ${today} AND horizon IN (1, 30)
        ORDER BY horizon`,
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
    const delta = actual !== null && predicted !== null && !provisional ? predicted - actual : null;
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

  const stats = (statsRow[0]?.stats as LearnedStats | undefined) ?? null;
  const rows: ScoredRow[] = scored.map((r) => ({
    model: r.model,
    horizon: r.horizon,
    madeOn: r.made_on,
    targetDate: r.target_date,
    predicted: r.predicted,
    actual: r.actual,
    pct: r.pct_error,
    lower80: r.lower80,
    upper80: r.upper80,
    origin: r.origin,
  }));
  const performance = rows.length ? computePerformance(rows, today, stats?.nonTradingDow ?? [0]) : null;
  const y = rows
    .filter((r) => r.model === "ensemble" && r.horizon === 1)
    .sort((a, b) => b.targetDate.localeCompare(a.targetDate))[0];
  const p30 = todayPred.length > 1 ? todayPred[todayPred.length - 1] : undefined; // horizon 30
  const tp1 = predBy.get(today);
  const active = stats
    ? [...new Set(stats.buckets.flatMap((b) => Object.entries(b.weights).filter(([, w]) => w > 0.005).map(([m]) => m)))]
    : [];

  return {
    target,
    ...pairInfo(target),
    decimals: DECIMALS[target],
    performance,
    daily: {
      yesterday: y ? { date: y.targetDate, predicted: y.predicted, actual: y.actual, madeOn: y.madeOn, origin: y.origin } : null,
      today: tp1
        ? { date: today, predicted: tp1.predicted, live: live?.date === today ? live.midRate : null, madeOn: tp1.made_on }
        : null,
    },
    outlook: direction(live?.midRate, p30?.predicted, p30?.lower80, p30?.upper80),
    model: {
      active,
      version: todayPred[0]?.model_version ?? null,
      trainedOn: stats?.asOf ?? null,
      historyFrom: cover[0]?.first ?? null,
      historyDays: cover[0]?.n ?? 0,
    },
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
      // Shown as predicted − actual (the stored column is actual − predicted and is never changed).
      delta: d.predicted - d.actual,
      pctError: d.pct_error,
    })),
    accuracy,
    stats,
    market: { trend30dPct, vol30dPct, usdBasket30dPct, crossChecks },
  };
}

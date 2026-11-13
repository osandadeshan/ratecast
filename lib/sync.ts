import {
  BACKFILL_DAYS,
  CROSS_LEGS,
  FACTOR_LAGS,
  KEEP_FOREVER_MODELS,
  LEARNING_WINDOW_DAYS,
  MAX_HORIZON,
  MODEL_VERSION,
  PREDICT_ORDER,
  PRUNE_MODELS_AFTER_DAYS,
  REPLAY_BUDGET_MS,
  BACKTEST_BUDGET_MS,
  TARGETS,
  type Target,
} from "./config";
import { addDays, todayISO } from "./dates";
import { db, ensureSchema } from "./db";
import { type PredictionRow } from "./predict/engine";
import { type EventRecord } from "./predict/events";
import { ErrorIndex, type ErrorRecord, type LearnedStats } from "./predict/learning";
import { compareVersions, runBacktest, type BacktestResult } from "./predict/backtest";
import { type PairInputs, combineLegMoves, feedOutcomes, forecastDay, learningChanges, restrict } from "./predict/replay";
import { fetchAllEvents, fetchOutcomes } from "./sources/events";
import { fetchBrent, fetchTreasury2y } from "./sources/macro";
import { fetchCrossChecks, fetchUsdBasket } from "./sources/market";
import { SRI_LANKA_SERIES } from "./sources/srilanka";
import { MAX_CROSS_GAP, crossGap, validateHistory, validateLive } from "./sources/validate";
import { fetchWiseComparison, fetchWiseHistory } from "./sources/wise";

export interface SyncResult {
  /** partial = today's forecast is made but the replay of past days ran out of time; the next run continues. */
  status: "ok" | "partial" | "skipped" | "error";
  runDate: string;
  log: string[];
  ms: number;
}

const LOCK_ID = 1;

async function acquireLock(): Promise<boolean> {
  const rows = await db()`
    INSERT INTO sync_lock (id, locked_at) VALUES (${LOCK_ID}, now())
    ON CONFLICT (id) DO UPDATE SET locked_at = now()
      WHERE sync_lock.locked_at < now() - interval '5 minutes'
    RETURNING id`;
  return rows.length > 0;
}

async function releaseLock() {
  await db()`DELETE FROM sync_lock WHERE id = ${LOCK_ID}`;
}

/** True if no successful sync has happened yet for today's date. */
export async function needsSync(): Promise<boolean> {
  await ensureSchema();
  const today = todayISO();
  const rows = await db()`
    SELECT 1 FROM sync_runs WHERE run_date = ${today} AND status = 'ok' LIMIT 1`;
  return rows.length === 0;
}

export async function runSync(opts: { backtestBudgetMs?: number } = {}): Promise<SyncResult> {
  const t0 = Date.now();
  const log: string[] = [];
  const today = todayISO();
  await ensureSchema();

  if (!(await acquireLock())) {
    return { status: "skipped", runDate: today, log: ["another sync is running"], ms: Date.now() - t0 };
  }
  const sql = db();
  const [run] = await sql`INSERT INTO sync_runs (run_date, model_version) VALUES (${today}, ${MODEL_VERSION}) RETURNING id`;

  try {
    // 1. External market data (shared by both currencies)
    const [{ n: basketCount }] = await sql`SELECT count(*)::int AS n FROM market_data WHERE series = 'usd_basket'`;
    const basketStart = addDays(today, basketCount < 200 ? -420 : -45);
    try {
      const basket = await fetchUsdBasket(basketStart, today);
      await upsertMarket(basket.map((b) => ({ series: "usd_basket", date: b.date, value: b.value })));
      log.push(`usd_basket: ${basket.length} days`);
    } catch (e) {
      log.push(`usd_basket failed: ${(e as Error).message}`);
    }

    const cross = await fetchCrossChecks();
    await upsertMarket(
      TARGETS.flatMap((t) => cross[t].map((c) => ({ series: `xc:${t}:${c.source}`, date: today, value: c.rate }))),
    );

    // 1a. Macro factors for the `macro` model (Treasury 2y yield, FRED Brent). Failures are non-fatal.
    await ingestMacro(today, log);

    // 1b. Policy event calendars (Fed, CBSL). Failures are logged + recorded, never fatal.
    const okSources = await ingestEvents(log);
    await classifyOutcomes(today, log, okSources);

    // 2. Per-currency ingest
    for (const target of TARGETS) {
      await ingestCurrency(target, today, log);
    }
    await checkCrossRate(log);

    // 3. Score every prediction whose real rate is now known  (the "delta" table)
    const evaluated = await evaluatePredictions();
    log.push(`evaluated ${evaluated} predictions`);

    // 4. Replay missed days (first run = BACKFILL_DAYS) within the time budget, then forecast from today
    const deadline = t0 + REPLAY_BUDGET_MS;
    let partial = false;
    for (const target of PREDICT_ORDER) {
      if (await predictCurrency(target, today, log, deadline)) partial = true;
    }
    const evaluated2 = await evaluatePredictions();
    if (evaluated2) log.push(`evaluated ${evaluated2} replayed predictions`);

    // 4b. Once per model version: an in-memory backtest of this code over the last year, compared with
    // the previous version. Only when the replay is complete and there is time left; else next run.
    if (!partial) await backtestVersion(today, log, t0 + (opts.backtestBudgetMs ?? BACKTEST_BUDGET_MS));

    // 5. Housekeeping. Final forecasts and the baseline are the permanent record and are never deleted;
    // the other models' rows (only needed for learning, 180-day window) go after ~1.5 years.
    await sql`DELETE FROM predictions WHERE target_date < ${addDays(today, -PRUNE_MODELS_AFTER_DAYS)}
      AND model <> ALL(${[...KEEP_FOREVER_MODELS] as string[]})`;
    await sql`DELETE FROM live_quotes WHERE fetched_at < now() - interval '60 days'`;

    // 'partial' keeps needsSync() true, so the next page visit or cron run continues the replay.
    const status = partial ? "partial" : "ok";
    await sql`UPDATE sync_runs SET status = ${status}, finished_at = now(), message = ${log.join("\n")} WHERE id = ${run.id}`;
    return { status, runDate: today, log, ms: Date.now() - t0 };
  } catch (e) {
    const msg = (e as Error).stack ?? String(e);
    log.push(`ERROR: ${msg}`);
    await sql`UPDATE sync_runs SET status = 'error', finished_at = now(), message = ${log.join("\n")} WHERE id = ${run.id}`;
    return { status: "error", runDate: today, log, ms: Date.now() - t0 };
  } finally {
    await releaseLock();
  }
}

async function upsertMarket(rows: { series: string; date: string; value: number }[]) {
  if (!rows.length) return;
  const sql = db();
  for (let i = 0; i < rows.length; i += 1000) {
    await sql`
      INSERT INTO market_data ${sql(rows.slice(i, i + 1000), "series", "date", "value")}
      ON CONFLICT (series, date) DO UPDATE SET value = EXCLUDED.value`;
  }
}

/** Returns the sources that were scraped successfully in this run. */
async function ingestEvents(log: string[]): Promise<Set<string>> {
  const sql = db();
  let results;
  try {
    results = await fetchAllEvents();
  } catch (e) {
    log.push(`events failed: ${(e as Error).message}`);
    return new Set();
  }
  // One row per (kind, date); keep the earliest known_since seen.
  const byKey = new Map<string, EventRecord>();
  for (const e of results.flatMap((r) => r.events)) {
    const k = `${e.kind}:${e.eventDate}`;
    const prev = byKey.get(k);
    byKey.set(k, prev && prev.knownSince <= e.knownSince ? prev : e);
  }
  const rows = [...byKey.values()].map((e) => ({
    kind: e.kind,
    event_date: e.eventDate,
    known_since: e.knownSince,
    source: e.source,
    title: e.title,
    url: e.url,
    outcome: e.outcome ?? null,
  }));
  if (rows.length) {
    await sql`
      INSERT INTO events ${sql(rows, "kind", "event_date", "known_since", "source", "title", "url", "outcome")}
      ON CONFLICT (kind, event_date) DO UPDATE SET
        known_since = LEAST(events.known_since, EXCLUDED.known_since),
        source = EXCLUDED.source, title = EXCLUDED.title, url = EXCLUDED.url,
        outcome = COALESCE(events.outcome, EXCLUDED.outcome), updated_at = now()`;
  }
  for (const r of results) await recordHealth(r.source, r.events.length, r.error, r.note);
  log.push(
    `events: ${rows.length} rows · ` +
      results.map((r) => `${r.source} ${r.error ? "FAILED (" + r.error + ")" : r.events.length}`).join(", "),
  );
  return new Set(results.filter((r) => !r.error).map((r) => r.source));
}

/** Record the outcome of one automatic source in source_health (shown on the dashboard). */
async function recordHealth(source: string, count: number, error?: string, note?: string) {
  const sql = db();
  if (error) {
    await sql`
      INSERT INTO source_health (source, last_error_at, last_error, last_count)
      VALUES (${source}, now(), ${error.slice(0, 500)}, ${count})
      ON CONFLICT (source) DO UPDATE SET last_error_at = now(), last_error = EXCLUDED.last_error,
        last_count = EXCLUDED.last_count`;
  } else {
    await sql`
      INSERT INTO source_health (source, last_ok_at, last_note, last_count)
      VALUES (${source}, now(), ${note ?? null}, ${count})
      ON CONFLICT (source) DO UPDATE SET last_ok_at = now(), last_note = EXCLUDED.last_note,
        last_count = EXCLUDED.last_count`;
  }
}

async function ingestMacro(today: string, log: string[]) {
  const sql = db();
  const count = async (series: string) =>
    (await sql`SELECT count(*)::int AS n FROM market_data WHERE series = ${series}`)[0].n as number;
  const year = Number(today.slice(0, 4));
  const firstRun = (await count("ust2y")) < 300;
  const years = firstRun ? [year - 2, year - 1, year] : today.slice(5, 7) === "01" ? [year - 1, year] : [year];
  const jobs: { source: string; series: string; run: () => Promise<{ date: string; value: number }[]> }[] = [
    { source: "treasury", series: "ust2y", run: () => fetchTreasury2y(years) },
    {
      source: "fred-brent",
      series: "brent",
      run: async () => fetchBrent(addDays(today, (await count("brent")) < 300 ? -800 : -60)),
    },
  ];
  // Sri Lanka (CBSL): daily official rates, monthly policy/T-bill rates, remittances, tourism.
  for (const s of SRI_LANKA_SERIES) {
    jobs.push({
      source: s.source,
      series: s.series,
      run: async () => s.fetch(addDays(today, (await count(s.series)) < 20 ? -800 : -120)),
    });
  }
  const results = await Promise.all(
    jobs.map(async (j) => {
      try {
        const pts = await j.run();
        await upsertMarket(pts.map((p) => ({ series: j.series, date: p.date, value: p.value })));
        const latest = pts.at(-1)?.date;
        log.push(`${j.series}: ${pts.length} points (latest ${latest})`);
        return { source: j.source, series: j.series, n: pts.length, latest };
      } catch (e) {
        log.push(`${j.series} failed: ${(e as Error).message}`);
        return { source: j.source, series: j.series, n: 0, error: (e as Error).message };
      }
    }),
  );
  // One health row per source; series that share a download (e.g. both CBSL rates) report together.
  for (const source of [...new Set(results.map((r) => r.source))]) {
    const rs = results.filter((r) => r.source === source);
    const failed = rs.filter((r) => r.error);
    const note = rs.map((r) => (r.error ? `${r.series} failed` : `${r.series} latest ${r.latest}`)).join(" · ");
    await recordHealth(
      source,
      rs.reduce((a, r) => a + r.n, 0),
      failed.length === rs.length ? failed.map((r) => `${r.series}: ${r.error}`).join("; ") : undefined,
      note,
    );
  }
}

async function loadFactors(): Promise<Record<string, Map<string, number>>> {
  const names = Object.keys(FACTOR_LAGS);
  const rows = await db()`SELECT series, date::text AS date, value FROM market_data WHERE series = ANY(${names})`;
  const out: Record<string, Map<string, number>> = Object.fromEntries(names.map((n) => [n, new Map()]));
  for (const r of rows) out[r.series].set(r.date, r.value);
  return out;
}

/** Read each past announcement's own statement and store what was decided (cut / hold / hike). */
async function classifyOutcomes(today: string, log: string[], okSources: Set<string>) {
  const sql = db();
  const pending = (await loadEvents()).filter(
    (e) => !e.outcome && e.eventDate < today && e.eventDate >= addDays(today, -800),
  );
  if (!pending.length) {
    await recordHealth("outcomes", 0); // nothing to do is healthy, not stale
    return;
  }
  const { results, missing, error } = await fetchOutcomes(pending.reverse()); // newest first
  for (const r of results) {
    await sql`UPDATE events SET outcome = ${r.outcome}, updated_at = now()
              WHERE kind = ${r.kind} AND event_date = ${r.eventDate} AND outcome IS NULL`;
  }
  // Phantom events: a scheduled date that passed a week ago without its own statement (meeting
  // moved or cancelled). Delete it so it is not learned from as a real event; the daily scrape
  // brings the real date back. CBSL rows only when its list was read successfully in this run.
  const cutoff = addDays(today, -7);
  const phantoms = missing.filter(
    (m) => m.eventDate <= cutoff && (m.kind === "fomc" || (m.kind === "cbsl_policy" && okSources.has("cbsl-mpr"))),
  );
  for (const p of phantoms) {
    await sql`DELETE FROM events WHERE kind = ${p.kind} AND event_date = ${p.eventDate} AND outcome IS NULL`;
  }
  if (phantoms.length) {
    log.push(`events: removed ${phantoms.length} that never happened (${phantoms.map((p) => `${p.kind} ${p.eventDate}`).join(", ")})`);
  }
  const left = pending.length - results.length - phantoms.length;
  await recordHealth("outcomes", results.length, error, left ? `${left} statements not read yet` : undefined);
  log.push(
    `outcomes: classified ${results.length}/${pending.length}` +
      (results.length ? ` (${results.map((r) => `${r.kind}:${r.outcome}`).slice(0, 6).join(", ")}…)` : "") +
      (error ? ` · errors: ${error}` : ""),
  );
}

async function loadEvents(): Promise<EventRecord[]> {
  const rows = await db()`
    SELECT kind, event_date::text AS event_date, known_since::text AS known_since, source, title, url, outcome
    FROM events ORDER BY event_date`;
  return rows.map((r) => ({
    kind: r.kind,
    eventDate: r.event_date,
    knownSince: r.known_since,
    source: r.source,
    title: r.title,
    url: r.url,
    outcome: r.outcome,
  }));
}

async function ingestCurrency(target: Target, today: string, log: string[]) {
  const sql = db();
  const [{ n }] = await sql`SELECT count(*)::int AS n FROM rates_history WHERE currency = ${target} AND source = 'wise'`;
  // A failed history fetch must not cost today's forecast: carry on with the stored history.
  try {
    const raw = n < 300 ? await fetchWiseHistory(target, 2, "year") : await fetchWiseHistory(target, 3, "month");
    if (!raw.length) throw new Error("Wise history returned no points");
    // Validate against the last stored official point before the fetched window.
    const [prev] = await sql`
      SELECT date::text AS date, rate FROM rates_history
      WHERE currency = ${target} AND source = 'wise' AND date < ${raw[0].date} ORDER BY date DESC LIMIT 1`;
    const { ok: history, rejected } = validateHistory(target, raw, prev as { date: string; rate: number } | undefined);
    if (!history.length) throw new Error(`all ${raw.length} Wise points failed validation (${rejected[0]?.reason})`);
    const rows = history.map((h) => ({ currency: target, date: h.date, rate: h.rate, source: "wise" }));
    for (let i = 0; i < rows.length; i += 1000) {
      await sql`
        INSERT INTO rates_history ${sql(rows.slice(i, i + 1000), "currency", "date", "rate", "source")}
        ON CONFLICT (currency, date) DO UPDATE SET rate = EXCLUDED.rate, source = 'wise', updated_at = now()`;
    }
    const latest = history.at(-1)?.date;
    const bad = rejected.length ? ` · ${rejected.length} point(s) rejected: ${rejected[0].date} ${rejected[0].reason}` : "";
    await recordHealth(`wise-history:${target}`, rows.length, undefined, `latest ${latest}${bad}`);
    log.push(`${target}: ${rows.length} history days (latest ${latest})${bad}`);
  } catch (e) {
    await recordHealth(`wise-history:${target}`, 0, (e as Error).message);
    log.push(`${target}: history failed, using stored rates: ${(e as Error).message}`);
  }

  try {
    const q = await fetchWiseComparison(target);
    const [last] = await sql`
      SELECT date::text AS date, rate FROM rates_history
      WHERE currency = ${target} AND source = 'wise' AND date < ${q.date} ORDER BY date DESC LIMIT 1`;
    const invalid = validateLive(target, q.midRate, last as { date: string; rate: number } | undefined);
    if (invalid) throw new Error(`rejected: ${invalid}`);
    await sql`
      INSERT INTO live_quotes (currency, date, mid_rate, providers, fetched_at)
      VALUES (${target}, ${q.date}, ${q.midRate}, ${sql.json(q.providers as never)}, ${q.fetchedAt})`;
    // Provisional value for today, replaced by Wise's official daily point once published.
    await sql`
      INSERT INTO rates_history (currency, date, rate, source)
      VALUES (${target}, ${q.date}, ${q.midRate}, 'wise_live')
      ON CONFLICT (currency, date) DO UPDATE SET rate = EXCLUDED.rate, updated_at = now()
        WHERE rates_history.source <> 'wise'`;
    log.push(`${target}: live mid ${q.midRate}`);
  } catch (e) {
    log.push(`${target}: live quote failed: ${(e as Error).message}`);
    await recordHealth(`wise-live:${target}`, 0, (e as Error).message);
    return;
  }
  await recordHealth(`wise-live:${target}`, 1);
}

/**
 * SGD→LKR should equal SGD→USD × USD→LKR (Wise's own quotes agree to < 0.01%). A larger gap on the
 * latest common official date means one pair's data is stale or wrong: recorded in source_health.
 */
async function checkCrossRate(log: string[]) {
  const [r] = await db()`
    SELECT a.date::text AS date, a.rate AS lkr, b.rate AS usd, c.rate AS usdlkr
    FROM rates_history a
    JOIN rates_history b ON b.currency = 'USD' AND b.date = a.date AND b.source = 'wise'
    JOIN rates_history c ON c.currency = 'USDLKR' AND c.date = a.date AND c.source = 'wise'
    WHERE a.currency = 'LKR' AND a.source = 'wise' ORDER BY a.date DESC LIMIT 1`;
  if (!r) return;
  const gap = crossGap(r.lkr, r.usd, r.usdlkr);
  const note = `SGD→LKR vs SGD→USD × USD→LKR on ${r.date}: ${(gap * 100).toFixed(4)}%`;
  if (Math.abs(gap) > MAX_CROSS_GAP) await recordHealth("cross-rate", 0, `${note} (limit ${MAX_CROSS_GAP * 100}%)`);
  else await recordHealth("cross-rate", 1, undefined, note);
  log.push(`cross-rate: ${note}`);
}

/** Insert a prediction_errors row for every prediction whose actual (official Wise) rate exists. */
async function evaluatePredictions(): Promise<number> {
  // When prediction_errors is (nearly) empty, e.g. right after the first replay, Postgres estimates the
  // anti-join side at ~1 row and picks a nested loop that rescans it for every prediction: 13 min for
  // 454k rows on 2026-11-12, against 8 s with a hash anti-join. ANALYZE alone doesn't fix it (an empty
  // table stays "1 row"), so the statement runs in a transaction with nested loops disabled.
  const sql = db();
  await sql`ANALYZE predictions, prediction_errors, rates_history`;
  const rows = await sql.begin(async (tx) => {
    await tx`SET LOCAL enable_nestloop = off`;
    return tx`
    INSERT INTO prediction_errors
      (prediction_id, currency, model, made_on, target_date, horizon, predicted, actual, delta, pct_error, log_error)
    SELECT p.id, p.currency, p.model, p.made_on, p.target_date, p.horizon, p.predicted, r.rate,
           r.rate - p.predicted,
           (p.predicted - r.rate) / r.rate * 100,
           ln(p.predicted / r.rate)
    FROM predictions p
    JOIN rates_history r ON r.currency = p.currency AND r.date = p.target_date AND r.source = 'wise'
    WHERE NOT EXISTS (SELECT 1 FROM prediction_errors e WHERE e.prediction_id = p.id)
    ON CONFLICT (prediction_id) DO NOTHING
    RETURNING prediction_id`;
  });
  return rows.length;
}

async function loadRates(target: Target): Promise<{ all: Map<string, number>; official: Map<string, number> }> {
  const rows = await db()`
    SELECT date::text AS date, rate, source FROM rates_history WHERE currency = ${target} ORDER BY date`;
  const all = new Map<string, number>();
  const official = new Map<string, number>();
  for (const r of rows) {
    all.set(r.date, r.rate);
    if (r.source === "wise") official.set(r.date, r.rate);
  }
  return { all, official };
}

async function loadBasket(): Promise<Map<string, number>> {
  const rows = await db()`SELECT date::text AS date, value FROM market_data WHERE series = 'usd_basket'`;
  return new Map(rows.map((r) => [r.date as string, r.value as number]));
}

async function loadErrors(target: Target, since: string): Promise<ErrorRecord[]> {
  const rows = await db()`
    SELECT model, horizon, target_date::text AS target_date, log_error
    FROM prediction_errors WHERE currency = ${target} AND target_date > ${since}`;
  return rows.map((r) => ({ model: r.model, horizon: r.horizon, targetDate: r.target_date, logError: r.log_error }));
}

/**
 * Write-once: a forecast, once stored, is never changed (ON CONFLICT DO NOTHING). A second run on the
 * same day keeps the first run's forecast. origin says whether the row was made live or replayed.
 */
async function insertPredictions(target: Target, rows: PredictionRow[], origin: "live" | "replay") {
  if (!rows.length) return;
  const sql = db();
  const data = rows.map((r) => ({
    currency: target,
    made_on: r.madeOn,
    target_date: r.targetDate,
    horizon: r.horizon,
    model: r.model,
    predicted: r.predicted,
    lower80: r.lower80,
    upper80: r.upper80,
    origin,
    model_version: MODEL_VERSION,
  }));
  const cols = [
    "currency", "made_on", "target_date", "horizon", "model", "predicted", "lower80", "upper80", "origin", "model_version",
  ] as const;
  for (let i = 0; i < data.length; i += 1000) {
    const chunk = sql(data.slice(i, i + 1000), ...cols);
    await sql`INSERT INTO predictions ${chunk} ON CONFLICT (currency, made_on, target_date, model) DO NOTHING`;
  }
}

/** Returns true if the replay ran out of time (the next run continues from the first missing day). */
/**
 * For a two-part pair (SGD→LKR): the legs' stored `ensemble` forecasts, so the `cross` model can
 * combine them. Returns a lookup (anchor date, the legs' anchor rates) → summed log moves per horizon.
 * Legs are forecast first in a sync (PREDICT_ORDER), so their rows for the same anchor already exist.
 */
async function loadLegs(target: Target, today: string) {
  const legs = CROSS_LEGS[target];
  if (!legs) return null;
  const data = await Promise.all(
    legs.map(async (leg) => {
      const rows = await db()`
        SELECT made_on::text AS made_on, horizon, predicted FROM predictions
        WHERE currency = ${leg} AND model = 'ensemble' AND made_on >= ${addDays(today, -BACKFILL_DAYS - 1)}`;
      const byDay = new Map<string, number[]>();
      for (const r of rows) {
        const arr = byDay.get(r.made_on) ?? [];
        arr[r.horizon - 1] = r.predicted;
        byDay.set(r.made_on, arr);
      }
      return { byDay, rates: await loadRates(leg) };
    }),
  );
  /** anchor = the rate that leg's forecast was anchored on at `t` (live: today's quote, else the last rate). */
  return (t: string, live: boolean): number[] | undefined =>
    combineLegMoves(
      data.map((d) => {
        const src = live ? restrict(d.rates.all, t) : d.rates.official;
        let anchor = src.get(t);
        if (anchor === undefined && live) anchor = [...src.entries()].sort((a, b) => a[0].localeCompare(b[0])).at(-1)?.[1];
        return { path: d.byDay.get(t), anchor };
      }),
    );
}

async function predictCurrency(target: Target, today: string, log: string[], deadline: number): Promise<boolean> {
  const sql = db();
  const { all, official } = await loadRates(target);
  const inp: PairInputs = { pair: target, official, basket: await loadBasket(), factors: await loadFactors(), events: await loadEvents() };
  const legsAt = await loadLegs(target, today);
  const index = new ErrorIndex(
    await loadErrors(target, addDays(today, -(BACKFILL_DAYS + LEARNING_WINDOW_DAYS + MAX_HORIZON))),
  );

  // Which past days have no forecast yet? (first run, or days the cron didn't fire)
  const madeRows = await sql`
    SELECT DISTINCT made_on::text AS d FROM predictions
    WHERE currency = ${target} AND model = 'ensemble' AND made_on >= ${addDays(today, -BACKFILL_DAYS)}`;
  const made = new Set(madeRows.map((r) => r.d as string));

  let replayed = 0;
  let partial = false;
  let buffer: PredictionRow[] = [];
  const flush = async () => {
    await insertPredictions(target, buffer, "replay");
    buffer = [];
  };
  // Oldest first: each replayed day learns from the outcomes of the days before it.
  for (let t = addDays(today, -BACKFILL_DAYS); t < today; t = addDays(t, 1)) {
    if (made.has(t) || !official.has(t)) continue;
    if (Date.now() > deadline) {
      partial = true;
      break;
    }
    // Strictly no look-ahead: only data known at day t (see forecastDay).
    const { rows } = forecastDay(inp, index, t, { legMoves: legsAt?.(t, false) });
    buffer.push(...rows);
    if (buffer.length >= 5000) await flush();
    // Feed outcomes back immediately so the next replayed day learns from them.
    feedOutcomes(index, rows, official, today);
    replayed++;
  }
  await flush();
  if (replayed) log.push(`${target}: replayed ${replayed} past days${partial ? " (time budget reached, continues next run)" : ""}`);
  else if (partial) log.push(`${target}: replay postponed (time budget reached)`);

  // Today's live forecast — anchored on the freshest rate we have (live Wise quote).
  const anchorRates = restrict(all, today);
  if (!anchorRates.has(today)) {
    // No live quote today: carry yesterday's official rate forward as the anchor.
    const prev = [...anchorRates.keys()].sort().at(-1);
    if (prev) anchorRates.set(today, anchorRates.get(prev)!);
  }
  const { rows, stats } = forecastDay(inp, index, today, { anchorRates, legMoves: legsAt?.(today, true) });
  await insertPredictions(target, rows, "live");
  // Audit log: what the learner switched on or off since the previous stored day.
  const [prev] = await sql`
    SELECT stats FROM model_stats WHERE currency = ${target} AND as_of < ${today} ORDER BY as_of DESC LIMIT 1`;
  const changes = learningChanges(prev?.stats as LearnedStats | undefined, stats);
  if (changes.length) {
    await sql`INSERT INTO learning_log ${sql(
      changes.map((c) => ({ currency: target, as_of: today, bucket: c.bucket, item: c.item, change: c.change, t_stat: c.t, model_version: MODEL_VERSION })),
      "currency", "as_of", "bucket", "item", "change", "t_stat", "model_version",
    )} ON CONFLICT DO NOTHING`;
    log.push(`${target}: learning changes ${changes.map((c) => `${c.item}@${c.bucket}d ${c.change}`).join(", ")}`);
  }
  await sql`
    INSERT INTO model_stats (currency, as_of, stats) VALUES (${target}, ${today}, ${sql.json(stats as never)})
    ON CONFLICT (currency, as_of) DO UPDATE SET stats = EXCLUDED.stats`;
  const tomorrow = rows.find((r) => r.model === "ensemble" && r.horizon === 1);
  log.push(`${target}: forecast ${rows.length} rows, tomorrow ≈ ${tomorrow?.predicted.toFixed(4)}`);
  return partial;
}

/**
 * Records this MODEL_VERSION in `model_versions` and, if it has no backtest yet, replays it over the
 * last year in memory and stores the scores and the comparison with the previous version. Never
 * fails the sync, and stores nothing if it runs out of time (the next run tries again).
 */
async function backtestVersion(today: string, log: string[], deadline: number) {
  const sql = db();
  try {
    await sql`INSERT INTO model_versions (version, first_run) VALUES (${MODEL_VERSION}, ${today}) ON CONFLICT DO NOTHING`;
    const [row] = await sql`SELECT backtest_on FROM model_versions WHERE version = ${MODEL_VERSION}`;
    if (row?.backtest_on) return;
    const t0 = Date.now();
    const result = runBacktest(await loadBacktestInputs(), CROSS_LEGS, today, deadline);
    if (!result.complete) {
      log.push(`backtest of ${MODEL_VERSION}: out of time after ${Date.now() - t0} ms, retrying next run`);
      return;
    }
    const [prev] = await sql`
      SELECT version, backtest FROM model_versions
      WHERE backtest IS NOT NULL AND version <> ${MODEL_VERSION} ORDER BY backtest_on DESC, created_at DESC LIMIT 1`;
    const comparison = prev ? compareVersions(result, prev.backtest as BacktestResult) : null;
    await sql`
      UPDATE model_versions SET backtest_on = ${today}, backtest = ${sql.json(result as never)},
        previous = ${prev?.version ?? null}, comparison = ${comparison ? sql.json(comparison as never) : null}
      WHERE version = ${MODEL_VERSION} AND backtest_on IS NULL`;
    log.push(
      `backtest of ${MODEL_VERSION} (${Date.now() - t0} ms): ` +
        result.pairs.map((p) => `${p.pair} skill ${p.overall.skill.toFixed(4)}`).join(", ") +
        (comparison ? ` · vs ${prev.version}: ${comparison.map((c) => `${c.pair} ${c.verdict}`).join(", ")}` : ""),
    );
  } catch (e) {
    log.push(`backtest failed: ${(e as Error).message}`);
  }
}

/** Every pair's inputs (official rates, basket, factors, events) in forecast order, for `runBacktest`. */
export async function loadBacktestInputs(): Promise<PairInputs[]> {
  const shared = { basket: await loadBasket(), factors: await loadFactors(), events: await loadEvents() };
  const inputs: PairInputs[] = [];
  for (const pair of PREDICT_ORDER) inputs.push({ pair, official: (await loadRates(pair)).official, ...shared });
  return inputs;
}

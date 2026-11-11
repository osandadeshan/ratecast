import { BACKFILL_DAYS, LEARNING_WINDOW_DAYS, MACRO_FACTORS, MAX_HORIZON, TARGETS, type Target } from "./config";
import { addDays, todayISO } from "./dates";
import { db, ensureSchema } from "./db";
import { forecast, type PredictionRow } from "./predict/engine";
import { type EventRecord, learnEventVol } from "./predict/events";
import { learnNewsDrift } from "./predict/news";
import { type ErrorRecord, learn } from "./predict/learning";
import { fetchAllEvents, fetchOutcomes } from "./sources/events";
import { fetchBrent, fetchTreasury2y } from "./sources/macro";
import { fetchCrossChecks, fetchUsdBasket } from "./sources/market";
import { fetchWiseComparison, fetchWiseHistory } from "./sources/wise";

export interface SyncResult {
  status: "ok" | "skipped" | "error";
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

export async function runSync(): Promise<SyncResult> {
  const t0 = Date.now();
  const log: string[] = [];
  const today = todayISO();
  await ensureSchema();

  if (!(await acquireLock())) {
    return { status: "skipped", runDate: today, log: ["another sync is running"], ms: Date.now() - t0 };
  }
  const sql = db();
  const [run] = await sql`INSERT INTO sync_runs (run_date) VALUES (${today}) RETURNING id`;

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
    await ingestEvents(log);
    await classifyOutcomes(today, log);

    // 2. Per-currency ingest
    for (const target of TARGETS) {
      await ingestCurrency(target, today, log);
    }

    // 3. Score every prediction whose real rate is now known  (the "delta" table)
    const evaluated = await evaluatePredictions();
    log.push(`evaluated ${evaluated} predictions`);

    // 4. Replay missed days (first run = BACKFILL_DAYS), then forecast from today
    for (const target of TARGETS) {
      await predictCurrency(target, today, log);
    }
    const evaluated2 = await evaluatePredictions();
    if (evaluated2) log.push(`evaluated ${evaluated2} replayed predictions`);

    // 5. Housekeeping: keep a year of predictions
    await sql`DELETE FROM predictions WHERE target_date < ${addDays(today, -400)}`;
    await sql`DELETE FROM live_quotes WHERE fetched_at < now() - interval '60 days'`;

    await sql`UPDATE sync_runs SET status = 'ok', finished_at = now(), message = ${log.join("\n")} WHERE id = ${run.id}`;
    return { status: "ok", runDate: today, log, ms: Date.now() - t0 };
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

async function ingestEvents(log: string[]) {
  const sql = db();
  let results;
  try {
    results = await fetchAllEvents();
  } catch (e) {
    log.push(`events failed: ${(e as Error).message}`);
    return;
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
  await Promise.all(
    jobs.map(async (j) => {
      try {
        const pts = await j.run();
        await upsertMarket(pts.map((p) => ({ series: j.series, date: p.date, value: p.value })));
        const latest = pts.at(-1)?.date;
        await recordHealth(j.source, pts.length, undefined, latest ? `latest ${latest}` : undefined);
        log.push(`${j.series}: ${pts.length} days (latest ${latest})`);
      } catch (e) {
        await recordHealth(j.source, 0, (e as Error).message);
        log.push(`${j.series} failed: ${(e as Error).message}`);
      }
    }),
  );
}

async function loadFactors(): Promise<Record<string, Map<string, number>>> {
  const names = MACRO_FACTORS.map((f) => f.series as string);
  const rows = await db()`SELECT series, date::text AS date, value FROM market_data WHERE series = ANY(${names})`;
  const out: Record<string, Map<string, number>> = Object.fromEntries(names.map((n) => [n, new Map()]));
  for (const r of rows) out[r.series].set(r.date, r.value);
  return out;
}

/** Each factor restricted to what was public at `anchor` (date <= anchor - lagDays). */
function factorsAt(all: Record<string, Map<string, number>>, anchor: string): Record<string, Map<string, number>> {
  return Object.fromEntries(MACRO_FACTORS.map((f) => [f.series, restrict(all[f.series], addDays(anchor, -f.lagDays))]));
}

/** Read each past announcement's own statement and store what was decided (cut / hold / hike). */
async function classifyOutcomes(today: string, log: string[]) {
  const sql = db();
  const pending = (await loadEvents()).filter(
    (e) => !e.outcome && e.eventDate < today && e.eventDate >= addDays(today, -800),
  );
  if (!pending.length) {
    await recordHealth("outcomes", 0); // nothing to do is healthy, not stale
    return;
  }
  const { results, error } = await fetchOutcomes(pending.reverse()); // newest first
  for (const r of results) {
    await sql`UPDATE events SET outcome = ${r.outcome}, updated_at = now()
              WHERE kind = ${r.kind} AND event_date = ${r.eventDate} AND outcome IS NULL`;
  }
  const left = pending.length - results.length;
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
  const history = n < 300 ? await fetchWiseHistory(target, 2, "year") : await fetchWiseHistory(target, 3, "month");
  const rows = history.map((h) => ({ currency: target, date: h.date, rate: h.rate, source: "wise" }));
  for (let i = 0; i < rows.length; i += 1000) {
    await sql`
      INSERT INTO rates_history ${sql(rows.slice(i, i + 1000), "currency", "date", "rate", "source")}
      ON CONFLICT (currency, date) DO UPDATE SET rate = EXCLUDED.rate, source = 'wise', updated_at = now()`;
  }
  log.push(`${target}: ${rows.length} history days (latest ${history.at(-1)?.date})`);

  try {
    const q = await fetchWiseComparison(target);
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
  }
}

/** Insert a prediction_errors row for every prediction whose actual (official Wise) rate exists. */
async function evaluatePredictions(): Promise<number> {
  const rows = await db()`
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

function restrict(map: Map<string, number>, maxDate: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const [d, v] of map) if (d <= maxDate) out.set(d, v);
  return out;
}

async function insertPredictions(target: Target, rows: PredictionRow[], overwrite: boolean) {
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
  }));
  const cols = ["currency", "made_on", "target_date", "horizon", "model", "predicted", "lower80", "upper80"] as const;
  for (let i = 0; i < data.length; i += 1000) {
    const chunk = sql(data.slice(i, i + 1000), ...cols);
    if (overwrite) {
      await sql`
        INSERT INTO predictions ${chunk}
        ON CONFLICT (currency, made_on, target_date, model) DO UPDATE
          SET predicted = EXCLUDED.predicted, lower80 = EXCLUDED.lower80, upper80 = EXCLUDED.upper80, created_at = now()`;
    } else {
      await sql`INSERT INTO predictions ${chunk} ON CONFLICT (currency, made_on, target_date, model) DO NOTHING`;
    }
  }
}

async function predictCurrency(target: Target, today: string, log: string[]) {
  const sql = db();
  const { all, official } = await loadRates(target);
  const basket = await loadBasket();
  const events = await loadEvents();
  const factors = await loadFactors();
  const errors = await loadErrors(target, addDays(today, -(BACKFILL_DAYS + LEARNING_WINDOW_DAYS + MAX_HORIZON)));

  // Which past days have no forecast yet? (first run, or days the cron didn't fire)
  const madeRows = await sql`
    SELECT DISTINCT made_on::text AS d FROM predictions
    WHERE currency = ${target} AND model = 'ensemble' AND made_on >= ${addDays(today, -BACKFILL_DAYS)}`;
  const made = new Set(madeRows.map((r) => r.d as string));

  let replayed = 0;
  for (let t = addDays(today, -BACKFILL_DAYS); t < today; t = addDays(t, 1)) {
    if (made.has(t) || !official.has(t)) continue;
    // Strictly no look-ahead: only data known at day t.
    const stats = learn(errors, t);
    const known = events.filter((e) => e.knownSince <= t);
    const eventStats = learnEventVol(restrict(official, t), known, t);
    const newsStats = learnNewsDrift(restrict(official, t), known, t);
    const rows = forecast({
      rates: restrict(official, t),
      basket: restrict(basket, addDays(t, -1)),
      factors: factorsAt(factors, t),
      anchorDate: t,
      stats,
      events: known,
      eventStats,
      newsStats,
    });
    await insertPredictions(target, rows, false);
    // Feed outcomes back immediately so the next replayed day learns from them.
    for (const r of rows) {
      const actual = official.get(r.targetDate);
      if (actual && r.targetDate < today) {
        errors.push({ model: r.model, horizon: r.horizon, targetDate: r.targetDate, logError: Math.log(r.predicted / actual) });
      }
    }
    replayed++;
  }
  if (replayed) log.push(`${target}: replayed ${replayed} past days`);

  // Today's live forecast — anchored on the freshest rate we have (live Wise quote).
  const stats = learn(errors, today);
  const anchorRates = restrict(all, today);
  if (!anchorRates.has(today)) {
    // No live quote today: carry yesterday's official rate forward as the anchor.
    const prev = [...anchorRates.keys()].sort().at(-1);
    if (prev) anchorRates.set(today, anchorRates.get(prev)!);
  }
  const known = events.filter((e) => e.knownSince <= today);
  stats.events = learnEventVol(restrict(official, today), known, today);
  stats.news = learnNewsDrift(restrict(official, today), known, today);
  const rows = forecast({
    rates: anchorRates,
    basket: restrict(basket, today),
    factors: factorsAt(factors, today),
    anchorDate: today,
    stats,
    events: known,
    eventStats: stats.events,
    newsStats: stats.news,
  });
  await insertPredictions(target, rows, true);
  await sql`
    INSERT INTO model_stats (currency, as_of, stats) VALUES (${target}, ${today}, ${sql.json(stats as never)})
    ON CONFLICT (currency, as_of) DO UPDATE SET stats = EXCLUDED.stats`;
  const tomorrow = rows.find((r) => r.model === "ensemble" && r.horizon === 1);
  log.push(`${target}: forecast ${rows.length} rows, tomorrow ≈ ${tomorrow?.predicted.toFixed(4)}`);
}

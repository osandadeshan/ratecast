<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# RateCast: guide for coding agents

RateCast is a no-login Next.js app on Vercel. It shows today's **SGD → LKR**, **SGD → USD** and **USD → LKR** Wise rates and a
month view: past days show the actual rate, future days show a forecast. Forecasts come from several models
whose blend **learns from its own misses**. The rules below apply to every agent (Claude Code, Codex, Cursor,
…). Deeper references: `docs/ARCHITECTURE.md` (how it works) and `docs/CONTEXT.md` (why, requirements,
results, limitations).

## Hard constraints
- **Free tier only.** Vercel Hobby + Neon Postgres free + keyless public APIs. Never add a paid service, an
  API key or a second cron job. Vercel Hobby allows only **daily** crons.
- **No login, no user data.** The app is public and read-only.
- **No Claude attribution.** No `Co-Authored-By: Claude` trailer and no "Generated with Claude Code" line in
  commits or PRs. The owner is the sole author.
- Never commit `.env*` (except `.env.example`). Never print `DATABASE_URL` or `CRON_SECRET`.

## Commands
| Task | Command |
|---|---|
| Local DB (Docker) | `docker start ratecast-pg` (create: see README) |
| Run one sync (ingest → evaluate → learn → forecast) | `npm run sync` (reads `.env.local`) |
| Dev server | `npm run dev` |
| Typecheck / lint / build | `npx tsc --noEmit` · `npm run lint` · `npm run build` |
| Unit tests | `npm test` (node:test via tsx, `tests/*.test.ts`, 80 tests) |
| Backtest current code (read-only) | `npm run backtest` (~30 s; same code path as the sync) |
| Full 365-day replay in one run | `REPLAY_BUDGET_MS=100000000 npm run sync` |
| Inspect DB | `docker exec ratecast-pg psql -U postgres -d rates` |

`tests/` covers the pure parts (parsers, dates, PDF text, events, news, `cbsl_gap`). Add a test for every new
parser or model. Verify changes with tests + typecheck + lint + build, `npm run sync`, and by loading the page
or `GET /api/dashboard`. For model changes, run the backtest (`.claude/skills/backtest/SKILL.md`).

## Layout
```
app/page.tsx                  Server page: Suspense + connection(); after() triggers sync if today's run is missing
app/components/               Client UI (DashboardView = whole page, MonthChart = Recharts)
app/api/cron/sync/route.ts    Daily Vercel Cron target (Bearer CRON_SECRET)
app/api/dashboard/route.ts    Read-only JSON of everything on the page
lib/config.ts                 Currencies, horizons, windows, timezone, MACRO_FACTORS (single source of truth)
lib/dates.ts                  YYYY-MM-DD string date math (UTC-based)
lib/db.ts                     postgres.js client + idempotent CREATE TABLE IF NOT EXISTS schema
lib/sources/                  Wise (history, comparisons), market (ECB basket, cross-checks),
                              macro (US Treasury 2y yield CSV, FRED Brent CSV),
                              srilanka (+ srilanka-xlsx: CBSL daily USD/LKR + SGD/LKR fixing, policy rate,
                              3m T-bill, remittances, tourism; dependency-free .xlsx reader),
                              events (Fed FOMC page + JSON, CBSL review list + PDF, CBSL RSS,
                              decision outcomes read from each FOMC statement / CBSL review PDF),
                              pdf (dependency-free PDF text via node:zlib), http (getJSON/getText/getBytes)
lib/predict/                  series helpers, calendar (detects non-trading weekdays, e.g. Sundays),
                              models (incl. `macro`, `lanka`, `cross`, `cbsl_gap` + SHADOW_MODELS), learning (weights/bias/
                              sigma/shadow promotion), events (event-day
                              volatility + band widening), news (post-announcement drift for the
                              shadow `news` model), engine (forecast)
lib/sync.ts                   Orchestration of a sync run, incl. no-lookahead replay of missed days
lib/dashboard.ts              All read queries for the page
lib/predict/replay.ts         forecastDay (one day of learn → forecast from data known that day; shared by the
                              sync's replay, its live run and the backtest), restrict/factorsAt, learningChanges
lib/predict/backtest.ts       In-memory 365-day backtest of the current code vs the random walk; compareVersions
lib/performance.ts            Pure metrics for the Performance card: MAPE/RMSE/MAE vs random walk (7/30/90 d),
                              horizons 1/7/14/30 + 80% coverage, bias t-test, trend vs baseline, outlook
scripts/sync.ts               CLI wrapper for runSync()
scripts/backtest.ts           `npm run backtest`: print the in-memory backtest (nothing is written)
tests/                        Unit tests for the pure code (node:test)
vercel.json                   Functions in sin1 (Singapore, next to Neon); cron /api/cron/sync at 01:30 UTC (09:30 SGT)
```

## Invariants: do not break these
1. **No look-ahead.** A forecast made on day `t` may only use rates with `date <= t` and the ECB basket
   `< t`. Learned stats at `t` use only errors whose `target_date <= t`. The replay loop in `lib/sync.ts` relies
   on this.
2. **Forecasts are write-once and permanent.** `insertPredictions` only does `ON CONFLICT DO NOTHING`: a second
   run on the same day keeps the first forecast. Every row has `origin` (`live` = made on `made_on` by that day's
   run, `replay` = rebuilt later from data known on `made_on`) and `model_version` (`MODEL_VERSION` in
   `lib/config.ts`: bump it when lib/predict, learning or inputs change). `ensemble` and `naive` rows are never
   deleted; other models' rows are pruned after `PRUNE_MODELS_AFTER_DAYS` (550, ~1.5 years, to stay in Neon's
   0.5 GB). Never update a stored prediction or error to improve reported accuracy.
2b. **Actuals are official only.** `prediction_errors` is filled only from `rates_history.source = 'wise'`.
   Today's live quote is stored as `source = 'wise_live'` (provisional) and is overwritten by Wise's daily point.
   Wise data is validated first (`lib/sources/validate.ts`: positive, valid date, daily jump ≤ 20% for LKR pairs /
   5% for SGD→USD, live quote vs last official point); rejects are dropped and reported in `source_health`
   (`wise-history:*`, `wise-live:*`). `cross-rate` checks SGD→LKR ≈ SGD→USD × USD→LKR (limit 0.5%).
   The page shows delta as **predicted − actual** (+ = too high). The stored `prediction_errors.delta` is
   actual − predicted and stays that way (stored data).
3. **Model names are data.** Stored model names: `naive, drift, holt, monthly_pattern, mean_reversion, market, macro, news, lanka, cross, cbsl_gap`
   plus the derived `blend` (raw weighted), `blend_bc` (blend with bias correction, always stored as the
   counterfactual) and `ensemble` (the final number shown to users). Renaming a model orphans its history.
4. **Schema changes are additive.** `ensureSchema()` runs `CREATE ... IF NOT EXISTS` on every cold start. There
   is no migration tool: add new tables/columns with `IF NOT EXISTS`, never drop or rename.
5. **GET route handlers with side effects must `await connection()` first.** Cache Components is on, and
   without it Next prerenders the handler at build time (this once ran a full sync during `next build`).
6. **Policy events are automatic, band-only and look-ahead-free.** (`lib/sources/events.ts`, `lib/predict/events.ts`)
   - Every event comes from a scraper. The owner will **never** enter dates or data by hand, so don't design
     anything that needs it. If a source has no clean feed, parse HTML/PDF, infer, or record after the fact.
   - `events.kind` values (`fomc`, `cbsl_policy`, `imf`) are data, like model names: never rename.
   - A forecast made on day `t` uses only events with `known_since <= t`. `learnEventVol` only learns from
     events whose move window has closed (`event_date + 1 <= t`).
   - Events widen only the `ensemble` 80% band. They never change any point forecast.
   - Each scraper fails on its own: log it, write `source_health`, and carry on. A scraper must never fail
     the sync.
   - `events.outcome` (`cut | hold | hike`, IMF `sla | board | other`, `unclear`) is read from the event's
     **own** statement: FOMC `monetaryYYYYMMDDa.htm`, or the CBSL review PDF whose file name carries
     `press_YYYYMMDD` of that event. Never classify from a different statement's PDF. An outcome counts only
     from `event_date + 1` (CBSL publishes after the 09:30 SGT sync). Once set, the upsert never overwrites it.
7. **Macro factors are lagged, and new models start in shadow.** (`lib/config.ts`, `lib/predict/models.ts`)
   - Each factor in `MACRO_FACTORS` has a `lagDays` (`ust2y` 1, `brent` 9: FRED's Brent runs ~1 week late).
     Replay and live both see only `date <= anchor - lagDays` (`factorsAt` in `lib/sync.ts`). Don't use a
     factor value the 09:30 SGT sync couldn't have had.
   - `LANKA_FACTORS` (CBSL series) follow the same rule: daily fixings lag 1 day, policy rate / T-bill 60,
     remittances / tourism 45 (monthly tables are published 1–2 months late).
   - **Every model except `naive` is gated** (`learning.ts`): it gets weight 0 in a horizon bucket until it has
     ≥ 30 distinct target dates there and beats the random walk by a paired t-test on per-date |error|
     (overlap-adjusted n, t < −2.6, Bonferroni for ~10 candidates). The bias correction passes the same
     test against `blend`. Promotion is automatic (`BucketStats.promoted`). `SHADOW_MODELS` (`macro`, `news`,
     `lanka`, `cross`, `cbsl_gap`) only marks models built on external data for the UI. Never loosen the bar to get a model in.
   - Non-trading weekdays (Sunday's Wise point repeats Saturday's) are detected from the data
     (`calendar.ts`): forecasts stay flat across them and their target dates are left out of learning.
8. **Pairs are data, and SGD→LKR is also forecast in two parts.** `TARGETS` ids (`LKR`, `USD`, `USDLKR`) are
   stored in every table: never rename. `PREDICT_ORDER` forecasts the legs (SGD→USD, USD→LKR) first so the
   `cross` model for SGD→LKR can use their `ensemble` forecasts made on the same anchor day.
9. **Dates are `YYYY-MM-DD` strings.** "Today" is Singapore time (`todayISO()`). Wise history points are UTC
   midnight. Select dates as `date::text` and never pass JS `Date` objects for `date` columns.

## Conventions
- TypeScript strict, `@/` import alias, no `any` without reason. Keep `lib/predict/*` pure (no I/O) so the
  replay and live paths share code.
- Rates are `double precision` (JS number). Format only at the UI edge (`lib/format.ts`).
- UI colours come from CSS tokens in `app/globals.css` (light + dark). Chart series: `--series-1` actual,
  `--series-2` predicted/band, `--series-3` last month. Don't hard-code hex in components.
- Outbound fetches go through `lib/sources/http.ts` (timeout, generic User-Agent, `no-store`).
- Policy events fit the free tier: no new dependency (PDF text is extracted with `node:zlib`), no API key,
  and they run inside the same single daily cron. Outcome classification reads at most 32 statements per
  run. Not built yet: MAS statements (site still shows a maintenance page), IMF forward windows, GDELT news
  tone (rate-limited from here, and the DOC API only keeps a rolling 3 months, so no backfill). See
  `docs/CONTEXT.md`.
- Macro factors (Treasury yield curve CSV, FRED Brent CSV) are keyless and use the same cron. Polymarket/Kalshi
  Fed odds are deferred: per-meeting contracts would need stitching and have short histories, and the 2y yield
  (same information) earned no weight. Revisit only if `macro` gets promoted.
- Sri Lanka data (CBSL indicative-rate form POST + statistical-table .xlsx, read by `lib/sources/srilanka-xlsx.ts`
  without a dependency) uses the same cron. CBSL weekly reserves and net USD purchases are only in a weekly PDF
  the `node:zlib` reader can't extract, so they're not ingested. Labels for the UI live in `SRI_LANKA_META`
  (`lib/config.ts`): don't import `lib/sources/*` from `lib/dashboard.ts` (it broke the Turbopack build).
- Scoring (`evaluatePredictions`) runs `ANALYZE` then the INSERT with `SET LOCAL enable_nestloop = off`.
  Without it a big replay made the planner pick nested loops (13 min instead of 8 s). Keep it.
- Be honest in UI copy: FX is close to a random walk. Always show accuracy next to the random-walk baseline.

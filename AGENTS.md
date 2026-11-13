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
| Inspect DB | `docker exec ratecast-pg psql -U postgres -d rates` |

There is no test suite. Verify changes with typecheck + lint + build, `npm run sync`, and by loading the page
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
                              models (incl. `macro`, `lanka`, `cross` + SHADOW_MODELS), learning (weights/bias/
                              sigma/shadow promotion), events (event-day
                              volatility + band widening), news (post-announcement drift for the
                              shadow `news` model), engine (forecast)
lib/sync.ts                   Orchestration of a sync run, incl. no-lookahead replay of missed days
lib/dashboard.ts              All read queries for the page
scripts/sync.ts               CLI wrapper for runSync()
vercel.json                   Functions in sin1 (Singapore, next to Neon); cron /api/cron/sync at 01:30 UTC (09:30 SGT)
```

## Invariants: do not break these
1. **No look-ahead.** A forecast made on day `t` may only use rates with `date <= t` and the ECB basket
   `< t`. Learned stats at `t` use only errors whose `target_date <= t`. The replay loop in `lib/sync.ts` relies
   on this.
2. **Actuals are official only.** `prediction_errors` is filled only from `rates_history.source = 'wise'`.
   Today's live quote is stored as `source = 'wise_live'` (provisional) and is overwritten by Wise's daily point.
3. **Model names are data.** Stored model names: `naive, drift, holt, monthly_pattern, mean_reversion, market, macro, news, lanka, cross`
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
     `lanka`, `cross`) only marks models built on external data for the UI. Never loosen the bar to get a model in.
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
- Be honest in UI copy: FX is close to a random walk. Always show accuracy next to the random-walk baseline.

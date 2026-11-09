<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# RateCast: guide for coding agents

RateCast is a no-login Next.js app on Vercel. It shows today's **SGD → LKR** and **SGD → USD** Wise rates and a
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
lib/config.ts                 Currencies, horizons, windows, timezone (single source of truth)
lib/dates.ts                  YYYY-MM-DD string date math (UTC-based)
lib/db.ts                     postgres.js client + idempotent CREATE TABLE IF NOT EXISTS schema
lib/sources/                  Wise (history, comparisons), market (ECB basket, cross-checks)
lib/predict/                  series helpers, models, learning (weights/bias/sigma), engine (forecast)
lib/sync.ts                   Orchestration of a sync run, incl. no-lookahead replay of missed days
lib/dashboard.ts              All read queries for the page
scripts/sync.ts               CLI wrapper for runSync()
vercel.json                   Cron: /api/cron/sync at 01:30 UTC (09:30 SGT)
```

## Invariants: do not break these
1. **No look-ahead.** A forecast made on day `t` may only use rates with `date <= t` and the ECB basket
   `< t`. Learned stats at `t` use only errors whose `target_date <= t`. The replay loop in `lib/sync.ts` relies
   on this.
2. **Actuals are official only.** `prediction_errors` is filled only from `rates_history.source = 'wise'`.
   Today's live quote is stored as `source = 'wise_live'` (provisional) and is overwritten by Wise's daily point.
3. **Model names are data.** Stored model names: `naive, drift, holt, monthly_pattern, mean_reversion, market`
   plus the derived `blend` (raw weighted), `blend_bc` (blend with bias correction, always stored as the
   counterfactual) and `ensemble` (the final number shown to users). Renaming a model orphans its history.
4. **Schema changes are additive.** `ensureSchema()` runs `CREATE ... IF NOT EXISTS` on every cold start. There
   is no migration tool: add new tables/columns with `IF NOT EXISTS`, never drop or rename.
5. **GET route handlers with side effects must `await connection()` first.** Cache Components is on, and
   without it Next prerenders the handler at build time (this once ran a full sync during `next build`).
6. **Dates are `YYYY-MM-DD` strings.** "Today" is Singapore time (`todayISO()`). Wise history points are UTC
   midnight. Select dates as `date::text` and never pass JS `Date` objects for `date` columns.

## Conventions
- TypeScript strict, `@/` import alias, no `any` without reason. Keep `lib/predict/*` pure (no I/O) so the
  replay and live paths share code.
- Rates are `double precision` (JS number). Format only at the UI edge (`lib/format.ts`).
- UI colours come from CSS tokens in `app/globals.css` (light + dark). Chart series: `--series-1` actual,
  `--series-2` predicted/band, `--series-3` last month. Don't hard-code hex in components.
- Outbound fetches go through `lib/sources/http.ts` (timeout, generic User-Agent, `no-store`).
- Be honest in UI copy: FX is close to a random walk. Always show accuracy next to the random-walk baseline.

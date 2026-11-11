# CLAUDE.md

@AGENTS.md

## Claude Code specifics

- **Hook:** `.claude/settings.json` runs ESLint on every `.ts`/`.tsx` file after Edit/Write. Lint errors come
  back as a blocking message: fix them before moving on. Don't disable the hook to get around it. It already
  covers the policy-event files, so no new hook was needed.
- **Attribution is off** in `.claude/settings.json` (`attribution.commit`/`pr` = ""). Keep it that way.
- **Path-scoped rules** in `.claude/rules/` load when you touch matching files:
  `nextjs.md` (app/), `database.md` (db, sync, dashboard), `forecasting.md` (lib/predict), `ui.md` (components, css),
  `events.md` (lib/sources/events.ts, lib/sources/pdf.ts, lib/predict/events.ts), `macro.md` (lib/sources/macro.ts, lib/config.ts).
- **Project skills** in `.claude/skills/`:
  - `run-locally`: start Postgres, sync, dev server, screenshot check.
  - `backtest`: reset forecasts, replay 90 days, compare every model to the random walk.
  - `verify-deploy`: post-deploy checks on Vercel (live quote, cron, first sync).
  - `add-currency`: add a new target currency end to end.
  - `add-event-source`: add a new automatic policy-event scraper (kind, parser, health, backtest).
  - `add-macro-factor`: add a new macro factor (source, lagDays, model input) and backtest it in shadow mode.
- **Sandbox network:** in the local Claude Code sandbox, `curl` to `fred.stlouisfed.org` fails while Node `fetch`
  (i.e. `npm run sync`) works. Test FRED through the sync or WebFetch, not curl. Vercel has no such limit.
- Next.js 16 differs from your training data. Read `node_modules/next/dist/docs/` before using an unfamiliar
  API (see the block at the top of AGENTS.md).
- Commit or push only when asked. Never force-push without explicit approval.

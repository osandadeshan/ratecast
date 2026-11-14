# CLAUDE.md

@AGENTS.md

## Claude Code specifics

- **Hook:** `.claude/settings.json` runs ESLint on every `.ts`/`.tsx` file after Edit/Write. Lint errors come
  back as a blocking message: fix them before moving on. Don't disable the hook to get around it. It already
  covers the policy-event, macro and Sri Lanka (`srilanka*.ts`, `calendar.ts`, `tests/`) files, so no new hook was
  needed. There is no `.claude/hooks/` dir; hooks live in `settings.json`.
- **Attribution is off** in `.claude/settings.json` (`attribution.commit`/`pr` = ""). Keep it that way.
- **Path-scoped rules** in `.claude/rules/` load when you touch matching files:
  `nextjs.md` (app/), `database.md` (db, sync, dashboard), `forecasting.md` (lib/predict), `ui.md` (components, css),
  `events.md` (lib/sources/events.ts, lib/sources/pdf.ts, lib/predict/events.ts), `macro.md` (lib/sources/macro.ts, lib/sources/srilanka.ts, lib/sources/srilanka-xlsx.ts, lib/config.ts).
- **Project skills** in `.claude/skills/`:
  - `run-locally`: start Postgres, sync, dev server, screenshot check.
  - `backtest`: compare every model to the random walk. For the current code use `npm run backtest`
    (in-memory, read-only, ~30 s: 365 days replayed, last 300 scored, Sundays excluded, three pairs). The
    sync stores the same backtest once per `MODEL_VERSION` in `model_versions`. Older sections of the
    skill still say 60/90 days: use 300 scored days.
  - `verify-deploy`: post-deploy checks on Vercel (live quote, cron, first sync).
  - `add-currency`: add a new target currency end to end.
  - `add-event-source`: add a new automatic policy-event scraper (kind, parser, health, backtest).
  - `add-macro-factor`: add a new macro factor (source, lagDays, model input) and backtest it in shadow mode.
- **Local sandbox workarounds** (from the 2026-11 sessions):
  - Run tools from `node_modules/.bin/` (`tsc`, `eslint`, `next`) instead of `npx`, which tries the registry.
  - Tests: `node --import tsx --test tests/*.test.ts` (the `tsx` CLI fails with EPERM on its IPC pipe).
    Sync: `node --import tsx --env-file=.env.local scripts/sync.ts`, with `REPLAY_BUDGET_MS=100000000` for a full
    365-day replay (~54 s on an empty DB).
  - Docker (Colima) and `next build` / `next start` (port binding) need to run outside the sandbox. Delete
    `.next` first if a sandboxed build left it half-written. Local DB: container `ratecast-pg` on port 54329.
  - `~/.npm` has root-owned files: use `npm ci --cache "$TMPDIR/npm-cache"` (owner fix: `sudo chown -R 501:20 ~/.npm`).
    If esbuild complains about the wrong platform, reinstall with `npm ci`.
  - `.claude/skills/` and `.claude/settings.json` are write-protected from the sandbox. Edits there need the
    owner's approval (or `/sandbox`).
- **Sandbox network:** in the local Claude Code sandbox, `curl` to `fred.stlouisfed.org` fails while Node `fetch`
  (i.e. `npm run sync`) works. Test FRED through the sync or WebFetch, not curl. Vercel has no such limit.
- Next.js 16 differs from your training data. Read `node_modules/next/dist/docs/` before using an unfamiliar
  API (see the block at the top of AGENTS.md).
- Commit or push only when asked. Never force-push without explicit approval.

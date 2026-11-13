---
name: add-macro-factor
description: Add a new macro factor (e.g. US 10y yield, DXY, gold, SGD rates) as an input to RateCast's shadow `macro` model - verify a keyless source, parse it, set an honest publication lag, ingest it with health tracking, and backtest it in shadow mode. Use when asked to feed another market/economic series into the forecasts.
---

# Add a macro factor

Read `.claude/rules/macro.md` and `.claude/rules/forecasting.md` first. Requirements: keyless, free, no second
cron, fully automatic. The `macro` model stays at weight 0 until the learner's significance gate promotes it
(≥ 30 distinct dates, paired t < −2.6 vs naive). Never promote by hand or loosen the gate.

**Sri Lanka (CBSL) series** go to `LANKA_FACTORS` / `SRI_LANKA_META` in `lib/config.ts` instead, are fetched in
`lib/sources/srilanka.ts` (+ `srilanka-xlsx.ts` for statistical-table .xlsx files) and feed the `lanka` model
(LKR pairs only). Same lag rule: monthly CBSL tables are lagged 45–60 days. A factor whose effect is a gap to an
official rate may deserve its own model, like `cbsl_gap`.

1. **Verify the source from the shell** with a generic UA, and save a sample to the scratchpad. Check:
   history length (≥ 2 years), latest date vs today (that's the publication lag), and how the format differs by
   year. FRED can't be reached with `curl` from the local sandbox. Use WebFetch to look at it; `npm run sync`
   (Node fetch) works.
2. **Parser** in `lib/sources/macro.ts`: a pure `parseX(text): Point[]` plus `fetchX()` using `getText` (generous
   timeout for slow hosts). Find columns by header name, skip blanks and `.`, and throw if 0 points.
3. **Config**: add `{ series, label, lagDays, transform }` to `MACRO_FACTORS` in `lib/config.ts`.
   - `lagDays` = observed delay from the value's date until it is reliably out before the 09:30 SGT sync. Round
     up. Never tune it on backtest results.
   - `transform`: `diff` for rates/yields (pp), `log` for prices/indices.
   - The series name is stored in `market_data`: never rename it later.
4. **Ingest**: add a job to `ingestMacro` in `lib/sync.ts` (first run ~800 days, then ~60). It already records
   `source_health` through `recordHealth`. Add the source label to `SOURCE_LABEL` in `lib/dashboard.ts`.
   `.macro` on the dashboard picks the series up from `MACRO_FACTORS` automatically.
5. **Run**: `npx tsc --noEmit && npm run lint`, then `npm run sync`. Expect a `<series>: N days (latest …)` line
   and `SELECT * FROM source_health`.
6. **Backtest** with the "Shadow / new model" section of the backtest skill: snapshot without the new factor
   (comment it out of `MACRO_FACTORS`), run with it, compare the ensemble per bucket, and check `macro` vs `naive`.
   Accept only if the ensemble is no worse in every bucket.
7. **Docs**: update `.claude/rules/macro.md` (source table), `docs/CONTEXT.md` (dated results), and the README
   data-sources table.

Deferred so far:
- **Polymarket/Kalshi Fed odds.** Keyless and reachable, but each contract covers one meeting and lives a few
  months, so a daily series means stitching contracts as meetings roll over. The 2y yield already carries the
  Fed path. Revisit only once `macro` is promoted somewhere.
- **Yahoo Finance.** Unofficial API, against its terms.
- **Stooq.** Now behind a JavaScript challenge.

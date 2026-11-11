---
paths:
  - "lib/sources/macro.ts"
  - "lib/config.ts"
---

# Macro factor rules (Treasury yields, Brent)

- Same constraints as everything else: keyless, free, inside the single daily sync, fetched through
  `lib/sources/http.ts`, and fully automatic (never hand-entered values).
- Sources (`lib/sources/macro.ts`, ingested by `ingestMacro` in `lib/sync.ts`, health in `source_health`):
  | series | source | parse | fragility |
  |---|---|---|---|
  | `ust2y` | home.treasury.gov daily par yield curve CSV, one per year | find the `"2 Yr"` column **by header name** (columns differ by year, e.g. 2025 added "1.5 Month"); dates `MM/DD/YYYY` | Slow and erratic: 0.6–20 s per CSV. Fetch years **sequentially**, 40 s timeout. First run fetches 3 years, later runs the current year (plus the last one in January) |
  | `brent` | FRED `fredgraph.csv?id=DCOILBRENTEU` | `observation_date,VALUE`, `.` = missing | EIA-sourced, so it **lags ~1 week** (Nov 3 was latest on Nov 11). First run 800 days, later 60 |
- `MACRO_FACTORS` (`lib/config.ts`) is the single list: `series`, `label`, `lagDays`, `transform`
  (`diff` for yields in pp, `log` for prices). Series names are data, like model names: never rename.
- `lagDays` = how long after its date a value is reliably available at the 09:30 SGT sync (`ust2y` 1, `brent` 9).
  Replay and live both use `date <= anchor − lagDays`. Base it on the observed delay, never on backtest results.
- Local dev: the Bash sandbox blocks `curl` to fred.stlouisfed.org, but Node's `fetch` (`npm run sync`) works. Test
  FRED via the sync or WebFetch, not curl.
- Deferred: Polymarket/Kalshi Fed-odds. They're keyless and work, but each contract covers one meeting and lives
  only a few months, so a daily series means stitching contracts as meetings roll. That's the same information
  as the 2y yield. Revisit only if `macro` ever gets promoted.

---
paths:
  - "lib/sources/macro.ts"
  - "lib/sources/srilanka.ts"
  - "lib/sources/srilanka-xlsx.ts"
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
  | `usd_broad` | FRED `fredgraph.csv?id=DTWEXBGS` (Fed H.10 broad trade-weighted dollar index), health `fred-usd-broad` | same FRED CSV parser | **Weekly** release (Mon 16:15 ET) with data to the previous Friday: Nov 6 was latest on Nov 13/14. lag 10. SGD→USD only (`pairs: ["USD"]`) |
- `MACRO_FACTORS` (`lib/config.ts`) is the single list: `series`, `label`, `lagDays`, `transform`
  (`diff` for yields in pp, `log` for prices). Series names are data, like model names: never rename.
- Optional `pairs`: the factor only feeds the `macro` model for those pairs (default: all).
- `lagDays` = how long after its date a value is reliably available at the 09:30 SGT sync (`ust2y` 1, `brent` 9,
  `usd_broad` 10).
  Replay and live both use `date <= anchor − lagDays`. Base it on the observed delay, never on backtest results.
- Local dev: the Bash sandbox blocks `curl` to fred.stlouisfed.org, but Node's `fetch` (`npm run sync`) works. Test
  FRED via the sync or WebFetch, not curl.
- Deferred: Polymarket/Kalshi Fed-odds. They're keyless and work, but each contract covers one meeting and lives
  only a few months, so a daily series means stitching contracts as meetings roll. That's the same information
  as the 2y yield. Revisit only if `macro` ever gets promoted.

## Sri Lanka series (CBSL, `lib/sources/srilanka.ts`)
- `SRI_LANKA_SERIES` lists each series with its fetcher and `source_health` key. Series names (`lk_*`) are data.
  | series | source | lag (`LANKA_FACTORS`) |
  |---|---|---|
  | `lk_usd_spot`, `lk_sgd_ind` | CBSL exchange-rate lookup (HTML form **POST**, table back to 2006), health `cbsl-fx` | 1 day |
  | `lk_opr`, `lk_tbill3m` | statistical table 4.04 `.xlsx` (newest link picked from the statistics page; file name carries the publish date), health `cbsl-rates` | 60 days |
  | `lk_remit`, `lk_tourism` | tables 2.14.2 / 2.14.1 `.xlsx`, USD mn, monthly at month end, health `cbsl-external` | 45 days |
  | `lk_ccpi_yoy` | real-sector page `CCPI_and_CCPI_CORE_YYYYMMDD_e.xlsx`, headline YoY % (column found by its "Year-on-Year" header), health `cbsl-prices` | 5 days (DCS publishes on the month's last working day). **Context only, not in `LANKA_FACTORS`**: the sheet holds ~13 months, so history builds up run by run. Test it as a `lanka` input once ≥ 2 years are stored. |
- `.xlsx` is read without a dependency (`srilanka-xlsx.ts`: zip central directory + `node:zlib` inflate + shared
  strings). Keep it that way (free tier, no new packages).
- Not usable yet: weekly reserves and CBSL's net USD purchases. They're only in a weekly PDF whose text the
  dependency-free PDF reader can't extract.
- Models on these series: `lanka` (ridge on all `LANKA_FACTORS`) and `cbsl_gap` (Wise moves toward CBSL's fixing).
  Both are gated like every model and only run for LKR pairs.

# RateCast architecture

## Overview

```
                    ┌──────────────── daily 01:30 UTC (Vercel Cron) ─────────────────┐
                    │     or a page view from 10:30 SGT via after() (self-heal)      │
                    ▼                                                                │
 Wise rates/history ─┐                                                               │
 Wise comparisons ───┤   ┌────────────┐   ┌──────────┐   ┌────────┐   ┌──────────┐   │
 Frankfurter (ECB) ──┼──▶│ 1. ingest  │──▶│2. evaluate│──▶│3. learn│──▶│4. forecast│   │
 ExchangeRate-API ───┤   └────────────┘   └──────────┘   └────────┘   └──────────┘   │
 Currency-API ───────┤         │               │              │             │         │
 Fed FOMC page/JSON ─┤         ▼               ▼              ▼             ▼         │
 CBSL review list/PDF┤  rates_history   prediction_errors  model_stats   predictions ─┘
 CBSL RSS ───────────┤  live_quotes     (the delta table)  (+ event ratios)  (band widened
 BLS schedule ───────┤  market_data                                           around events)
 US Treasury CSV ────┤  (+ ust2y, brent, usd_broad,
 FRED Brent/DTWEXBGS ┤   lk_* Sri Lanka series)
 CBSL rates / xlsx ──┘  events, source_health,
                        model_versions, learning_log
                               │
                               ▼
              app/page.tsx ◀── lib/dashboard.ts (read-only queries + 5-min cached live quote)
```

## Sync run (`lib/sync.ts → runSync`)

1. **Lock.** One row in `sync_lock` with a random token; only the owner's token releases it, and an expired row
   (`SYNC_LOCK_MINUTES` = 6, longer than the cron's 300 s limit) can be taken over. A concurrent page run returns
   `skipped`; the cron waits up to 70 s for the lock, then skips if today's run already finished ok. Leftover
   `running` rows from killed runs are closed as `error`. A page-triggered run (`needsSync()`: from
   `PAGE_SYNC_FROM_SGT` = 10:30, no `ok` run today, no run started in the last 15 min) reads at most 4 outcome
   statements and postpones the version backtest if less than 35 s are left.
2. **Market data.** Frankfurter `USD → EUR, JPY, GBP, CNY` time series → `usd_basket` = mean of the logs
   (rises when the USD strengthens): 420 days while there are < 200 rows, otherwise 45. Cross-check "today"
   rates from ExchangeRate-API and Currency-API → `xc:<pair>:<source>` (USD→LKR is derived from each source's
   SGD quotes).
   Then **macro factors and Sri Lanka series** (`ingestMacro`, step "1a"; see [Macro factors](#macro-factors-libsourcesmacrots)):
   the US Treasury 2-year yield, FRED Brent and the FRED broad dollar index go to `market_data` as `ust2y`,
   `brent` and `usd_broad`, each with its own `source_health` row (`treasury`, `fred-brent`, `fred-usd-broad`).
   The same step fetches the **Sri Lanka series** (`SRI_LANKA_SERIES` in `lib/sources/srilanka.ts`): CBSL's daily
   indicative USD/LKR (`lk_usd_spot`) and SGD/LKR (`lk_sgd_ind`) via its rate-lookup form, and monthly policy rate
   (`lk_opr`), 3-month T-bill (`lk_tbill3m`), workers' remittances (`lk_remit`), tourism earnings (`lk_tourism`)
   and Colombo CPI inflation (`lk_ccpi_yoy`, context only) from CBSL's statistical .xlsx tables (read by the
   dependency-free `srilanka-xlsx.ts`): 800 days while a series has < 20 rows, otherwise 120. Health rows
   `cbsl-fx`, `cbsl-rates`, `cbsl-external`, `cbsl-prices` (series that share a source report together; the row
   is an error only if all of them failed). All jobs run in parallel; failures are logged and never fail the sync.
   Then **policy events** (`ingestEvents`, step "1b" in the code; see [Policy events](#policy-events)): fetch
   the Fed, CBSL and BLS calendars, upsert `events`, and record each scraper's outcome in `source_health`. A
   failing source is logged and never fails the sync.
   Then **decision outcomes** (`classifyOutcomes`; see [Decision outcomes](#decision-outcomes-and-post-announcement-drift)):
   past `OUTCOME_KINDS` events (within 800 days) with no `outcome` get their own statement read and classified,
   at most 32 fetches per run, newest first. A scheduled date that passed ≥ 7 days ago without its own statement
   (FOMC 404, or a CBSL date with no PDF of its own while the CBSL list was read in this run) is deleted as a
   meeting that never happened. Health row `outcomes`.
3. **Ingest each pair.**
   - Wise history: 2 years on first run (< 300 rows), otherwise 3 months. Checked by `validateHistory`
     (`lib/sources/validate.ts`) against the last stored point, then upserted as `source='wise'`. Health row
     `wise-history:<pair>`; a failed fetch keeps the stored history.
   - Wise comparison: the mid-market rate plus up to 3 providers' quotes for 1,000 of the base currency →
     `live_quotes`, and today's provisional `rates_history` row (`wise_live`), which never overwrites a `wise`
     row. Checked by `validateLive` first. Health row `wise-live:<pair>`.
   - Then `checkCrossRate`: SGD→LKR vs SGD→USD × USD→LKR on the latest common official date (limit 0.5%),
     health row `cross-rate`.
4. **Evaluate.** A single INSERT…SELECT joins `predictions` to official `rates_history` rows and writes every
   not-yet-scored prediction to `prediction_errors` with `delta = actual − predicted`,
   `pct_error = (predicted − actual)/actual × 100` and `log_error = ln(predicted/actual)`. It runs after `ANALYZE`
   inside a transaction with `SET LOCAL enable_nestloop = off`: after a 365-day replay the planner otherwise picked
   nested loops (13 min instead of 8 s).
5. **Replay missed days.** Pairs run in `PREDICT_ORDER` (SGD→USD, USD→LKR, then SGD→LKR, whose `cross` model
   reads the legs' `ensemble` rows for the same anchor). For each day `t` in the last 365 days
   (`BACKFILL_DAYS`) that has an official rate and no `ensemble` forecast (all of them on first run, or gaps if
   the cron missed a day), within `REPLAY_BUDGET_MS` (40 s from sync start; the rest continues next run, and the
   run ends as `partial`): learn from errors with target ≤ t, forecast from rates ≤ t, insert as
   `origin = 'replay'`, and push the realised errors into memory so day t+1 learns from them. This is a backtest.
6. **Forecast today.** The anchor is today's live Wise rate (or the latest stored rate, carried forward, if there
   is no quote for today). Horizons 1..31, inserted as `origin = 'live'`. Inserts are `ON CONFLICT DO NOTHING`, so
   a second run on the same day keeps the first forecast. Then the `LearnedStats` JSON goes to `model_stats`
   (one row per pair and day) and promotions/demotions since the previous day go to `learning_log`. After all
   pairs, the newly replayed forecasts are evaluated again.
7. **Version backtest** (step 4b in the code, only when the replay is complete; see
   [Version backtest](#version-backtest-and-learning-log)).
8. **Prune.** Predictions of models other than `ensemble` and `naive` with a target older than
   `PRUNE_MODELS_AFTER_DAYS` (550) and `live_quotes` older than 60 days are deleted. The `sync_runs` row ends as
   `ok` or `partial` (`partial` keeps `needsSync()` true, so the next page view or cron continues).

## Models (`lib/predict/models.ts`, all on log rates)

| key | idea |
|---|---|
| `naive` | random walk: every horizon = today |
| `drift` | mean daily log change over 30 days, damped by 0.97^k |
| `holt` | damped Holt linear trend; α, β, φ grid-searched on one-step SSE over 120 days |
| `monthly_pattern` | path from the same day-of-month 1/2/3 months ago (weights 0.5/0.3/0.2), × 0.6 |
| `mean_reversion` | pull to the 30-day mean at 4%/day |
| `market` | β of the pair's daily returns on the ECB USD basket (90 days) × 10-day basket momentum, damped 0.9^k |
| `macro` | **shadow model.** Ridge regression of daily returns on the lagged 5-day moves of the US 2y yield, Brent and (SGD→USD only) the broad dollar index (see below) |
| `news` | **shadow model.** `naive` plus the learned post-announcement drift for a few days after a classified Fed/CBSL decision (see below) |
| `lanka` | **shadow model, LKR pairs.** Same ridge factor model on `LANKA_FACTORS`: gap to CBSL's fixing, CBSL's 5-day USD/LKR move, policy rate and T-bill changes, YoY remittances and tourism, each with its own lag |
| `cross` | **shadow model, SGD→LKR.** Today's rate moved by the summed log forecasts of the legs (SGD→USD `ensemble` + USD→LKR `ensemble`) |
| `cbsl_gap` | **shadow model, LKR pairs.** Per-horizon no-intercept regression (365 days, ≥ 120 observations, shrunk toward 0 by 60 pseudo-observations, β clamped to [−1, 1.5]) of the Wise move over h days on the gap ln(latest CBSL fixing dated ≤ t − 1 / Wise rate on t). Wise drifts toward CBSL's own rate |
| `arima` | ARIMA(p,1,0): AR(p) on 250 days of daily log returns, p = 0–5 by BIC, ridge-shrunk, only stationary fits (Σ\|β\| < 0.9), iterated forward. p = 0 = random walk. Gated like every model |

## Learning (`lib/predict/learning.ts`)

For each horizon bucket b ∈ {1, 3, 7, 14, 31}, over evaluated errors with target date in [t − 180, t − 1] (never t itself: the live run on day t only has a
provisional quote for t, so replay and backtest must not learn from it either), skipping non-finite errors and
detected non-trading weekdays (`calendar.ts`; Sunday's Wise point repeats Saturday's ≥ 90% of 26 weeks; a
weekday is released as soon as it moved on 2 of its last 4 occurrences):

- `MAE_m` = mean |log error| of model m. Shrunk by distinct target dates d_m (rows overlap at long horizons):
  `(d_m·MAE_m + 10·MAE_pooled)/(d_m + 10)`.
- `w_m ∝ 1 / MAE_shrunk^4`, normalised. With no data, only `naive` has weight (every other model starts
  unpromoted, see below).
- `blend = Σ w_m · f_m` (log space), skipping models with w = 0. A non-finite model output is replaced by the
  anchor rate (random walk) before blending or storing.
- `bias` = exponentially recency-weighted (half-life 14 days) mean log error of `blend`, × n/(n + 15).
- `blend_bc = blend − bias` is always stored, so its accuracy can be measured.
- `ensemble = blend − bias · biasOn`, where `biasOn = 1` iff b ≤ 7 and `blend_bc` beats `blend` by the paired test below.
- **Every model except `naive` is gated** (`SHADOW_MODELS` only labels the external-data ones in the UI). A model
  gets `w = 0` in a bucket until **promoted**: scored on ≥ 30 *distinct* target dates in the window and a paired
  t-test on per-date mean |error| vs `naive` gives t < −`tBar(n_eff)`, with n_eff = dates / bucket mean horizon (neighbouring
  forecasts overlap) and n_eff ≥ 5. `tBar` = max(2.6, Student-t 99.5% quantile at n_eff − 1 df): 2.6 ≈ Bonferroni for ~10
  candidates per bucket at 5% family-wise, and the t quantile keeps a 30-date 15–31d bucket (n_eff ≈ 1.4–8) from
  promoting on noise (the normal 2.6 promoted `holt`/`drift`/`monthly_pattern` that way until 2026-11-14). Unpromoted models are also left out of `MAE_pooled`, so they can't
  shift the other weights. The flag is stored per bucket in `BucketStats.promoted` and is re-evaluated every
  day, so a model can be promoted and demoted automatically. Distinct dates, not raw counts: long-horizon
  forecasts overlap heavily (17 horizons hit the same few target dates), and a first rule of "≥ 60 forecasts"
  promoted `macro` on thin evidence and hurt LKR 8–31 days.
- 80% band: half-width `q80 · √(h / meanH_b)`, where q80 = empirical 80th percentile of the bucket's |ensemble log
  error| normalised to the bucket's mean horizon (n ≥ 30), each error weighted by 0.5^(target age / 30 days)
  (`BAND_HALF_LIFE_DAYS`, so the band follows a change of regime within weeks); fallback 1.2816 × (RMS of the
  bucket's ensemble log errors if n ≥ 10, else 60-day daily vol × √h). Event variance is added in quadrature (see below). **LKR pairs** (`BAND_TREND_STRETCH`, c = 0.4): the side the
  30-day trend points to gets an extra `c · |mean daily log move over 30 days| · h` (one-sided; LKR errors grow
  faster than √h in a trend). Across a non-trading day the forecast and band are frozen. The point forecast never includes events.

## Macro factors (`lib/sources/macro.ts`)

```
US Treasury daily par yield CSV (per year, "2 Yr" column) ─┐                    factorsAt(all, t):
FRED fredgraph.csv?id=DCOILBRENTEU ────────────────────────┼─▶ ingestMacro ─▶ market_data ─▶ each series ≤ t − lagDays
FRED fredgraph.csv?id=DTWEXBGS ────────────────────────────┘   (runSync 1a)   ust2y, brent,       │
                                     source_health: treasury, fred-brent,     usd_broad           ▼
                                                    fred-usd-broad
                                                                      macro model (ModelContext.factors)
                                                                      lib/dashboard.ts `.macro` → Market context card
```

| series | source | lag | transform | quirks |
|---|---|---|---|---|
| `ust2y` | home.treasury.gov CSV, one file per year; the `2 Yr` column is found by header name (columns differ by year) | 1 day | diff (pp) | slow and erratic (0.6–19 s per CSV), so years are fetched one at a time with a 40 s timeout. First run fetches 3 years (≈ 1 min), then only the current year (plus last year in January) |
| `brent` | FRED `DCOILBRENTEU` graph CSV (keyless) | 9 days | log | EIA-sourced, published ~1 week late (latest was Nov 3 on Nov 11). `.` = missing. First run 800 days, then 60 |
| `usd_broad` | FRED `DTWEXBGS` graph CSV (Fed H.10 broad dollar index) | 10 days | log | weekly release (Mon 16:15 ET) with data to the previous Friday. Feeds `macro` for SGD→USD only (`pairs: ["USD"]`). First run 800 days, then 60 |

`MACRO_FACTORS` (`lib/config.ts`) holds the lags. `factorsAt` restricts each series to `date ≤ anchor −
lagDays` for **both** replay and live, so the backtest sees exactly what a live run would have seen, even
though FRED sometimes catches up sooner.

**Why lagged moves.** The Wise point dated d is a UTC-midnight snapshot, so it already contains the previous US
close. A factor's same-day move is already in the rate at the anchor; only slow pass-through (e.g. oil →
Sri Lanka's import bill → LKR over days) can still help. So the feature for the return on day d is the
factor's move over `MACRO_WINDOW_DAYS = 5` days ending at `d − 1 − lagDays`.

**Model.** Over the last 250 days (≥ 120 complete rows), features are scaled by their RMS and fitted by ridge
regression with **no intercept** (drift belongs to other models) and λ = n (roughly halves an uncorrelated
OLS β). Forecast: sum the per-day predicted returns. Future factor moves are unknown and count as zero (the
window is clamped to the last known date), so the signal fades within about a week of the horizon. With no
factor data it returns the random walk.

## Policy events (`lib/sources/events.ts`, `lib/predict/events.ts`)

Everything is fetched automatically: there is no hand-maintained date file.

```
Fed fomccalendars.htm ─┐                                             ┌─▶ learnEventVol(rates ≤ t, events, t)
Fed calendar.json ─────┤                                             │      ratio per kind (EventVolStat)
CBSL MPR list page ────┼─▶ fetchAllEvents ─▶ ingestEvents ─▶ events ─┤
CBSL latest MPR PDF ───┤   (SourceResult[])   (runSync 1b)  source_  └─▶ eventExtraVar(known events, t, target)
CBSL rss.xml ──────────┤                                    health          ─▶ engine.ts ensemble band only
BLS schedule pages ────┘
                                                              │
                              lib/dashboard.ts: .events {upcoming, recent, health}, MonthDay.events
                              UI: "Policy events" card, dotted chart markers + tooltip row
```

**Sources and parsers**

| source key | what | parser | `known_since` |
|---|---|---|---|
| `fed-page` | FOMC page: "YYYY FOMC Meetings" sections, history from 2021 and next year's schedule | `parseFomcPage`: month token (`June`, `Apr/May`) + days token (`16-17*`); decision = last day; skips notation votes/cancelled | event − 300 days (schedule is published > 1 year ahead); unscheduled meetings = the day after |
| `fed-json` | Fed calendar JSON, `type: "FOMC"`, title `FOMC Meeting` (2017 → this year) | `parseFomcJson` (a wrapped day range like `30-1` moves to the next month); only meetings `fed-page` doesn't list are kept, and the note says how many it parsed | same as above |
| `cbsl-mpr` | CBSL Monetary Policy Review list: date from each PDF name `press_YYYYMMDD_Monetary_Policy_Review_…pdf` | `parseCbslList` | previous review's date if it is at most 120 days earlier (each statement names the next), else event − 56 days for a Jan–Apr review (yearly schedule), else the event date |
| `cbsl-mpr` (next) | the latest review PDF: "The release of the next regular statement … will be on 20 November 2026" | `pdfText` (built-in `node:zlib`, no dependency) + `parseCbslNextDate` on whitespace-free text | the latest review's date |
| `cbsl-rss` | CBSL press releases whose titles mention the IMF / EFF / staff-level agreement | `parseCbslRss`, dated in Asia/Colombo | the day after the event (after the fact only) |
| `bls` | BLS release schedule `bls.gov/schedule/YYYY/home.htm`, years y−2 … y+1: "Consumer Price Index" → `us_cpi`, "Employment Situation" → `us_jobs` (exact names) | `parseBlsSchedule` (`date-cell` + `desc-cell` rows) | Dec 1 of the previous year if the day is in the usual range (CPI 10–15, jobs 1–10), else date − 7 (rescheduled release) |

Rows are de-duplicated on `(kind, event_date)` and upserted with `known_since = LEAST(old, new)`. `kind` values
(`fomc`, `cbsl_policy`, `imf`, `us_cpi`, `us_jobs`) are data, like model names: never rename them.

`EVENT_KINDS[kind].widens`: only `fomc`, `cbsl_policy` and `imf` widen the band. `us_cpi` / `us_jobs` are
display-only (their ratio is still learned and shown): the 14 Nov 2026 backtest found their windows already
covered (SGD→USD 80–88%), and widening pushed them to 87–100%. Only `OUTCOME_KINDS` (`fomc`, `cbsl_policy`, `imf`)
get an outcome.

**Band math** (pure, used identically by replay and the live forecast)

- Timing: Wise daily points are UTC-midnight snapshots, so an announcement on day E (FOMC ≈ 19:00 UTC, CBSL ≈
  02:00 UTC) shows up by the E+1 point. The measured move is the 2-day log move `ln(rate(E+1)/rate(E−1))`,
  which is robust to which side of midnight it lands on.
- `learnEventVol(rates, events, asOf)`: over the last 730 days, `base2` = mean squared 2-day move around every
  ordinary **weekday** (Wise repeats Friday's value at weekends) that is not within ±2 days of a band-widening
  event (needs ≥ 60 samples), so display-only kinds leave the band exactly as it is without them. For each kind, with n events whose window closed by `asOf` (E+1 ≤ asOf):
  `ratio = (Σ move² + 6·base2) / (n + 6) / base2`, floored at 1, and forced to 1 when n < 4.
- `eventExtraVar(events, stats, anchor, target)`: for each event of a widening kind known at the anchor (`known_since ≤ anchor`)
  with `anchor ≤ E` and `E+1 ≤ target`, add `(ratio − 1) · base2` once (half of it if E = anchor: the E−1 → E
  part of the move is already in the anchor rate). The engine sets
  `σ' = √(σ² + extra)`. Each event is counted once per forecast row however long the horizon is.
- Result: horizons after an event get a wider band; horizons before it, and the point forecast, are unchanged.
- The ratios are saved in `model_stats.stats.events` for transparency and shown on the card as
  `≈ √ratio × a normal day`.

**No look-ahead.** Replay day t only sees events with `known_since ≤ t`, and ratios only use events whose
move had already happened (E+1 ≤ t) and rates ≤ t. `known_since` is approximate for FOMC (assumed 300 days)
and for the first CBSL review of a year (set to the previous November review, although the yearly schedule
is published a little later).

**Failure model.** Each source succeeds or fails independently (`Promise.allSettled` / try-catch per
source). `source_health` keeps `last_ok_at`, `last_error_at`, `last_error`, `last_note`, `last_count`.
Parsing zero rows counts as an error ("page layout changed?"). The dashboard marks a source not OK if its
last attempt failed or it hasn't succeeded for 3 days, and the card shows a red line ("not read since …,
its events may be missing"). Notes that are not failures, such as CBSL's year-end statement not naming the
next date, are shown in grey. Nothing ever blocks the sync or the forecast: a missing event just means no
widening.

## Decision outcomes and post-announcement drift

**Outcomes** (`events.outcome`, added with `ALTER TABLE … ADD COLUMN IF NOT EXISTS`). Each past event's own
statement says what was decided; `fetchOutcomes` in `lib/sources/events.ts` reads it after the event:

| kind | statement | classifier | outcomes |
|---|---|---|---|
| `fomc` | `federalreserve.gov/newsevents/pressreleases/monetaryYYYYMMDDa.htm` | `classifyFomc`: "decided to lower / maintain / raise … target range" | `cut` / `hold` / `hike` |
| `cbsl_policy` | the review's own PDF (file name must carry `press_YYYYMMDD_` of the event, never the previous statement that only announced the date) | `classifyCbsl` on the headline before "The Monetary Policy Board": tightening words first (`increases` contains `eases`), then easing, then hold | `cut` / `hold` / `hike` |
| `imf` | the CBSL RSS title, at parse time | `classifyImf` | `sla` / `board` / `other` |

Unparsable statements are stored as `unclear` so they aren't fetched every day. The upsert keeps an existing
outcome (`COALESCE(events.outcome, EXCLUDED.outcome)`).

**Drift** (`lib/predict/news.ts`, pure). Category = `kind:outcome`, e.g. `fomc:cut`.

- Timing: the outcome is treated as public from **E+1**. CBSL releases at ≈07:30 Sri Lanka time, which is after
  the 09:30 SGT sync on day E, and the FOMC decides in the US afternoon. The jump into the E+1 point is
  already inside the anchor rate by then, so it is not forecast. Only the follow-on drift is.
- `learnNewsDrift(rates, events, asOf)`: for events in the last 730 days whose window closed
  (E+1+5 ≤ asOf), `drift_c = Σ ln(rate(E+6)/rate(E+1)) / (n + 8)`: the mean shrunk toward 0 by 8
  pseudo-events. Stored as `LearnedStats.news` (`model_stats.stats.news`).
- `newsDriftBetween(events, stats, anchor, target)`: for each event with `E+1 ≤ anchor < E+6` and a category
  with n ≥ 3, add `drift_c / 5` per day of (anchor, min(target, E+6)].
- The `news` model = `naive + newsDriftBetween`. It equals `naive` on every day with no open window
  (≈ 89% of forecasts). It is a shadow model, so it only enters the blend once it beats the random walk under
  the promotion rule above.

## Version backtest and learning log

- `forecastDay` (`lib/predict/replay.ts`) is the single learn → forecast step for one anchor day. The sync's
  replay of missed days, its live forecast and the backtest all call it.
- Sync step 4b, once per `MODEL_VERSION` (only when the replay is complete): `runBacktest` replays the last
  365 days in memory from an empty error index, for all pairs in `PREDICT_ORDER` (SGD→LKR's `cross` gets the
  legs' in-memory paths), and scores final vs `naive` on targets in the last 300 days, Sundays excluded. About
  30 s locally. Stored in `model_versions` with `compareVersions` against the previous backtested version (skill
  = MAE ÷ random walk on its own window, ±0.5% = same). Deadline: 50 s from sync start for page-triggered syncs,
  240 s for the cron (`maxDuration` 300). If time runs out nothing is stored and the next run retries.
- After the live forecast, `learningChanges` compares today's `LearnedStats` with the previous stored day's and
  appends promotions/demotions (per bucket, model or `bias_correction`, with the paired t) to `learning_log`.
- Dashboard: `.versions` (last 10) and `.learningLog` (last 30) feed the "Model versions and learning log" card.
- Stored so far: `2026.11.13` (skill USD 1.0000 / USDLKR 1.0009 / LKR 0.9930) and `2026.11.14` (broad dollar
  index, `arima`, recency-weighted band, display-only CPI/jobs: 1.0000 / 1.0000 / 0.9934, "same" for all three).
  `2026.11.14.2` (Student-t gate, finite guards, trend-side band for LKR pairs, anchor-day event half,
  faster weekday release): 1.0000 / 1.0000 / 1.0000; coverage 81.5% / 75.2% / 83.0%. LKR is "worse" than
  `2026.11.14`: the stricter gate dropped noise promotions at 15–31 days (see docs/CONTEXT.md).
  `learning_log` is still empty: nothing has been promoted or demoted in a live run yet.

## Live quote (`lib/sources/wise.ts`)

`parseWiseComparison` (pure) reads Wise's comparison API. The mid rate is always **Wise's own quote**; another
provider flagged `isConsideredMidMarketRate` (Remitly is, for USD→LKR) is only a fallback if Wise is missing.
Before 2026-11-14 the first flagged provider in the list won, which could show Remitly's rate as "Wise".

## Read path (`lib/dashboard.ts`)

- The month table/chart, per day: official or live actual; the latest `ensemble` forecast made before that
  day (`DISTINCT ON target_date ORDER BY made_on DESC`); the rate on the same day last month.
- The accuracy panel: `ensemble` vs `naive` MAE per bucket over the last 60 days, plus % of forecasts
  within 0.25%. Target dates on non-trading weekdays (`stats.nonTradingDow`, default Sunday) are left out.
- Performance card (`lib/performance.ts`, pure): one query of scored `ensemble` + `naive` forecasts at
  horizons 1/7/14/30 for the last 120 days (joined to the prediction for its 80% band and `origin`).
  Non-trading weekdays are dropped. It gives MAPE/RMSE/MAE vs the random walk on the same dates over
  7/30/90 days (next-day), per-horizon error + 80% coverage over 90 days, a bias t-test (|t| > 2, n ≥ 10) on
  signed next-day errors over 90 days, and a trend verdict: |error| − |random-walk error| for the last 30 days vs the prior 30
  (Welch t, |t| > 2). The outlook only names a direction when today's rate is outside the 30-day forecast's
  80% range. `.hardest` = pair with the highest 30-day next-day MAPE (n ≥ 10).
- Data sources card: `.freshness` (first/latest date per series vs a max age from `SERIES_CATALOG`),
  `source_health`, and the static `NOT_INTEGRATED` list.
- The live quote is fetched per request through `"use cache"` (revalidate 5 min). It falls back to the
  latest `live_quotes` row.
- Policy events: one query for events with `known_since ≤ today` within −45/+75 days (`.events.upcoming`,
  `.events.recent`, plus short labels on each `MonthDay.events`) and one for `source_health`
  (`.events.health`). Shared across currencies; the per-currency effect comes from `stats.events`.
- Macro factors: `.macro[]` = latest value, date and 30-day change (pp for yields and rates, % for prices) of
  each `MACRO_FACTORS` and `SRI_LANKA_META` series (remittances and tourism: change vs a year earlier), shown
  in the Market context card (Sri Lanka series only on LKR pairs). The weights table shows "not used" for
  any model not promoted in that bucket (`stats.buckets[].promoted[m] === false`).
- Outcomes: `EventView.outcome` is shown as a badge (cut / hold / hike / staff deal / approved) in the
  card's Recent list. Source health is split by card (`MACRO_SOURCES` in `DashboardView.tsx`): `treasury`,
  `fred-brent`, `fred-usd-broad`, `cbsl-fx`, `cbsl-rates`, `cbsl-external`, `cbsl-prices` and `wise-history:*`
  show in Market context, everything else (Fed, CBSL review list and RSS, `bls`, `outcomes`, `wise-live:*`,
  `cross-rate`) in Policy events. The Data sources card lists all of them.
- Without `DATABASE_URL`, the page still renders today's live rates and shows a setup notice.

## Endpoints

| route | purpose | auth |
|---|---|---|
| `/` | dashboard (PPR shell + streamed data; `maxDuration` 60) | none |
| `/api/dashboard` | JSON of the same data, CDN-cached 2 min | none |
| `/api/cron/sync` | run a sync (`maxDuration` 300, backtest deadline 240 s) | `Authorization: Bearer $CRON_SECRET`. Fails closed: on a deployment without `CRON_SECRET` it returns 500; only local `next dev` runs without a secret |

# RateCast architecture

## Overview

```
                    ┌──────────────── daily 01:30 UTC (Vercel Cron) ─────────────────┐
                    │        or first page view of the day via after() (self-heal)   │
                    ▼                                                                │
 Wise rates/history ─┐                                                               │
 Wise comparisons ───┤   ┌────────────┐   ┌──────────┐   ┌────────┐   ┌──────────┐   │
 Frankfurter (ECB) ──┼──▶│ 1. ingest  │──▶│2. evaluate│──▶│3. learn│──▶│4. forecast│   │
 ExchangeRate-API ───┤   └────────────┘   └──────────┘   └────────┘   └──────────┘   │
 Currency-API ───────┤         │               │              │             │         │
 Fed FOMC page/JSON ─┤         ▼               ▼              ▼             ▼         │
 CBSL review list/PDF┤  rates_history   prediction_errors  model_stats   predictions ─┘
 CBSL RSS ───────────┤  live_quotes     (the delta table)  (+ event ratios)  (band widened
 US Treasury CSV ────┤  market_data                                           around events)
 FRED Brent CSV ─────┤  (+ ust2y, brent,
 CBSL rates / xlsx ──┘   lk_* Sri Lanka series)
                        events, source_health
                               │
                               ▼
              app/page.tsx ◀── lib/dashboard.ts (read-only queries + 5-min cached live quote)
```

## Sync run (`lib/sync.ts → runSync`)

1. **Lock.** One row in `sync_lock`. A concurrent run returns `skipped`, and the lock expires after 5 min.
2. **Market data.** Frankfurter `USD → EUR, JPY, GBP, CNY` time series → `usd_basket` = mean of the logs
   (rises when the USD strengthens). Cross-check "today" rates from ExchangeRate-API and Currency-API →
   `xc:<CUR>:<source>`.
   Then **macro factors** (`ingestMacro`, step "1a"; see [Macro factors](#macro-factors-libsourcesmacrots)):
   the US Treasury 2-year yield and FRED Brent go to `market_data` as `ust2y` and `brent`, each with its own
   `source_health` row (`treasury`, `fred-brent`). Failures are logged and never fail the sync.
   Then **policy events** (`ingestEvents`, step "1b" in the code; see [Policy events](#policy-events)): fetch
   the Fed and CBSL calendars, upsert `events`, and record each scraper's outcome in `source_health`. A
   failing source is logged and never fails the sync.
   Then **decision outcomes** (`classifyOutcomes`; see [Decision outcomes](#decision-outcomes-and-post-announcement-drift)):
   past events (within 800 days) with no `outcome` get their own statement read and classified, at most 32
   fetches per run, newest first. Health row `outcomes`.
3. **Ingest each currency.**
   - Wise history: 2 years on first run (< 300 rows), otherwise 3 months. Upserted as `source='wise'`.
   - Wise comparison: the mid-market rate plus up to 3 providers' quotes for 1,000 SGD → `live_quotes`, and
     today's provisional `rates_history` row (`wise_live`), which never overwrites a `wise` row.
4. **Evaluate.** A single INSERT…SELECT joins `predictions` to official `rates_history` rows and writes every
   not-yet-scored prediction to `prediction_errors` with `delta = actual − predicted`,
   `pct_error = (predicted − actual)/actual × 100` and `log_error = ln(predicted/actual)`.
   Then **Sri Lanka series** (`SRI_LANKA_SERIES` in `lib/sources/srilanka.ts`): CBSL's daily indicative USD/LKR
   (`lk_usd_spot`) and SGD/LKR (`lk_sgd_ind`) via its rate-lookup form, and monthly policy rate (`lk_opr`),
   3-month T-bill (`lk_tbill3m`), workers' remittances (`lk_remit`) and tourism earnings (`lk_tourism`) from
   CBSL's statistical .xlsx tables (read by the dependency-free `srilanka-xlsx.ts`). Health rows `cbsl-fx`,
   `cbsl-rates`, `cbsl-external`.
5. **Replay missed days.** Pairs run in `PREDICT_ORDER` (SGD→USD, USD→LKR, then SGD→LKR, whose `cross` model
   reads the legs' `ensemble` rows for the same anchor). For each day `t` in the last 365 days
   (`BACKFILL_DAYS`) with no `ensemble` forecast (all of them on first run, or gaps if the cron missed a day),
   within `REPLAY_BUDGET_MS` (40 s; the rest continues next run): learn from errors with target ≤ t, forecast from rates ≤ t,
   insert, and push the realised errors into memory so day t+1 learns from them. This is a backtest.
6. **Forecast today.** The anchor is today's live Wise rate (or yesterday's official rate if Wise failed).
   Horizons 1..31. Rows for the same `made_on` are upserted, so re-running on the same day just refreshes them.
7. **Snapshot.** The `LearnedStats` JSON goes to `model_stats`, then old predictions and quotes are pruned.

## Models (`lib/predict/models.ts`, all on log rates)

| key | idea |
|---|---|
| `naive` | random walk: every horizon = today |
| `drift` | mean daily log change over 30 days, damped by 0.97^k |
| `holt` | damped Holt linear trend; α, β, φ grid-searched on one-step SSE over 120 days |
| `monthly_pattern` | path from the same day-of-month 1/2/3 months ago (weights 0.5/0.3/0.2), × 0.6 |
| `mean_reversion` | pull to the 30-day mean at 4%/day |
| `market` | β of the pair's daily returns on the ECB USD basket (90 days) × 10-day basket momentum, damped 0.9^k |
| `macro` | **shadow model.** Ridge regression of daily returns on the lagged 5-day moves of the US 2y yield and Brent (see below) |
| `news` | **shadow model.** `naive` plus the learned post-announcement drift for a few days after a classified Fed/CBSL decision (see below) |
| `lanka` | **shadow model, LKR pairs.** Same ridge factor model on `LANKA_FACTORS`: gap to CBSL's fixing, CBSL's 5-day USD/LKR move, policy rate and T-bill changes, YoY remittances and tourism, each with its own lag |
| `cross` | **shadow model, SGD→LKR.** Today's rate moved by the summed log forecasts of the legs (SGD→USD `ensemble` + USD→LKR `ensemble`) |
| `cbsl_gap` | **shadow model, LKR pairs.** Per-horizon no-intercept regression (365 days, shrunk toward 0) of the Wise move over h days on yesterday's gap ln(CBSL fixing / Wise). Wise drifts toward CBSL's own rate |

## Learning (`lib/predict/learning.ts`)

For each horizon bucket b ∈ {1, 3, 7, 14, 31}, over evaluated errors with target date in (t − 180, t], skipping
detected non-trading weekdays (`calendar.ts`; Sunday's Wise point repeats Saturday's):

- `MAE_m` = mean |log error| of model m. Shrunk: `(n·MAE_m + 10·MAE_pooled)/(n + 10)`.
- `w_m ∝ 1 / MAE_shrunk^4`, normalised. With no data, weights are equal.
- `blend = Σ w_m · f_m` (log space).
- `bias` = exponentially recency-weighted (half-life 14 days) mean log error of `blend`, × n/(n + 15).
- `blend_bc = blend − bias` is always stored, so its accuracy can be measured.
- `ensemble = blend − bias · biasOn`, where `biasOn = 1` iff b ≤ 7 and `blend_bc` beats `blend` by the paired test below.
- **Every model except `naive` is gated** (`SHADOW_MODELS` only labels the external-data ones in the UI). A model
  gets `w = 0` in a bucket until **promoted**: scored on ≥ 30 *distinct* target dates in the window and a paired
  t-test on per-date mean |error| vs `naive` gives t < −2.6, with n_eff = dates / bucket mean horizon (neighbouring
  forecasts overlap). 2.6 ≈ Bonferroni for ~10 candidates per bucket at 5% family-wise. Unpromoted shadow models are also left out of `MAE_pooled`, so they can't
  shift the other weights. The flag is stored per bucket in `BucketStats.promoted` and is re-evaluated every
  day, so a model can be promoted and demoted automatically. Distinct dates, not raw counts: long-horizon
  forecasts overlap heavily (17 horizons hit the same few target dates), and a first rule of "≥ 60 forecasts"
  promoted `macro` on thin evidence and hurt LKR 8–31 days.
- 80% band: half-width `q80 · √(h / meanH_b)`, where q80 = empirical 80th percentile of the bucket's |ensemble log
  error| normalised to the bucket's mean horizon (n ≥ 30); fallback 1.2816 × (RMS or daily vol × √h). Event
  variance is added in quadrature (see below). Across a non-trading day the forecast and band are frozen. The point forecast never includes events.

## Macro factors (`lib/sources/macro.ts`)

```
US Treasury daily par yield CSV (per year, "2 Yr" column) ─┐                    factorsAt(all, t):
FRED fredgraph.csv?id=DCOILBRENTEU ────────────────────────┼─▶ ingestMacro ─▶ market_data ─▶ each series ≤ t − lagDays
                                                           │   (runSync 1a)   ust2y, brent        │
                                     source_health: treasury, fred-brent                          ▼
                                                                      macro model (ModelContext.factors)
                                                                      lib/dashboard.ts `.macro` → Market context card
```

| series | source | lag | transform | quirks |
|---|---|---|---|---|
| `ust2y` | home.treasury.gov CSV, one file per year; the `2 Yr` column is found by header name (columns differ by year) | 1 day | diff (pp) | slow and erratic (0.6–19 s per CSV), so years are fetched one at a time with a 40 s timeout. First run fetches 3 years (≈ 1 min), then only the current year (plus last year in January) |
| `brent` | FRED `DCOILBRENTEU` graph CSV (keyless) | 9 days | log | EIA-sourced, published ~1 week late (latest was Nov 3 on Nov 11). `.` = missing. First run 800 days, then 60 |

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
CBSL rss.xml ──────────┘                                    health          ─▶ engine.ts ensemble band only
                                                              │
                              lib/dashboard.ts: .events {upcoming, recent, health}, MonthDay.events
                              UI: "Policy events" card, dotted chart markers + tooltip row
```

**Sources and parsers**

| source key | what | parser | `known_since` |
|---|---|---|---|
| `fed-page` | FOMC page: "YYYY FOMC Meetings" sections, history from 2021 and next year's schedule | `parseFomcPage`: month token (`June`, `Apr/May`) + days token (`16-17*`); decision = last day; skips notation votes/cancelled | event − 300 days (schedule is published > 1 year ahead); unscheduled meetings = event date |
| `fed-json` | Fed calendar JSON, `type: "FOMC"`, title `FOMC Meeting` (2017 → this year) | `parseFomcJson` | same as above |
| `cbsl-mpr` | CBSL Monetary Policy Review list: date from each PDF name `press_YYYYMMDD_Monetary_Policy_Review_…pdf` | `parseCbslList` | previous review's date (each statement names the next), else event − 56 days |
| `cbsl-mpr` (next) | the latest review PDF: "The release of the next regular statement … will be on 20 November 2026" | `pdfText` (built-in `node:zlib`, no dependency) + `parseCbslNextDate` on whitespace-free text | the latest review's date |
| `cbsl-rss` | CBSL press releases whose titles mention the IMF / EFF / staff-level agreement | `parseCbslRss`, dated in Asia/Colombo | event date (after the fact only) |

Rows are de-duplicated on `(kind, event_date)` and upserted with `known_since = LEAST(old, new)`. `kind` values
(`fomc`, `cbsl_policy`, `imf`) are data, like model names: never rename them.

**Band math** (pure, used identically by replay and the live forecast)

- Timing: Wise daily points are UTC-midnight snapshots, so an announcement on day E (FOMC ≈ 19:00 UTC, CBSL ≈
  02:00 UTC) shows up by the E+1 point. The measured move is the 2-day log move `ln(rate(E+1)/rate(E−1))`,
  which is robust to which side of midnight it lands on.
- `learnEventVol(rates, events, asOf)`: over the last 730 days, `base2` = mean squared 2-day move around every
  ordinary **weekday** (Wise repeats Friday's value at weekends) that is not within ±2 days of an event
  (needs ≥ 60 samples). For each kind, with n events whose window closed by `asOf` (E+1 ≤ asOf):
  `ratio = (Σ move² + 6·base2) / (n + 6) / base2`, floored at 1, and forced to 1 when n < 4.
- `eventExtraVar(events, stats, anchor, target)`: for each event known at the anchor (`known_since ≤ anchor`)
  with `anchor ≤ E` and `E+1 ≤ target`, add `(ratio − 1) · base2` once. The engine sets
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

## Read path (`lib/dashboard.ts`)

- The month table/chart, per day: official or live actual; the latest `ensemble` forecast made before that
  day (`DISTINCT ON target_date ORDER BY made_on DESC`); the rate on the same day last month.
- The accuracy panel: `ensemble` vs `naive` MAE per bucket over the last 60 days, plus % of forecasts
  within 0.25%.
- The live quote is fetched per request through `"use cache"` (revalidate 5 min). It falls back to the
  latest `live_quotes` row.
- Policy events: one query for events with `known_since ≤ today` within −45/+75 days (`.events.upcoming`,
  `.events.recent`, plus short labels on each `MonthDay.events`) and one for `source_health`
  (`.events.health`). Shared across currencies; the per-currency effect comes from `stats.events`.
- Macro factors: `.macro[]` = latest value, date and 30-day change (pp for yields, % for prices) of each
  `MACRO_FACTORS` series, shown in the Market context card. The weights table shows `shadow` for an
  unpromoted shadow model (`stats.buckets[].promoted`).
- Outcomes: `EventView.outcome` is shown as a badge (cut / hold / hike / staff deal / approved) in the
  card's Recent list. Source health is split by card: `treasury` and `fred-brent` show in Market context,
  everything else (Fed, CBSL, `outcomes`) in Policy events.
- Without `DATABASE_URL`, the page still renders today's live rates and shows a setup notice.

## Endpoints

| route | purpose | auth |
|---|---|---|
| `/` | dashboard (PPR shell + streamed data) | none |
| `/api/dashboard` | JSON of the same data, CDN-cached 2 min | none |
| `/api/cron/sync` | run a sync | `Authorization: Bearer $CRON_SECRET` (if set) |

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
 Currency-API ───────┘         │               │              │             │         │
                               ▼               ▼              ▼             ▼         │
                        rates_history   prediction_errors  model_stats   predictions ─┘
                        live_quotes     (the delta table)
                        market_data
                               │
                               ▼
              app/page.tsx ◀── lib/dashboard.ts (read-only queries + 5-min cached live quote)
```

## Sync run (`lib/sync.ts → runSync`)

1. **Lock.** One row in `sync_lock`. A concurrent run returns `skipped`, and the lock expires after 5 min.
2. **Market data.** Frankfurter `USD → EUR, JPY, GBP, CNY` time series → `usd_basket` = mean of the logs
   (rises when the USD strengthens). Cross-check "today" rates from ExchangeRate-API and Currency-API →
   `xc:<CUR>:<source>`.
3. **Ingest each currency.**
   - Wise history: 2 years on first run (< 300 rows), otherwise 3 months. Upserted as `source='wise'`.
   - Wise comparison: the mid-market rate plus up to 3 providers' quotes for 1,000 SGD → `live_quotes`, and
     today's provisional `rates_history` row (`wise_live`), which never overwrites a `wise` row.
4. **Evaluate.** A single INSERT…SELECT joins `predictions` to official `rates_history` rows and writes every
   not-yet-scored prediction to `prediction_errors` with `delta = actual − predicted`,
   `pct_error = (predicted − actual)/actual × 100` and `log_error = ln(predicted/actual)`.
5. **Replay missed days.** For each day `t` in the last 90 days with no `ensemble` forecast (all 90 on first
   run, or gaps if the cron missed a day): learn from errors with target ≤ t, forecast from rates ≤ t,
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

## Learning (`lib/predict/learning.ts`)

For each horizon bucket b ∈ {1, 3, 7, 14, 31}, over evaluated errors with target date in (t − 60, t]:

- `MAE_m` = mean |log error| of model m. Shrunk: `(n·MAE_m + 10·MAE_pooled)/(n + 10)`.
- `w_m ∝ 1 / MAE_shrunk^4`, normalised. With no data, weights are equal.
- `blend = Σ w_m · f_m` (log space).
- `bias` = exponentially recency-weighted (half-life 14 days) mean log error of `blend`, × n/(n + 15).
- `blend_bc = blend − bias` is always stored, so its accuracy can be measured.
- `ensemble = blend − bias · biasOn`, where `biasOn = 1` iff b ≤ 7 and n ≥ 20 and MAE(blend_bc) < MAE(blend).
- 80% band: `ensemble · exp(±1.2816 σ)`, σ = RMS of ensemble log errors (n ≥ 10), else daily vol × √h.

## Read path (`lib/dashboard.ts`)

- The month table/chart, per day: official or live actual; the latest `ensemble` forecast made before that
  day (`DISTINCT ON target_date ORDER BY made_on DESC`); the rate on the same day last month.
- The accuracy panel: `ensemble` vs `naive` MAE per bucket over the last 60 days, plus % of forecasts
  within 0.25%.
- The live quote is fetched per request through `"use cache"` (revalidate 5 min). It falls back to the
  latest `live_quotes` row.
- Without `DATABASE_URL`, the page still renders today's live rates and shows a setup notice.

## Endpoints

| route | purpose | auth |
|---|---|---|
| `/` | dashboard (PPR shell + streamed data) | none |
| `/api/dashboard` | JSON of the same data, CDN-cached 2 min | none |
| `/api/cron/sync` | run a sync | `Authorization: Bearer $CRON_SECRET` (if set) |

---
name: backtest
description: Re-run RateCast's 90-day no-lookahead replay against the local database and compare every model, the blend and the final ensemble to the random-walk baseline by horizon. Use after any change to lib/predict or the learning/sync logic, or when asked how accurate the predictor is.
---

# Backtest the forecasting models

Uses the local DB only (`ratecast-pg`). **Never run the reset against production.**

1. Make sure the DB is up and `.env.local` points to localhost (`grep localhost .env.local`). Stop if it doesn't.
2. Reset learned state (rates history is kept):
   ```bash
   docker exec ratecast-pg psql -U postgres -d rates -qc "TRUNCATE predictions, prediction_errors, model_stats, sync_runs CASCADE;"
   npm run sync
   ```
   The log must show `replayed 90 past days` for LKR and USD.
3. Score the last ~60 days. The first ~30 replayed days are warm-up with equal weights, so start
   `made_on` at today − 60:
   ```bash
   docker exec ratecast-pg psql -U postgres -d rates -c "
   SELECT currency, model,
          CASE WHEN horizon=1 THEN '1' WHEN horizon<=7 THEN '2-7' WHEN horizon<=14 THEN '8-14' ELSE '15-31' END AS hb,
          count(*) n, round(avg(abs(pct_error))::numeric,3) AS mae_pct, round(avg(pct_error)::numeric,3) AS bias_pct
   FROM prediction_errors
   WHERE made_on >= current_date - 60
   GROUP BY 1,2,3 ORDER BY 1,3,5;"
   ```
4. Report per currency and bucket: `ensemble` vs `naive` vs the best single model.
   - **Accept** a change only if `ensemble` is no worse than before in every bucket for both currencies.
   - `ensemble` should be ≤ `blend`. If it isn't, the bias gate is misbehaving.
5. Put the new numbers in the "Backtest results" table in `docs/CONTEXT.md`, with the date.

Baseline (2026-11-09), ensemble / naive MAE %: LKR 1d 0.126/0.126 · 15–31d 0.396/0.399; USD 1d 0.095/0.093 ·
15–31d 0.380/0.315.

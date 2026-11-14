---
name: backtest
description: Re-run RateCast's 365-day no-lookahead replay against the local database and compare every model, the blend and the final ensemble to the random-walk baseline by horizon. Use after any change to lib/predict or the learning/sync logic, or when asked how accurate the predictor is.
---

# Backtest the forecasting models

Uses the local DB only (`ratecast-pg`). **Never run the reset against production.**

**Quick check first:** `npm run backtest` (sandbox: `node --import tsx --env-file=.env.local scripts/backtest.ts`)
replays the current code in memory (365 days, last 300 scored, Sundays excluded, three pairs) and prints
ensemble vs random-walk MAE, skill and 80% coverage per bucket. Nothing is written. It is the same backtest the
sync stores once per `MODEL_VERSION` in `model_versions`. Use the full reset below only when you need
per-model rows in `prediction_errors`.

1. Make sure the DB is up and `.env.local` points to localhost (`grep localhost .env.local`). Stop if it doesn't.
2. Reset learned state (rates history is kept):
   ```bash
   docker exec ratecast-pg psql -U postgres -d rates -qc "TRUNCATE predictions, prediction_errors, model_stats, sync_runs CASCADE;"
   npm run sync
   ```
   The replay is 365 days and time-boxed to 40 s per run, so for a backtest run
   `REPLAY_BUDGET_MS=100000000 npm run sync` (~1 min on an empty DB; in the Claude Code sandbox:
   `REPLAY_BUDGET_MS=100000000 node --import tsx --env-file=.env.local scripts/sync.ts`). The log must show
   `replayed 365 past days` for all three pairs (`USD`, `USDLKR`, `LKR`).
3. Score the last ~300 days (the first ~60 replayed days are warm-up, and no model can be promoted before
   ≥ 30 distinct target dates). Exclude non-trading days (Sundays: Wise repeats Saturday):
   add `AND extract(dow FROM target_date) <> 0` and use `made_on >= current_date - 300` in the queries below
   (the older sections still say 60).
   ```bash
   docker exec ratecast-pg psql -U postgres -d rates -c "
   SELECT currency, model,
          CASE WHEN horizon=1 THEN '1' WHEN horizon<=7 THEN '2-7' WHEN horizon<=14 THEN '8-14' ELSE '15-31' END AS hb,
          count(*) n, round(avg(abs(pct_error))::numeric,3) AS mae_pct, round(avg(pct_error)::numeric,3) AS bias_pct
   FROM prediction_errors
   WHERE made_on >= current_date - 300 AND extract(dow FROM target_date) <> 0
   GROUP BY 1,2,3 ORDER BY 1,3,5;"
   ```
4. Report per currency and bucket: `ensemble` vs `naive` vs the best single model.
   - **Accept** a change only if `ensemble` is no worse than before in every bucket for all three pairs.
   - `ensemble` should be ≤ `blend`. If it isn't, the bias gate is misbehaving.
5. Put the new numbers in the "Backtest results" table in `docs/CONTEXT.md`, with the date.

## Event windows (band-only changes: `lib/predict/events.ts`, event sources)
Events never move the point forecast, so MAE must be identical. Compare 80% coverage and width before vs after,
split by whether a known event's move (E+1) falls inside the forecast window.
1. Snapshot the **old** code's run: `git stash -u`, reset and sync as in step 2, then
   ```bash
   docker exec ratecast-pg psql -U postgres -d rates -qc "DROP TABLE IF EXISTS bt_base; CREATE TABLE bt_base AS
     SELECT e.currency, e.made_on, e.target_date, e.horizon, e.predicted, e.actual, e.pct_error, p.lower80, p.upper80
     FROM prediction_errors e JOIN predictions p ON p.id = e.prediction_id WHERE e.model = 'ensemble';"
   git stash pop
   ```
2. Reset and sync again with the **new** code, then:
   ```bash
   docker exec ratecast-pg psql -U postgres -d rates -c "
   WITH new AS (
     SELECT e.currency, e.made_on, e.target_date, e.horizon, e.pct_error, e.actual, p.lower80, p.upper80
     FROM prediction_errors e JOIN predictions p ON p.id = e.prediction_id WHERE e.model = 'ensemble'),
   j AS (
     SELECT n.*, b.pct_error AS b_err, b.lower80 AS b_lo, b.upper80 AS b_hi,
       EXISTS (SELECT 1 FROM events ev WHERE ev.known_since <= n.made_on AND ev.event_date >= n.made_on
               AND ev.event_date + 1 <= n.target_date AND ev.kind IN ('fomc','cbsl_policy')) AS ev
     FROM new n JOIN bt_base b USING (currency, made_on, target_date)
     WHERE n.made_on >= current_date - 60)
   SELECT currency, CASE WHEN horizon=1 THEN '1' WHEN horizon<=7 THEN '2-7' WHEN horizon<=14 THEN '8-14' ELSE '15-31' END hb, ev,
     count(*) n,
     round(avg(abs(b_err))::numeric,4) mae_old, round(avg(abs(pct_error))::numeric,4) mae_new,
     round(100*avg((actual BETWEEN b_lo AND b_hi)::int)::numeric,1) cov_old,
     round(100*avg((actual BETWEEN lower80 AND upper80)::int)::numeric,1) cov_new,
     round(avg((b_hi-b_lo)/actual*100)::numeric,3) width_old, round(avg((upper80-lower80)/actual*100)::numeric,3) width_new
   FROM j GROUP BY 1,2,3 ORDER BY 1, min(horizon), 3;"
   ```
3. Accept if `mae_old = mae_new` everywhere, and event rows (`ev = t`) move toward 80% coverage without
   widening non-event rows. Check the learned ratios too:
   `SELECT currency, stats->'events' FROM model_stats WHERE as_of = (SELECT max(as_of) FROM model_stats);`
4. Clean up: `docker exec ratecast-pg psql -U postgres -d rates -qc "DROP TABLE bt_base;"`

Event baseline (2026-11-11): MAE identical in all buckets. USD event-window coverage 1d 66.7→100% (n=3),
8–14d 85.6→87.2%, 15–31d 87.5→88.1%. LKR event windows were already ~97% covered, and widths grew (2–7d
1.17→1.39%). The 60-day window holds only 2–3 events per kind, so the test is inconclusive. Learned ratios
(2 years): LKR cbsl_policy 2.09, fomc 1.00; USD fomc 1.49, cbsl_policy 1.15.

## Shadow / new model (e.g. `macro`, `news`)
A new model must not make the ensemble worse. Measure it fairly against the same data:
1. **Snapshot without it.** Comment it out of `MODELS` in `lib/predict/models.ts` (`// macro, (BT-TEMP)`), reset
   and sync, then `CREATE TABLE bt_base AS SELECT currency, model, made_on, target_date, horizon, pct_error FROM prediction_errors;`
   Restore the line (`grep -c BT-TEMP lib/predict/models.ts` must print 0).
2. **Run with it** (reset and sync), then compare the ensemble and the model itself per bucket:
   ```bash
   docker exec ratecast-pg psql -U postgres -d rates -c "
   SELECT n.currency, CASE WHEN n.horizon=1 THEN '1' WHEN n.horizon<=7 THEN '2-7' WHEN n.horizon<=14 THEN '8-14' ELSE '15-31' END b,
     round(avg(abs(o.pct_error))::numeric,4) ens_old, round(avg(abs(n.pct_error))::numeric,4) ens_new,
     count(*) FILTER (WHERE abs(o.pct_error-n.pct_error)>1e-9) differ
   FROM prediction_errors n JOIN bt_base o USING (currency, model, made_on, target_date)
   WHERE n.model='ensemble' AND n.made_on >= current_date-60 GROUP BY 1,2 ORDER BY 1,2;"
   docker exec ratecast-pg psql -U postgres -d rates -c "
   SELECT currency, CASE WHEN horizon=1 THEN '1' WHEN horizon<=7 THEN '2-7' WHEN horizon<=14 THEN '8-14' ELSE '15-31' END b,
     round(avg(abs(pct_error)) FILTER (WHERE model='naive')::numeric,4) naive,
     round(avg(abs(pct_error)) FILTER (WHERE model='macro')::numeric,4) model
   FROM prediction_errors WHERE made_on >= current_date-60 GROUP BY 1,2 ORDER BY 1,2;"
   ```
3. **Promotion state today:** `SELECT currency, b->>'bucket', b->'promoted' FROM model_stats, jsonb_array_elements(stats->'buckets') b WHERE as_of=(SELECT max(as_of) FROM model_stats);`
   `model_stats` keeps only the live day, so promotions *during* replay show up only as `differ > 0`.
4. **Sanity check the shadow gate:** temporarily force `promoted[m] = false && …` in `learning.ts` and rerun.
   `differ` must be 0 in every bucket (a shadow model must not leak into the blend). Revert it afterwards.
5. Accept per the usual rule (ensemble no worse in every bucket). Never hand-promote or loosen the gate to pass.
   Drop `bt_base` when done.

Macro results (2026-11-11), MAE % over the last 60 days:
- `macro` alone was slightly worse than `naive` everywhere (e.g. LKR 1d 0.1273 vs 0.1240, USD 15–31d 0.2790 vs 0.2688).
- Fully weighted (~15%), it worsened the LKR ensemble: 15–31d 0.3982→0.4024, 8–14d 0.2698→0.2715.
- In shadow with promotion off, the ensemble was identical in all 8 buckets.
- With a row-count promotion rule (n ≥ 60, < naive), LKR 15–31d went to 0.4032, because it promoted on overlapping forecasts.
- Final rule (≥ 30 distinct dates, < 0.98 × naive): LKR 15–31d 0.3982→0.3977 and 8–14d 0.2698→0.2704 (14 forecasts),
  everything else identical. That technically breaks "no worse in every bucket" by 0.0006 pp. The owner accepted
  this on 2026-11-11 and kept auto-promotion on (see `docs/CONTEXT.md`). Don't re-raise it or tune the thresholds.

News results (2026-11-11, Phase 3), same method (`// news, (BT-TEMP)`):
- The ensemble was **identical in all 8 buckets**: `news` was never promoted during the replay.
- `news` vs `naive` MAE %: LKR 1d 0.1235/0.1240, 2–7d 0.2197/0.2203, 8–14d 0.2654/0.2672, 15–31d 0.4081/0.3970;
  USD 1d 0.0931/0.0911, 2–7d 0.1795/0.1770, 8–14d 0.2079/0.2135, 15–31d 0.2769/0.2688. It differed from naive on
  only 310 of 2,821 forecasts per currency.
- The learned drifts look like noise: categories have 1–11 events, and e.g. `cbsl_policy:hold` gives SGD→USD
  −0.21% over 5 days, which has no economic story. Shadow is the right place until evidence builds.
- Inspect them, and the outcomes behind them:
  ```bash
  docker exec ratecast-pg psql -U postgres -d rates \
    -c "SELECT currency, d->>'category' cat, (d->>'n')::int n, round((d->>'drift')::numeric*100,3) drift_pct
        FROM model_stats, jsonb_array_elements(stats->'news') d
        WHERE as_of=(SELECT max(as_of) FROM model_stats) ORDER BY 1,2;" \
    -c "SELECT kind, outcome, count(*) FROM events WHERE event_date < current_date GROUP BY 1,2 ORDER BY 1,2;"
  ```

Gating results (2026-11-12/13, 365-day replay, last 300 days, Sundays excluded), ensemble = naive MAE %:
- SGD→LKR 1d 0.2735 · 2–7d 0.4413 · 8–14d 0.6269 · 15–31d 0.9322
- SGD→USD 1d 0.1636 · 2–7d 0.3037 · 8–14d 0.4530 · 15–31d 0.6280
- USD→LKR 1d 0.1788 · 2–7d 0.3382 · 8–14d 0.5595 · 15–31d 1.0087
- Before gating every model, the ensemble was worse than naive in every bucket (SGD→USD 15–31d +15%). A t < −2
  bar promoted noise for USD→LKR in May 2026 (2–7d +5%), hence t < −2.6 (Bonferroni, ~10 candidates).
- `cbsl_gap` vs naive: SGD→LKR 2–7d 0.4397, 8–14d 0.6126 (−2.3%), 15–31d 0.9276; worse for USD→LKR (0.1857,
  0.3630, 0.5729, 1.0188). Out-of-sample (fit before 2026-03, test after) SGD→LKR 7d −5.7%. Not promoted yet.
- 80% band coverage (q80 band): SGD→USD ~90%, USD→LKR 78–82%, SGD→LKR 85–96%.
- The scoring INSERT needs `enable_nestloop = off` after a big replay (13 min → 8 s); it's in `lib/sync.ts`.

Older baseline (2026-11-09, 90-day replay), ensemble / naive MAE %: LKR 1d 0.126/0.126 · 15–31d 0.396/0.399; USD 1d 0.095/0.093 ·
15–31d 0.380/0.315.

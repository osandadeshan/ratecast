---
paths:
  - "lib/predict/**"
  - "lib/sync.ts"
---

# Forecasting & learning rules

- `lib/predict/*` is **pure** (no fetch, no DB). `sync.ts` feeds it data. Keep it that way so the backtest
  replay and the live forecast run identical code.
- Models work on **log rates** and return log forecasts for horizons 1..H. A new model is one entry in
  `MODELS` + a label in `MODEL_LABELS`. The learner weights it automatically, so don't hand-tune weights.
- Learning (`learning.ts`), per horizon bucket (1, 3, 7, 14, 31 days), over the last 180 days of evaluated errors:
  - weights ∝ 1 / (shrunk MAE)^4. Shrinkage k = 10 toward the bucket mean, so new models start average.
  - bias = recency-weighted (half-life 14d) mean log error of `blend`, shrunk by n/(n+15).
  - bias is **applied only if** `blend_bc` beats `blend` by the same paired t-test as model promotion (below)
    **and** bucket ≤ 7 days. Long-horizon bias correction was measured to double the error (stale regime
    signal). Don't remove this gate.
  - 80% band: half-width = `q80 × √(h / meanH)`, where `q80` is the empirical 80th percentile of the bucket's
    horizon-normalised |ensemble log error| (n ≥ 30), recency-weighted with half-life `BAND_HALF_LIFE_DAYS` = 30
    (2026-11-14: USD→LKR coverage 67.2 → 70.7%, SGD→USD 83.5 → 81.6%, SGD→LKR 80.2 → 79.1%; 15 days over-reacted). Fallback: `Z80` × RMS of errors (n ≥ 10), else `Z80` × daily vol (60 days) × √h. (The old
    RMS band covered 92–94% at 2–14 days and was one width for a whole bucket.)
  - Non-trading weekdays (`calendar.ts`, detected: Sunday's Wise point repeats Saturday's ~98% of the time):
    forecasts don't move across them and their target dates are excluded from learning and accuracy.
  - Policy events (`events.ts`) add variance: band half-width = `sqrt(half² + Z80² · Σ (ratio−1)·base2)` over known
    band-widening events whose move falls in (anchor, target] (`eventExtraVar`, applied in `engine.ts`). Events **never change the point forecast**. Details are in `events.md`.
- **Shadow mode** (`SHADOW_MODELS` in `models.ts`, gate in `learning.ts`):
  - Every new model built on **external data** starts in `SHADOW_MODELS`. It runs and is scored daily, but it
    gets weight 0 and is left out of the pooled MAE (the shrinkage target), so the blend is identical to
    before it existed.
  - **Every model except `naive` is gated, not just shadow ones** (the 365-day replay showed no classic model
    reliably beats the random walk, and ungated they made the ensemble worse at every horizon).
  - Promotion is automatic and per bucket. It needs **≥ 30 distinct target dates** in the window **and** a paired
    t-test on per-date mean |error| vs `naive` with t < −2.6 (n_eff = dates / bucket mean horizon, because
    neighbouring forecasts overlap; 2.6 = Bonferroni for ~10 candidates per bucket. Plain t < −2 promoted noise
    for USD→LKR in May 2026 and made 2–7d 5% worse). Stored as `BucketStats.promoted`; the UI shows "not used" for a model that isn't promoted.
  - Count distinct dates, not rows. Long-horizon forecasts overlap: 60 rows at 15–31 days arrive within ~4 days
    and share a handful of targets. A row-count rule promoted `macro` on noise and worsened LKR 15–31d.
  - **Never hand-promote, and never remove a model from shadow to make it count.** Don't loosen the thresholds
    to get a model in.
- `macro` model (shadow): ridge regression (λ = n, no intercept, features scaled by RMS) of the daily pair return
  on each factor's move over `MACRO_WINDOW_DAYS` = 5 days, ending at `d − 1 − lagDays`. Future factor moves
  count as 0, so its forecast stops moving ~a week out. Factors and lags are in `MACRO_FACTORS` (`lib/config.ts`):
  `ust2y` (diff, lag 1 day), `brent` (log, lag 9 days) and `usd_broad` (log, lag 10, SGD→USD only via `pairs`).
  See `macro.md`.
- `news` model (shadow): `naive` plus the learned post-announcement drift (`news.ts`). For the 5 days after
  E+1 of a classified decision, it adds that category's shrunk mean drift (shrink 8 pseudo-events at 0,
  ≥ 3 events, 730-day lookback). It only uses outcomes from E+1 on. On all other days it **equals `naive`**
  (~89% of forecasts in the 2026-11-11 replay), so it can only pass the paired t-test vs naive if the drift is
  real and large. That's the intended bar, so don't special-case its promotion. Details are in `events.md`.
- `lanka` model (shadow, LKR pairs only): the same ridge factor model on `LANKA_FACTORS` (`lib/config.ts`):
  gap between CBSL's official fixing and the Wise rate, CBSL's 5-day USD/LKR move, policy rate and 3m T-bill
  changes, YoY remittances and tourism. Each feature has its own lag, staleness limit and fade.
- `cross` model (shadow, SGD→LKR only): today's rate moved by the legs' `ensemble` forecasts
  (ln SGD→USD_h/SGD→USD_0 + ln USD→LKR_h/USD→LKR_0), made on the same anchor. Legs run first (`PREDICT_ORDER`).
- `cbsl_gap` model (shadow, LKR pairs only; `CBSL_FIXING` maps LKR→`lk_sgd_ind`, USDLKR→`lk_usd_spot`):
  gap(t) = ln(fixing at t−1 / Wise at t) (this beat the same-day gap at t−1: corr 0.47 vs 0.33 with the next
  5 days). Per horizon h, a no-intercept regression over the past 365 anchors whose target i+h is already
  known (≥ 120 obs), shrunk toward 0 (`GAP_SHRINK` 60), β clamped to [−1, 1.5]. Forecast = today + β·gap.
  2026-11-13 replay: SGD→LKR 8–14d 0.613 vs naive 0.627 (−2.3%), out-of-sample 7d −5.7%; USD→LKR worse.
  Not yet significant, so weight 0. Tests: `tests/predict-cbsl-gap.test.ts` (incl. a no-look-ahead check).
- `arima` model (gated, no external data so not in `SHADOW_MODELS`): ARIMA(p,1,0) on 250 days of returns, p = 0–5
  by BIC, ridge λ = 0.1·mean diag, only fits with Σ|β| < 0.9 (an unguarded fit blew up USD→LKR 15–31d to 2.6%).
  2026-11-14: equals naive on SGD→USD, worse on USD→LKR, SGD→LKR 8–31d −1.3 to −1.6% (not significant).
- Learning window 180 days, replay 365 days (`BACKFILL_DAYS`). The replay is time-boxed
  (`REPLAY_BUDGET_MS`, 40 s) and resumes on the next run. Locally set `REPLAY_BUDGET_MS=100000000` for a full run.
- **No look-ahead** in anything you add: inputs restricted to `<= anchorDate` (basket `< anchorDate` in replay).
  Macro factors: `factorsAt(all, anchor)` keeps `date <= anchor − lagDays` in **both** replay and live. Set
  `lagDays` from the observed publication delay, and never lower it to make a backtest look better.
- **One forecast path.** The sync's replay, its live forecast and the version backtest all call `forecastDay`
  (`replay.ts`). Change inputs there, not in `sync.ts`, or the backtest stops measuring the deployed code.
  `npm run backtest` prints the same in-memory backtest; the sync stores it once per `MODEL_VERSION` in
  `model_versions` and compares skill (MAE ÷ random walk) with the previous version (±0.5% = "same").
  Bump `MODEL_VERSION_BASE` when predict logic changes, so the change gets its own backtest row.
- `BucketStats.t` holds the paired t behind each promotion decision; `learningChanges` turns day-to-day
  differences into `learning_log` rows.
- Every model change must be backtested (`.claude/skills/backtest`). Ship it only if `ensemble` MAE is no worse
  than before in every bucket, for all three pairs (`LKR`, `USD`, `USDLKR`). Record the new numbers in `docs/CONTEXT.md`.
  - One accepted exception (owner, 2026-11-11): a shadow model that the automatic rule promotes during the
    replay may move a bucket by noise-sized amounts (it was +0.0006 pp for LKR 8–14d). That is the promotion
    rule working, not a failed backtest. A change you make yourself must still meet the rule with promotion
    disabled (the sanity check in the backtest skill).
- Event/band-only changes: `ensemble` MAE must be **identical**. Judge them on 80% coverage and width in event
  windows vs the previous code (the "event windows" step in the backtest skill).

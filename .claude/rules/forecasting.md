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
    horizon-normalised |ensemble log error| (n ≥ 30). Fallback: RMS of errors, else daily vol × √h. (The old
    RMS band covered 92–94% at 2–14 days and was one width for a whole bucket.)
  - Non-trading weekdays (`calendar.ts`, detected: Sunday's Wise point repeats Saturday's ~98% of the time):
    forecasts don't move across them and their target dates are excluded from learning and accuracy.
  - Policy events (`events.ts`) add variance: band sigma = `sqrt(sigma² + Σ (ratio−1)·base2)` over known events
    whose move falls in (anchor, target]. Events **never change the point forecast**. Details are in `events.md`.
- **Shadow mode** (`SHADOW_MODELS` in `models.ts`, gate in `learning.ts`):
  - Every new model built on **external data** starts in `SHADOW_MODELS`. It runs and is scored daily, but it
    gets weight 0 and is left out of the pooled MAE (the shrinkage target), so the blend is identical to
    before it existed.
  - **Every model except `naive` is gated, not just shadow ones** (the 365-day replay showed no classic model
    reliably beats the random walk, and ungated they made the ensemble worse at every horizon).
  - Promotion is automatic and per bucket. It needs **≥ 30 distinct target dates** in the window **and** a paired
    t-test on per-date mean |error| vs `naive` with t < −2.6 (n_eff = dates / bucket mean horizon, because
    neighbouring forecasts overlap; 2.6 = Bonferroni for ~10 candidates per bucket. Plain t < −2 promoted noise
    for USD→LKR in May 2026 and made 2–7d 5% worse). Stored as `BucketStats.promoted`; the UI shows "shadow".
  - Count distinct dates, not rows. Long-horizon forecasts overlap: 60 rows at 15–31 days arrive within ~4 days
    and share a handful of targets. A row-count rule promoted `macro` on noise and worsened LKR 15–31d.
  - **Never hand-promote, and never remove a model from shadow to make it count.** Don't loosen the thresholds
    to get a model in.
- `macro` model (shadow): ridge regression (λ = n, no intercept, features scaled by RMS) of the daily pair return
  on each factor's move over `MACRO_WINDOW_DAYS` = 5 days, ending at `d − 1 − lagDays`. Future factor moves
  count as 0, so its forecast stops moving ~a week out. Factors and lags are in `MACRO_FACTORS` (`lib/config.ts`):
  `ust2y` (diff, lag 1 day) and `brent` (log, lag 9 days). See `macro.md`.
- `news` model (shadow): `naive` plus the learned post-announcement drift (`news.ts`). For the 5 days after
  E+1 of a classified decision, it adds that category's shrunk mean drift (shrink 8 pseudo-events at 0,
  ≥ 3 events, 730-day lookback). It only uses outcomes from E+1 on. On all other days it **equals `naive`**
  (~89% of forecasts in the 2026-11-11 replay), so its overall MAE can only beat naive by 2% if the drift is
  real and large. That's the intended bar, so don't special-case its promotion. Details are in `events.md`.
- `lanka` model (shadow, LKR pairs only): the same ridge factor model on `LANKA_FACTORS` (`lib/config.ts`):
  gap between CBSL's official fixing and the Wise rate, CBSL's 5-day USD/LKR move, policy rate and 3m T-bill
  changes, YoY remittances and tourism. Each feature has its own lag, staleness limit and fade.
- `cross` model (shadow, SGD→LKR only): today's rate moved by the legs' `ensemble` forecasts
  (ln SGD→USD_h/SGD→USD_0 + ln USD→LKR_h/USD→LKR_0), made on the same anchor. Legs run first (`PREDICT_ORDER`).
- Learning window 180 days, replay 365 days (`BACKFILL_DAYS`). The replay is time-boxed
  (`REPLAY_BUDGET_MS`, 40 s) and resumes on the next run. Locally set `REPLAY_BUDGET_MS=100000000` for a full run.
- **No look-ahead** in anything you add: inputs restricted to `<= anchorDate` (basket `< anchorDate` in replay).
  Macro factors: `factorsAt(all, anchor)` keeps `date <= anchor − lagDays` in **both** replay and live. Set
  `lagDays` from the observed publication delay, and never lower it to make a backtest look better.
- Every model change must be backtested (`.claude/skills/backtest`). Ship it only if `ensemble` MAE is no worse
  than before in every bucket, for both currencies. Record the new numbers in `docs/CONTEXT.md`.
  - One accepted exception (owner, 2026-11-11): a shadow model that the automatic rule promotes during the
    replay may move a bucket by noise-sized amounts (it was +0.0006 pp for LKR 8–14d). That is the promotion
    rule working, not a failed backtest. A change you make yourself must still meet the rule with promotion
    disabled (the sanity check in the backtest skill).
- Event/band-only changes: `ensemble` MAE must be **identical**. Judge them on 80% coverage and width in event
  windows vs the previous code (the "event windows" step in the backtest skill).

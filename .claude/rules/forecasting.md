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
- Learning (`learning.ts`), per horizon bucket (1, 3, 7, 14, 31 days), over the last 60 days of evaluated errors:
  - weights ∝ 1 / (shrunk MAE)^4. Shrinkage k = 10 toward the bucket mean, so new models start average.
  - bias = recency-weighted (half-life 14d) mean log error of `blend`, shrunk by n/(n+15).
  - bias is **applied only if** `blend_bc` has beaten `blend` (n ≥ 20) **and** bucket ≤ 7 days. Long-horizon
    bias correction was measured to double the error (stale regime signal). Don't remove this gate.
  - sigma for the 80% band = RMS of `ensemble` log errors (n ≥ 10), else daily vol × √h.
- **No look-ahead** in anything you add: inputs restricted to `<= anchorDate` (basket `< anchorDate` in replay).
- Every model change must be backtested (`.claude/skills/backtest`). Ship it only if `ensemble` MAE is no worse
  than before in every bucket, for both currencies. Record the new numbers in `docs/CONTEXT.md`.

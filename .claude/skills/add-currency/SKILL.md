---
name: add-currency
description: Add another target currency (e.g. SGD → INR) to RateCast end to end - config, sources, UI tab, backfill and backtest. Use when asked to support/predict a new currency.
---

# Add a target currency

Pairs are defined in `PAIRS` (`lib/config.ts`): each id has a base and a quote (`USDLKR` is USD→LKR), so a
new pair doesn't have to be SGD-based. Pair ids are data: never rename one. Add it to `PREDICT_ORDER`
(before any pair whose `cross` model uses it, see `CROSS_LEGS`). Example: adding SGD → `INR`.

1. **Check the sources first.** Wise history:
   `curl -s -A "Mozilla/5.0" "https://wise.com/rates/history?source=SGD&target=INR&length=1&unit=month&resolution=daily" | head -c 200`.
   Comparison: the same `gateway/v4/comparisons` URL as `lib/sources/wise.ts` with `targetCurrency=INR`. Both
   must return data. Cross-check sources (`open.er-api.com`, Currency-API) list almost every ISO code.
2. **Config.** In `lib/config.ts`, add the id to `TARGETS`, a `PAIRS` entry (`base`, `quote`, `label`), a
   `DECIMALS` entry (≥ 3 significant decimals at the rate's magnitude) and the id to `PREDICT_ORDER`.
3. **Types.** `Record<Target, …>` initialisers will fail to typecheck until updated, e.g. the `out` object in
   `fetchCrossChecks` (`lib/sources/market.ts`). Run `npx tsc --noEmit` and fix each error. `fetchCrossChecks`
   only reads SGD-based quotes (plus USD→LKR derived from them), so a non-SGD pair needs its own handling there.
   Not caught by the typecheck (`Record<string, …>`): add the pair to `MAX_DAILY_JUMP` / `MAX_LIVE_GAP` in
   `lib/sources/validate.ts` (default 20%), the `wise-history:<id>` / `wise-live:<id>` entries in `SOURCE_LABEL`
   and a rates row in `SERIES_CATALOG` (both `lib/dashboard.ts`).
4. **UI.** Tabs are generated from `TARGETS`, so nothing to add. Check that the tab row still fits at 390px
   (4+ tabs may need `overflow-x-auto`).
5. **Backfill.** `npm run sync`. A new currency has < 300 history rows, so it downloads 2 years and replays
   365 days (40 s per run; use `REPLAY_BUDGET_MS=100000000` locally).
6. If the model list has pair-specific models, update `PAIR_ONLY` in `app/components/DashboardView.tsx`.
   **Backtest** with the `backtest` skill, and add the currency's row to `docs/CONTEXT.md`.
7. Free-tier check: each pair adds 31 × 15 prediction rows per day (12 models + `blend`, `blend_bc`,
   `ensemble`; ~170k/year). Fine for Neon free up to ~5 pairs with the 550-day prune (`PRUNE_MODELS_AFTER_DAYS`;
   `ensemble` and `naive` rows are kept forever).
8. Update README (title/intro) and `docs/CONTEXT.md` requirements.

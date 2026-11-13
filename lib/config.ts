export const BASE = "SGD" as const;
/**
 * Pairs RateCast tracks. The id is stored data (rates_history.currency etc.): never rename.
 * "LKR" and "USD" are SGD→LKR and SGD→USD; "USDLKR" is USD→LKR, the leg that drives most of SGD→LKR.
 */
export const TARGETS = ["LKR", "USD", "USDLKR"] as const;
export type Target = (typeof TARGETS)[number];
export const PAIRS: Record<Target, { base: string; quote: string; label: string }> = {
  LKR: { base: "SGD", quote: "LKR", label: "SGD → LKR" },
  USD: { base: "SGD", quote: "USD", label: "SGD → USD" },
  USDLKR: { base: "USD", quote: "LKR", label: "USD → LKR" },
};
/** Forecast order in a sync: the legs first, so SGD→LKR's two-part (`cross`) model can use them. */
export const PREDICT_ORDER: readonly Target[] = ["USD", "USDLKR", "LKR"];
/** SGD→LKR = SGD→USD × USD→LKR. */
export const CROSS_LEGS: Partial<Record<Target, readonly [Target, Target]>> = { LKR: ["USD", "USDLKR"] };

/**
 * Version of the forecasting code, stored with every prediction and sync run. Bump it whenever
 * lib/predict, the learning rules or the inputs change, so accuracy can be compared per version.
 * The git commit is appended on Vercel.
 */
export const MODEL_VERSION_BASE = "2026.11.14";
export const MODEL_VERSION =
  MODEL_VERSION_BASE + (process.env.VERCEL_GIT_COMMIT_SHA ? `+${process.env.VERCEL_GIT_COMMIT_SHA.slice(0, 7)}` : "");

/**
 * Retention. Final forecasts and the random-walk baseline are kept forever (the permanent record,
 * ~6 MB/year); every other model's rows are pruned after PRUNE_MODELS_AFTER_DAYS.
 */
export const KEEP_FOREVER_MODELS = ["ensemble", "naive"] as const;
export const PRUNE_MODELS_AFTER_DAYS = 550;

/** Timezone used to decide what "today" is for the user. */
export const APP_TZ = "Asia/Singapore";

/** How many days ahead each daily run forecasts. */
export const MAX_HORIZON = 31;

/** Days of history to replay on first run so the learner starts with stats. */
export const BACKFILL_DAYS = 365;

/**
 * A sync stops replaying past days once the run has used this long, finishes with status
 * 'partial' and lets the next run (page visit or cron) continue where it stopped. Keeps a
 * page-triggered sync inside Vercel's 60 s limit. Override locally with REPLAY_BUDGET_MS.
 */
export const REPLAY_BUDGET_MS = Number(process.env.REPLAY_BUDGET_MS) || 40_000;

/**
 * Deadline (ms since the sync started) for the once-per-version backtest (sync step 4b, ~30 s locally).
 * Past it the backtest stops and stores nothing; the next run tries again. Page-triggered syncs use
 * this default (Vercel's 60 s limit); the cron passes CRON_BACKTEST_BUDGET_MS (its route allows 300 s).
 */
export const BACKTEST_BUDGET_MS = Number(process.env.BACKTEST_BUDGET_MS) || 50_000;
export const CRON_BACKTEST_BUDGET_MS = 240_000;

/** Window of evaluated predictions used for weights / bias. */
export const LEARNING_WINDOW_DAYS = 180;

/** Decimal places shown per target currency. */
export const DECIMALS: Record<Target, number> = { LKR: 3, USD: 5, USDLKR: 3 };

/** Horizon buckets for learned stats (inclusive upper bounds). */
export const HORIZON_BUCKETS = [1, 3, 7, 14, 31] as const;
export function bucketOf(h: number): number {
  for (const b of HORIZON_BUCKETS) if (h <= b) return b;
  return HORIZON_BUCKETS[HORIZON_BUCKETS.length - 1];
}

export const USER_AGENT =
  "Mozilla/5.0 (compatible; RateCast/1.0; +https://vercel.com)";

/**
 * Macro factors for the `macro` model (series names in market_data). lagDays = how many days after
 * its date a value is safely available at the 09:30 SGT sync. Replay and live both restrict each
 * factor to date <= anchor - lagDays, so the backtest sees exactly what the live run would.
 * transform: "diff" for yields (percentage points), "log" for prices.
 */
export const MACRO_FACTORS = [
  { series: "ust2y", label: "US 2-year yield", lagDays: 1, transform: "diff" },
  { series: "brent", label: "Brent crude oil", lagDays: 9, transform: "log" },
  // Fed H.10 broad dollar index: weekly release Monday 16:15 ET (Tue ~05:15 SGT, FRED a few hours later) with
  // data to the previous Friday. A Monday value is public after 8 days, 9 if the Monday is a US holiday; 10
  // leaves room for FRED posting after the 09:30 SGT sync. SGD→USD only (planned that way: it is the USD side
  // of that pair; the LKR pairs move on CBSL policy instead).
  { series: "usd_broad", label: "Broad US dollar index", lagDays: 10, transform: "log", pairs: ["USD"] },
] as const;
export type MacroSeries = (typeof MACRO_FACTORS)[number]["series"];
/** The macro model reacts to each factor's move over this many days (ending at its lagged date). */
export const MACRO_WINDOW_DAYS = 5;

/**
 * Inputs of the `lanka` model (CBSL data, lib/sources/srilanka.ts), used only for the pairs listed.
 * kind "gap": ln(CBSL official rate) − ln(this pair's Wise rate) on the lagged date, i.e. how far
 *   Wise sits from the central bank's own fixing (does Wise drift back toward it?).
 * kind "move": the series' change over windowDays ending at the lagged date (log or diff).
 * maxStaleDays: how long a value may be carried forward (monthly series are published 1–2 months late).
 * fadeDays: beyond this many days past the last known date a feature counts as 0, so a stale signal
 *   can't become a month-long drift.
 */
export const LANKA_FACTORS = [
  { series: "lk_sgd_ind", kind: "gap", pairs: ["LKR"], lagDays: 1, windowDays: 0, transform: "log", maxStaleDays: 7, fadeDays: 5 },
  { series: "lk_usd_spot", kind: "gap", pairs: ["USDLKR"], lagDays: 1, windowDays: 0, transform: "log", maxStaleDays: 7, fadeDays: 5 },
  { series: "lk_usd_spot", kind: "move", pairs: ["LKR", "USDLKR"], lagDays: 1, windowDays: 5, transform: "log", maxStaleDays: 7, fadeDays: 5 },
  { series: "lk_opr", kind: "move", pairs: ["LKR", "USDLKR"], lagDays: 60, windowDays: 35, transform: "diff", maxStaleDays: 100, fadeDays: 31 },
  { series: "lk_tbill3m", kind: "move", pairs: ["LKR", "USDLKR"], lagDays: 60, windowDays: 35, transform: "diff", maxStaleDays: 100, fadeDays: 31 },
  { series: "lk_remit", kind: "move", pairs: ["LKR", "USDLKR"], lagDays: 45, windowDays: 365, transform: "log", maxStaleDays: 80, fadeDays: 31 },
  { series: "lk_tourism", kind: "move", pairs: ["LKR", "USDLKR"], lagDays: 45, windowDays: 365, transform: "log", maxStaleDays: 80, fadeDays: 31 },
] as const;

/** Publication lag per stored factor series (used by sync to restrict what a forecast may see). */
export const FACTOR_LAGS: Record<string, number> = Object.fromEntries([
  ...MACRO_FACTORS.map((f) => [f.series, f.lagDays] as const),
  ...LANKA_FACTORS.map((f) => [f.series, f.lagDays] as const),
]);

/** Sri Lanka series shown in the Market context card (fetchers: SRI_LANKA_SERIES in lib/sources/srilanka.ts). */
export const SRI_LANKA_META = [
  { series: "lk_usd_spot", label: "CBSL USD/LKR indicative spot", transform: "log" },
  { series: "lk_sgd_ind", label: "CBSL SGD/LKR indicative rate", transform: "log" },
  { series: "lk_opr", label: "CBSL policy rate (OPR)", transform: "diff" },
  { series: "lk_tbill3m", label: "Sri Lanka 3-month T-bill yield", transform: "diff" },
  { series: "lk_remit", label: "Workers' remittances (USD mn / month)", transform: "log" },
  { series: "lk_tourism", label: "Tourism earnings (USD mn / month)", transform: "log" },
  { series: "lk_ccpi_yoy", label: "Colombo CPI inflation (YoY %)", transform: "diff" },
] as const;

export const BASE = "SGD" as const;
export const TARGETS = ["LKR", "USD"] as const;
export type Target = (typeof TARGETS)[number];

/** Timezone used to decide what "today" is for the user. */
export const APP_TZ = "Asia/Singapore";

/** How many days ahead each daily run forecasts. */
export const MAX_HORIZON = 31;

/** Days of history to replay on first run so the learner starts with stats. */
export const BACKFILL_DAYS = 90;

/** Window of evaluated predictions used for weights / bias. */
export const LEARNING_WINDOW_DAYS = 60;

/** Decimal places shown per target currency. */
export const DECIMALS: Record<Target, number> = { LKR: 3, USD: 5 };

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
] as const;
export type MacroSeries = (typeof MACRO_FACTORS)[number]["series"];
/** The macro model reacts to each factor's move over this many days (ending at its lagged date). */
export const MACRO_WINDOW_DAYS = 5;

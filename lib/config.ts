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

import { addDays, parseISO } from "../dates";

/**
 * Non-trading weekdays. Wise's daily point is the rate at 00:00 UTC, so the Sunday point equals the
 * Saturday point (FX closed on Friday evening) ~98% of the time. Detected from the data instead of
 * hard-coded, so it follows the source if its behaviour changes.
 */
const WEEKS = 26;
const MIN_OBS = 12;
const ZERO_MOVE = 1e-5; // |log move| below 0.001% counts as "did not move"
const ZERO_SHARE = 0.9;

/** Day of week, 0 = Sunday … 6 = Saturday (UTC, like every date in this app). */
export const dowOf = (d: string) => new Date(parseISO(d)).getUTCDay();

/** Weekdays whose daily move was ~0 in at least 90% of the last 26 weeks known at `anchor`. */
export function detectNonTradingDow(rates: Map<string, number>, anchor: string): number[] {
  const n = new Array<number>(7).fill(0);
  const zero = new Array<number>(7).fill(0);
  let prev = rates.get(addDays(anchor, -WEEKS * 7));
  for (let i = WEEKS * 7 - 1; i >= 0; i--) {
    const d = addDays(anchor, -i);
    const v = rates.get(d);
    if (v && prev) {
      const w = dowOf(d);
      n[w]++;
      if (Math.abs(Math.log(v / prev)) < ZERO_MOVE) zero[w]++;
    }
    prev = v;
  }
  return [0, 1, 2, 3, 4, 5, 6].filter((w) => n[w] >= MIN_OBS && zero[w] / n[w] >= ZERO_SHARE);
}

/**
 * The horizon whose forecast applies to `anchor + h`: the last trading day at or before the target
 * (0 = no trading day since the anchor, so the rate cannot have moved). Models are calibrated on
 * calendar days (their daily drift already averages over the flat days), so the calendar path is
 * kept and only frozen across non-trading days: forecast(Sunday) = forecast(Saturday).
 */
export function effectiveHorizon(anchor: string, h: number, nonTradingDow: readonly number[]): number {
  if (!nonTradingDow.length) return h;
  for (let k = h; k >= 1; k--) if (!nonTradingDow.includes(dowOf(addDays(anchor, k)))) return k;
  return 0;
}

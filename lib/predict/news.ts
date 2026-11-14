import { addDays } from "../dates";
import type { EventRecord } from "./events";
import { valueAt } from "./series";

/**
 * Post-announcement drift. After a classified announcement (e.g. "fomc:cut", "cbsl_policy:hold"),
 * does this pair keep moving the same way over the next few days? Learned per category from past
 * events and shrunk hard toward zero. Used by the `news` model, which runs in shadow mode.
 *
 * Timing: an outcome is public by E+1 (CBSL publishes ~07:30 Sri Lanka time, after the 09:30 SGT
 * sync; the FOMC decides on US afternoon). The jump into E+1 is already in the anchor rate, so only
 * the drift from E+1 to E+1+DRIFT_DAYS is learned and forecast.
 */
export const DRIFT_DAYS = 5;
const LOOKBACK_DAYS = 730;
/** Pseudo-events with zero drift: 3 real events of +0.3% give 0.3 × 3/11 ≈ +0.08%. */
const SHRINK = 8;
const MIN_EVENTS = 3;

export interface NewsDriftStat {
  category: string; // `${kind}:${outcome}`
  n: number;
  drift: number; // shrunk mean log move from E+1 to E+1+DRIFT_DAYS
}

export const categoryOf = (e: EventRecord) => (e.outcome && e.outcome !== "unclear" ? `${e.kind}:${e.outcome}` : null);

export function learnNewsDrift(rates: Map<string, number>, events: EventRecord[], asOf: string): NewsDriftStat[] {
  const from = addDays(asOf, -LOOKBACK_DAYS);
  const by = new Map<string, number[]>();
  const seen = new Set<string>();
  for (const e of events) {
    const c = categoryOf(e);
    const end = addDays(e.eventDate, 1 + DRIFT_DAYS);
    if (!c || e.eventDate < from || end > asOf || seen.has(`${c}:${e.eventDate}`)) continue;
    seen.add(`${c}:${e.eventDate}`);
    const a = valueAt(rates, addDays(e.eventDate, 1));
    const b = valueAt(rates, end);
    if (!a || !b) continue;
    by.set(c, [...(by.get(c) ?? []), Math.log(b / a)]);
  }
  return [...by.entries()]
    .map(([category, xs]) => ({ category, n: xs.length, drift: xs.reduce((s, x) => s + x, 0) / (xs.length + SHRINK) }))
    .sort((x, y) => x.category.localeCompare(y.category));
}

/**
 * Extra log move expected between `anchor` and `target` from announcements whose drift window
 * (E+1, E+1+DRIFT_DAYS] is still open at `anchor`. Outcomes count only from E+1 (no look-ahead).
 */
export function newsDriftBetween(
  events: EventRecord[],
  stats: NewsDriftStat[],
  anchor: string,
  target: string,
): number {
  let total = 0;
  for (const e of events) {
    const c = categoryOf(e);
    const start = addDays(e.eventDate, 1);
    const end = addDays(start, DRIFT_DAYS);
    if (!c || anchor < start || anchor >= end) continue;
    const s = stats.find((x) => x.category === c);
    if (!s || s.n < MIN_EVENTS) continue;
    const last = target < end ? target : end;
    const days = Math.round((Date.parse(last) - Date.parse(anchor)) / 86_400_000);
    if (days > 0) total += (s.drift / DRIFT_DAYS) * days;
  }
  return total;
}

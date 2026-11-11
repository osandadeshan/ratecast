import { addDays, parseISO } from "../dates";
import { valueAt } from "./series";

/**
 * Scheduled / detected policy events (FOMC, CBSL reviews, IMF news). Events never move the
 * point forecast. They only widen the 80% band on days where, historically, this currency
 * pair has moved more than on an ordinary weekday.
 */
export interface EventRecord {
  kind: string; // EVENT_KINDS key, stored as data (like model names: never rename)
  eventDate: string; // announcement date (local date of the announcing institution)
  knownSince: string; // first date the event (and its date) was public: no-look-ahead gate
  source: string;
  title: string;
  url: string | null;
  /** cut | hold | hike (policy decisions), sla | board | other (IMF); null until classified. Known from event_date + 1. */
  outcome?: string | null;
}

export const EVENT_KINDS = {
  fomc: { label: "US Fed rate decision (FOMC)", short: "Fed" },
  cbsl_policy: { label: "CBSL monetary policy review", short: "CBSL" },
  imf: { label: "IMF / Sri Lanka programme news", short: "IMF" },
} as const;
export type EventKind = keyof typeof EVENT_KINDS;

export interface EventVolStat {
  kind: string;
  n: number; // past events with a measurable move
  /** Shrunk ratio of 2-day squared moves around events vs ordinary weekdays (1 = no extra move). */
  ratio: number;
  /** Variance of an ordinary 2-day log move, used to size the extra band. */
  base2: number;
}

const LOOKBACK_DAYS = 730;
/** Pseudo-events at ratio 1 added to every kind, so a few noisy events can't blow up the band. */
const SHRINK_EVENTS = 6;
const MIN_EVENTS = 4;

const isWeekday = (d: string) => {
  const w = new Date(parseISO(d)).getUTCDay();
  return w !== 0 && w !== 6;
};

/** 2-day log move across an announcement on day E: ln(rate(E+1) / rate(E-1)). */
function move(rates: Map<string, number>, e: string): number | undefined {
  const a = valueAt(rates, addDays(e, -1));
  const b = valueAt(rates, addDays(e, 1));
  return a && b ? Math.log(b / a) : undefined;
}

/**
 * Learn, per event kind, how much bigger moves are around announcements. Uses only rates and
 * events whose move window has closed by `asOf` (event_date + 1 <= asOf), so replay is honest.
 */
export function learnEventVol(rates: Map<string, number>, events: EventRecord[], asOf: string): EventVolStat[] {
  const from = addDays(asOf, -LOOKBACK_DAYS);
  const past = events.filter((e) => e.eventDate > addDays(from, 1) && addDays(e.eventDate, 1) <= asOf);
  const near = new Set(past.flatMap((e) => [-2, -1, 0, 1, 2].map((k) => addDays(e.eventDate, k))));

  // Baseline: the same 2-day move around every ordinary weekday.
  let sum = 0;
  let n = 0;
  for (let d = addDays(from, 2); addDays(d, 1) <= asOf; d = addDays(d, 1)) {
    if (!isWeekday(d) || near.has(d)) continue;
    const r = move(rates, d);
    if (r === undefined) continue;
    sum += r * r;
    n++;
  }
  const base2 = n >= 60 ? sum / n : 0;

  return (Object.keys(EVENT_KINDS) as EventKind[]).map((kind) => {
    const dates = [...new Set(past.filter((e) => e.kind === kind).map((e) => e.eventDate))];
    const sq = dates.map((d) => move(rates, d)).filter((r): r is number => r !== undefined).map((r) => r * r);
    if (!base2 || sq.length < MIN_EVENTS) return { kind, n: sq.length, ratio: 1, base2 };
    const ratio = (sq.reduce((a, b) => a + b, 0) + SHRINK_EVENTS * base2) / (sq.length + SHRINK_EVENTS) / base2;
    return { kind, n: sq.length, ratio: Math.max(1, ratio), base2 };
  });
}

/**
 * Extra log-variance to add to the band of a forecast made on `anchor` for `target`:
 * one ordinary 2-day variance × (ratio − 1) for every known event whose move falls inside
 * (anchor, target]. Events not yet public at `anchor` are ignored.
 */
export function eventExtraVar(events: EventRecord[], stats: EventVolStat[], anchor: string, target: string): number {
  let extra = 0;
  const seen = new Set<string>();
  for (const e of events) {
    if (e.knownSince > anchor || e.eventDate < anchor || addDays(e.eventDate, 1) > target) continue;
    const key = `${e.kind}:${e.eventDate}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const s = stats.find((x) => x.kind === e.kind);
    if (s) extra += (s.ratio - 1) * s.base2;
  }
  return extra;
}

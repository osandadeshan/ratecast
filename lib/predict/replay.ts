/**
 * One forecast day, exactly as the sync makes it, from data known on that day. Shared by the sync's
 * replay of missed days, its live forecast and the automatic version backtest (`backtest.ts`), so
 * all three run the same code. Pure: callers load the data.
 */
import { FACTOR_LAGS, MAX_HORIZON } from "../config";
import { addDays } from "../dates";
import { detectNonTradingDow } from "./calendar";
import { type PredictionRow, forecast } from "./engine";
import { type EventRecord, learnEventVol } from "./events";
import { type ErrorIndex, type LearnedStats, learn } from "./learning";
import { learnNewsDrift } from "./news";

/** Everything a pair's forecast reads, unrestricted. Each call restricts it to what was known. */
export interface PairInputs {
  pair: string;
  /** Official Wise points (source = 'wise'). */
  official: Map<string, number>;
  basket: Map<string, number>;
  factors: Record<string, Map<string, number>>;
  events: EventRecord[];
}

export function restrict(map: Map<string, number>, maxDate: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const [d, v] of map) if (d <= maxDate) out.set(d, v);
  return out;
}

/** Each factor restricted to what was public at `anchor` (date <= anchor - lagDays). */
export function factorsAt(all: Record<string, Map<string, number>>, anchor: string): Record<string, Map<string, number>> {
  return Object.fromEntries(
    Object.entries(FACTOR_LAGS).map(([series, lag]) => [series, restrict(all[series] ?? new Map(), addDays(anchor, -lag))]),
  );
}

/**
 * Forecast from anchor `t`. Strictly no look-ahead: rates <= t (`anchorRates` lets the live run use
 * today's provisional quote), ECB basket < t, factors lagged, events known by t, errors with target <= t.
 */
export function forecastDay(
  inp: PairInputs,
  index: ErrorIndex,
  t: string,
  opts: { anchorRates?: Map<string, number>; legMoves?: number[] } = {},
): { rows: PredictionRow[]; stats: LearnedStats } {
  const ratesAtT = restrict(inp.official, t);
  const stats = learn(index, t, { nonTradingDow: detectNonTradingDow(ratesAtT, t) });
  const known = inp.events.filter((e) => e.knownSince <= t);
  stats.events = learnEventVol(ratesAtT, known, t);
  stats.news = learnNewsDrift(ratesAtT, known, t);
  const rows = forecast({
    rates: opts.anchorRates ?? ratesAtT,
    basket: restrict(inp.basket, addDays(t, -1)),
    factors: factorsAt(inp.factors, t),
    anchorDate: t,
    stats,
    events: known,
    eventStats: stats.events,
    newsStats: stats.news,
    pair: inp.pair,
    legMoves: opts.legMoves,
  });
  return { rows, stats };
}

/** Feed the outcomes already known (target < `before`) back into the index, so the next day learns. */
export function feedOutcomes(index: ErrorIndex, rows: PredictionRow[], official: Map<string, number>, before: string) {
  for (const r of rows) {
    const actual = official.get(r.targetDate);
    if (actual && r.targetDate < before) {
      index.add({ model: r.model, horizon: r.horizon, targetDate: r.targetDate, logError: Math.log(r.predicted / actual) });
    }
  }
}

/**
 * For a two-part pair (SGD→LKR): summed log moves of the legs' final forecasts made at the same
 * anchor, ln(leg_h / leg_0) summed over legs, h = 1..H. undefined if a leg has no full path.
 */
export function combineLegMoves(legs: { path: number[] | undefined; anchor: number | undefined }[]): number[] | undefined {
  const moves = new Array<number>(MAX_HORIZON).fill(0);
  for (const { path, anchor } of legs) {
    if (!path || !anchor) return undefined;
    for (let h = 1; h <= MAX_HORIZON; h++) {
      if (!path[h - 1]) return undefined;
      moves[h - 1] += Math.log(path[h - 1] / anchor);
    }
  }
  return moves;
}

/** Changes in what the learner switched on between two days (models and the bias correction). */
export interface LearningChange {
  bucket: number;
  item: string; // model name or "bias_correction"
  change: "promoted" | "demoted";
  t: number | null;
}

export function learningChanges(prev: LearnedStats | undefined, cur: LearnedStats): LearningChange[] {
  if (!prev) return [];
  const out: LearningChange[] = [];
  for (const b of cur.buckets) {
    const p = prev.buckets.find((x) => x.bucket === b.bucket);
    if (!p) continue;
    for (const [m, on] of Object.entries(b.promoted ?? {})) {
      const was = p.promoted?.[m] ?? false;
      if (on !== was) out.push({ bucket: b.bucket, item: m, change: on ? "promoted" : "demoted", t: b.t?.[m] ?? null });
    }
    if (b.biasOn !== p.biasOn) {
      out.push({ bucket: b.bucket, item: "bias_correction", change: b.biasOn ? "promoted" : "demoted", t: b.t?.blend_bc ?? null });
    }
  }
  return out;
}

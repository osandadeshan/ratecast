import { BAND_TREND_DAYS, BAND_TREND_STRETCH, MAX_HORIZON } from "../config";
import { addDays } from "../dates";
import { effectiveHorizon } from "./calendar";
import { type EventRecord, type EventVolStat, eventExtraVar } from "./events";
import type { NewsDriftStat } from "./news";
import { BUCKET_MEAN_H, type LearnedStats, statsFor } from "./learning";
import { MODELS, MODEL_NAMES, type ModelContext } from "./models";
import { buildSeries, diffs, std } from "./series";

export interface PredictionRow {
  madeOn: string;
  targetDate: string;
  horizon: number;
  model: string;
  predicted: number;
  lower80: number | null;
  upper80: number | null;
}

export const Z80 = 1.2816;
/** Band half-width (log) when no trading day lies between anchor and target: the rate cannot move. */
const FROZEN_HALF_WIDTH = 1e-4;

/**
 * Run every model from `anchorDate`, blend them with learned weights, remove learned bias,
 * attach an 80% band. Returns rows for each model + "blend" + "blend_bc" + "ensemble".
 * Known scheduled events (FOMC, CBSL, ...) inside the horizon widen the band only, never the point.
 *
 * Non-trading days (stats.nonTradingDow, e.g. Sunday): the forecast for such a target is the forecast
 * for the last trading day before it (or the anchor rate), because the rate does not move.
 */
export function forecast(opts: {
  rates: Map<string, number>; // must already be restricted to dates <= anchorDate
  basket: Map<string, number>;
  /** Macro factors, each restricted to date <= anchorDate - lagDays (see MACRO_FACTORS). */
  factors?: Record<string, Map<string, number>>;
  anchorDate: string;
  stats: LearnedStats;
  horizon?: number;
  /** Events already filtered to knownSince <= anchorDate (eventExtraVar re-checks). */
  events?: EventRecord[];
  eventStats?: EventVolStat[];
  newsStats?: NewsDriftStat[];
  /** Pair id, and for SGD→LKR the legs' summed log moves per horizon (see ModelContext). */
  pair?: string;
  legMoves?: number[];
}): PredictionRow[] {
  const H = opts.horizon ?? MAX_HORIZON;
  const series = buildSeries(opts.rates, opts.anchorDate, 400);
  if (series.logs.length < 30 || series.dates[series.dates.length - 1] !== opts.anchorDate) return [];

  const ctx: ModelContext = {
    series,
    rates: opts.rates,
    basket: opts.basket,
    anchorDate: opts.anchorDate,
    factors: opts.factors,
    events: opts.events,
    newsStats: opts.newsStats,
    pair: opts.pair,
    legMoves: opts.legMoves,
  };
  const out: PredictionRow[] = [];
  const perModel: Record<string, number[]> = {};
  const lastLog = series.logs[series.logs.length - 1];
  // A model output that isn't finite (bad input data) falls back to the random walk, so it can't
  // poison the blend (0 × NaN = NaN) or, through its stored errors, later learning.
  for (const name of MODEL_NAMES) perModel[name] = MODELS[name](ctx, H).map((v) => (Number.isFinite(v) ? v : lastLog));

  const dailyVol = std(diffs(series.logs.slice(-61)));
  const stretch = (opts.pair && BAND_TREND_STRETCH[opts.pair]) || 0;
  const recent = series.logs.slice(-(BAND_TREND_DAYS + 1));
  const trend = stretch && recent.length > 1 ? (recent[recent.length - 1] - recent[0]) / (recent.length - 1) : 0;
  const nonTrading = opts.stats.nonTradingDow ?? [];

  for (let h = 1; h <= H; h++) {
    const targetDate = addDays(opts.anchorDate, h);
    // hEff = horizon of the last trading day at or before the target (0 = none since the anchor).
    const hEff = effectiveHorizon(opts.anchorDate, h, nonTrading);
    const effDate = addDays(opts.anchorDate, hEff);
    const s = statsFor(opts.stats, Math.max(hEff, 1));
    const row = (model: string, v: number, half: number | null, up: number | null = half): PredictionRow => ({
      madeOn: opts.anchorDate,
      targetDate,
      horizon: h,
      model,
      predicted: Math.exp(v),
      lower80: half === null ? null : Math.exp(v - half),
      upper80: up === null ? null : Math.exp(v + up),
    });

    let blend = 0;
    for (const name of MODEL_NAMES) {
      const v = hEff === 0 ? lastLog : perModel[name][hEff - 1];
      out.push(row(name, v, null));
      if (s.weights[name]) blend += s.weights[name] * v;
    }
    out.push(row("blend", blend, null));
    out.push(row("blend_bc", hEff === 0 ? blend : blend - s.bias, null));
    const corrected = hEff === 0 ? blend : blend - s.bias * s.biasOn;

    // Band half-width. Preferred: the empirical 80th percentile of past |errors| in this bucket,
    // rescaled from the bucket's mean horizon to this one (errors grow ~√h). Fallback while there
    // are too few errors: the normal approximation Z80 × sigma. Event variance is added in
    // quadrature as Z80² × extra, i.e. the half-width an extra normal move of that variance has.
    let half = FROZEN_HALF_WIDTH;
    let ext = 0;
    if (hEff > 0) {
      const base =
        s.q80 != null
          ? s.q80 * Math.sqrt(hEff / BUCKET_MEAN_H[s.bucket])
          : Z80 * (s.sigma ?? Math.max(dailyVol, 1e-4) * Math.sqrt(hEff));
      const extra = opts.events && opts.eventStats ? eventExtraVar(opts.events, opts.eventStats, opts.anchorDate, effDate) : 0;
      half = Math.sqrt(base ** 2 + Z80 ** 2 * extra);
      // LKR pairs: stretch the side the recent trend points to (BAND_TREND_STRETCH).
      ext = stretch * Math.abs(trend) * hEff;
    }
    out.push(row("ensemble", corrected, half + (trend < 0 ? ext : 0), half + (trend > 0 ? ext : 0)));
  }
  return out;
}

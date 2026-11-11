import { MAX_HORIZON } from "../config";
import { addDays } from "../dates";
import { type EventRecord, type EventVolStat, eventExtraVar } from "./events";
import type { NewsDriftStat } from "./news";
import { type LearnedStats, statsFor } from "./learning";
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

const Z80 = 1.2816;

/**
 * Run every model from `anchorDate`, blend them with learned weights, remove learned bias,
 * attach an 80% band. Returns rows for each model + "blend" + "blend_bc" + "ensemble".
 * Known scheduled events (FOMC, CBSL, ...) inside the horizon widen the band only, never the point.
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
  };
  const out: PredictionRow[] = [];
  const perModel: Record<string, number[]> = {};
  for (const name of MODEL_NAMES) perModel[name] = MODELS[name](ctx, H);

  const dailyVol = std(diffs(series.logs.slice(-61)));

  for (let h = 1; h <= H; h++) {
    const targetDate = addDays(opts.anchorDate, h);
    const s = statsFor(opts.stats, h);
    let blend = 0;
    for (const name of MODEL_NAMES) {
      const v = perModel[name][h - 1];
      out.push({ madeOn: opts.anchorDate, targetDate, horizon: h, model: name, predicted: Math.exp(v), lower80: null, upper80: null });
      blend += s.weights[name] * v;
    }
    out.push({ madeOn: opts.anchorDate, targetDate, horizon: h, model: "blend", predicted: Math.exp(blend), lower80: null, upper80: null });

    out.push({ madeOn: opts.anchorDate, targetDate, horizon: h, model: "blend_bc", predicted: Math.exp(blend - s.bias), lower80: null, upper80: null });

    const corrected = blend - s.bias * s.biasOn;
    const baseSigma = s.sigma ?? Math.max(dailyVol, 1e-4) * Math.sqrt(h);
    const extra = opts.events && opts.eventStats ? eventExtraVar(opts.events, opts.eventStats, opts.anchorDate, targetDate) : 0;
    const sigma = Math.sqrt(baseSigma ** 2 + extra);
    out.push({
      madeOn: opts.anchorDate,
      targetDate,
      horizon: h,
      model: "ensemble",
      predicted: Math.exp(corrected),
      lower80: Math.exp(corrected - Z80 * sigma),
      upper80: Math.exp(corrected + Z80 * sigma),
    });
  }
  return out;
}

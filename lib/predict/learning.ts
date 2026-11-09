import { HORIZON_BUCKETS, LEARNING_WINDOW_DAYS, bucketOf } from "../config";
import { addDays, diffDays } from "../dates";
import { MODEL_NAMES } from "./models";

/** One evaluated prediction (a row of prediction_errors). */
export interface ErrorRecord {
  model: string;
  horizon: number;
  targetDate: string;
  logError: number; // ln(predicted / actual)
}

export interface BucketStats {
  bucket: number;
  weights: Record<string, number>;
  mae: Record<string, number | null>; // mean |log error| per model, in %
  n: Record<string, number>;
  bias: number; // log bias of the raw blend (positive = we were too high)
  biasN: number;
  /** 1 = bias correction applied, 0 = not; decided by whether it has actually helped. */
  biasOn: number;
  maeBlend: number | null; // % — raw blend
  maeCorrected: number | null; // % — blend with bias correction (counterfactual, always tracked)
  sigma: number | null; // std of final-ensemble log errors
  sigmaN: number;
}

export interface LearnedStats {
  asOf: string;
  windowDays: number;
  buckets: BucketStats[];
}

const SHRINK_MAE = 10;
const SHRINK_BIAS = 15;
const HALF_LIFE = 14;
/** Higher = trust the historically best models more aggressively. */
const WEIGHT_POWER = 4;
const MIN_GATE_SAMPLES = 20;
/** Long-horizon errors arrive weeks late (stale regime), so only correct bias up to this horizon. */
const MAX_BIAS_BUCKET = 7;

/**
 * Turn past deltas into (a) model weights per horizon bucket, (b) a bias correction,
 * (c) an error band. Only errors whose target date is <= asOf are used, so replaying
 * history never peeks into the future.
 */
export function learn(errors: ErrorRecord[], asOf: string): LearnedStats {
  const from = addDays(asOf, -LEARNING_WINDOW_DAYS);
  const recent = errors.filter((e) => e.targetDate <= asOf && e.targetDate > from);

  const buckets: BucketStats[] = HORIZON_BUCKETS.map((bucket) => {
    const inB = recent.filter((e) => bucketOf(e.horizon) === bucket);
    const mae: Record<string, number | null> = {};
    const n: Record<string, number> = {};
    for (const m of MODEL_NAMES) {
      const xs = inB.filter((e) => e.model === m).map((e) => Math.abs(e.logError));
      n[m] = xs.length;
      mae[m] = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
    }
    const known = MODEL_NAMES.filter((m) => mae[m] !== null);
    const pooled = known.length ? known.reduce((s, m) => s + (mae[m] as number), 0) / known.length : null;

    const raw: Record<string, number> = {};
    for (const m of MODEL_NAMES) {
      if (pooled === null) {
        raw[m] = 1;
      } else {
        const shrunk = ((mae[m] ?? pooled) * n[m] + pooled * SHRINK_MAE) / (n[m] + SHRINK_MAE);
        raw[m] = 1 / (shrunk + 1e-5) ** WEIGHT_POWER;
      }
    }
    const total = Object.values(raw).reduce((a, b) => a + b, 0);
    const weights = Object.fromEntries(MODEL_NAMES.map((m) => [m, raw[m] / total]));

    // Bias of the raw blend, recency-weighted, shrunk toward 0 when few samples.
    const blendErr = inB.filter((e) => e.model === "blend");
    let bw = 0;
    let bs = 0;
    for (const e of blendErr) {
      const w = 0.5 ** (diffDays(asOf, e.targetDate) / HALF_LIFE);
      bw += w;
      bs += w * e.logError;
    }
    const bias = bw ? (bs / bw) * (blendErr.length / (blendErr.length + SHRINK_BIAS)) : 0;

    // Gate: only correct bias if the corrected variant has beaten the raw blend.
    const maeOf = (model: string) => {
      const xs = inB.filter((e) => e.model === model).map((e) => Math.abs(e.logError));
      return { n: xs.length, mae: xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null };
    };
    const mb = maeOf("blend");
    const mc = maeOf("blend_bc");
    const biasOn =
      bucket <= MAX_BIAS_BUCKET &&
      mb.mae !== null && mc.mae !== null && Math.min(mb.n, mc.n) >= MIN_GATE_SAMPLES && mc.mae < mb.mae ? 1 : 0;

    const ens = inB.filter((e) => e.model === "ensemble").map((e) => e.logError);
    const sigma = ens.length >= 10 ? Math.sqrt(ens.reduce((s, x) => s + x * x, 0) / ens.length) : null;

    return {
      bucket,
      weights,
      mae: Object.fromEntries(MODEL_NAMES.map((m) => [m, mae[m] === null ? null : (mae[m] as number) * 100])),
      n,
      bias,
      biasN: blendErr.length,
      biasOn,
      maeBlend: mb.mae === null ? null : mb.mae * 100,
      maeCorrected: mc.mae === null ? null : mc.mae * 100,
      sigma,
      sigmaN: ens.length,
    };
  });

  return { asOf, windowDays: LEARNING_WINDOW_DAYS, buckets };
}

export function statsFor(stats: LearnedStats, horizon: number): BucketStats {
  const b = bucketOf(horizon);
  return stats.buckets.find((x) => x.bucket === b)!;
}

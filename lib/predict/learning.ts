import { HORIZON_BUCKETS, LEARNING_WINDOW_DAYS, MAX_HORIZON, bucketOf } from "../config";
import { addDays } from "../dates";
import { dowOf } from "./calendar";
import type { EventVolStat } from "./events";
import type { NewsDriftStat } from "./news";
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
  sigma: number | null; // RMS of final-ensemble log errors (kept for transparency / fallback)
  sigmaN: number;
  /**
   * Empirical 80th percentile of |ensemble log error|, each error first scaled to the bucket's mean
   * horizon (÷ √(h / meanH)). The band half-width at horizon h is q80 × √(h / meanH). null if n < 30.
   */
  q80?: number | null;
  /**
   * Every model except `naive`: true once it has beaten the random walk in this bucket (enough
   * distinct target dates and MAE < 0.98 × naive). false = scored but weight 0.
   */
  promoted?: Record<string, boolean>;
  /**
   * The paired t-statistic behind each promotion decision (vs `naive`; `blend_bc` vs `blend` for the bias
   * correction). null = fewer than the required distinct dates. Promoted when t < −2.6. For the audit log.
   */
  t?: Record<string, number | null>;
}

export interface LearnedStats {
  asOf: string;
  windowDays: number;
  buckets: BucketStats[];
  /**
   * Weekdays (0 = Sunday … 6 = Saturday) on which the rate does not move (detected, see calendar.ts).
   * Forecasts are frozen across them and their target dates are excluded from learning; accuracy
   * shown to users should exclude them too (they are trivially "right").
   */
  nonTradingDow?: number[];
  /** Per event kind: how much bigger moves are around announcements (set by sync, see events.ts). */
  events?: EventVolStat[];
  /** Post-announcement drift per `kind:outcome` (set by sync, see news.ts). */
  news?: NewsDriftStat[];
}

const SHRINK_MAE = 10;
const SHRINK_BIAS = 15;
const HALF_LIFE = 14;
/** Higher = trust the historically best models more aggressively. */
const WEIGHT_POWER = 4;
/**
 * A model other than `naive` gets weight in a bucket only if it has been scored on this many
 * distinct target dates there (long-horizon forecasts overlap heavily, so raw counts overstate the
 * evidence) and it beats the random walk by a paired t-test (t < −T_BEATS). FX is close to a
 * random walk, so a model must prove itself before it may move the forecast.
 */
export const MIN_PROMOTE_DATES = 30;
/**
 * Bar for "significantly better than the random walk" (see `beats`). About 10 candidates are tested
 * per bucket every day (9 models + the bias correction), so a plain t < −2 (≈2.3% false positives per
 * test) promotes noise regularly: in the 2026-11-12 three-pair replay it promoted a model for USD→LKR
 * through May 2026 and made 2–7 day forecasts 5% worse. Bonferroni for a 5% family-wise rate over
 * 10 candidates: z(1 − 0.05/10) ≈ 2.58, rounded to 2.6.
 */
const T_BEATS = 2.6;
/** Long-horizon errors arrive weeks late (stale regime), so only correct bias up to this horizon. */
const MAX_BIAS_BUCKET = 7;
const MIN_Q80_SAMPLES = 30;

/** Mean horizon of each bucket (1, 2.5, 5.5, 11, 23 for the default buckets). */
export const BUCKET_MEAN_H: Record<number, number> = Object.fromEntries(
  HORIZON_BUCKETS.map((b, i) => {
    const lo = i === 0 ? 1 : HORIZON_BUCKETS[i - 1] + 1;
    const hi = i === HORIZON_BUCKETS.length - 1 ? Math.max(b, MAX_HORIZON) : b;
    return [b, (lo + hi) / 2];
  }),
);

interface DayAgg {
  n: number;
  sum: number; // Σ log error
  sumAbs: number;
  sumSq: number;
  absNorm: number[] | null; // ensemble only: |error| ÷ √(h / meanH)
}

/**
 * Errors grouped by (bucket, model, target date) so that learning on one day costs
 * O(models × window days) instead of rescanning every error. Append-only.
 */
export class ErrorIndex {
  private groups = new Map<string, Map<string, DayAgg>>();

  constructor(records: ErrorRecord[] = []) {
    for (const r of records) this.add(r);
  }

  add(e: ErrorRecord) {
    const bucket = bucketOf(e.horizon);
    const key = `${bucket}|${e.model}`;
    let g = this.groups.get(key);
    if (!g) this.groups.set(key, (g = new Map()));
    let d = g.get(e.targetDate);
    if (!d) g.set(e.targetDate, (d = { n: 0, sum: 0, sumAbs: 0, sumSq: 0, absNorm: e.model === "ensemble" ? [] : null }));
    const a = Math.abs(e.logError);
    d.n++;
    d.sum += e.logError;
    d.sumAbs += a;
    d.sumSq += a * a;
    d.absNorm?.push(a / Math.sqrt(e.horizon / BUCKET_MEAN_H[bucket]));
  }

  days(bucket: number, model: string): Map<string, DayAgg> | undefined {
    return this.groups.get(`${bucket}|${model}`);
  }
}

export interface LearnOptions {
  windowDays?: number;
  minPromoteDates?: number;
  /** Target dates on these weekdays are ignored (they repeat the previous trading day's outcome). */
  nonTradingDow?: readonly number[];
  /** Models that must beat `naive` to get weight. Default: every model except `naive`. */
  gated?: readonly string[];
}

/**
 * Turn past deltas into (a) model weights per horizon bucket, (b) a bias correction,
 * (c) an error band. Only errors whose target date is <= asOf are used, so replaying
 * history never peeks into the future.
 */
export function learn(index: ErrorIndex, asOf: string, opts: LearnOptions = {}): LearnedStats {
  const windowDays = opts.windowDays ?? LEARNING_WINDOW_DAYS;
  const minDates = opts.minPromoteDates ?? MIN_PROMOTE_DATES;
  const nonTrading = opts.nonTradingDow ?? [];
  const gated = opts.gated ?? MODEL_NAMES.filter((m) => m !== "naive");

  // Target dates in the window, newest first, with their age in days (for the bias half-life).
  const window: { date: string; age: number }[] = [];
  for (let age = 0; age < windowDays; age++) {
    const date = addDays(asOf, -age);
    if (!nonTrading.includes(dowOf(date))) window.push({ date, age });
  }

  const buckets: BucketStats[] = HORIZON_BUCKETS.map((bucket) => {
    const agg = (model: string) => {
      const g = index.days(bucket, model);
      let n = 0;
      let sumAbs = 0;
      let dates = 0;
      if (g) {
        for (const w of window) {
          const d = g.get(w.date);
          if (!d) continue;
          n += d.n;
          sumAbs += d.sumAbs;
          dates++;
        }
      }
      return { n, dates, mae: n ? sumAbs / n : null };
    };

    const mae: Record<string, number | null> = {};
    const n: Record<string, number> = {};
    const dates: Record<string, number> = {};
    for (const m of MODEL_NAMES) {
      const a = agg(m);
      n[m] = a.n;
      mae[m] = a.mae;
      dates[m] = a.dates;
    }

    // Paired test "is `a` really better than `b` here?": per target date d = mean|err a| − mean|err b|,
    // t = mean(d) / (sd(d) / √nEff). Forecasts for neighbouring dates overlap by about the bucket's
    // mean horizon, so the effective sample is nEff = dates / meanH. Better = t < −T_BEATS.
    const pairedT = (a: string, b: string): number | null => {
      const ga = index.days(bucket, a);
      const gb = index.days(bucket, b);
      if (!ga || !gb) return null;
      let k = 0;
      let sum = 0;
      let sq = 0;
      for (const w of window) {
        const da = ga.get(w.date);
        const db = gb.get(w.date);
        if (!da || !db) continue;
        const d = da.sumAbs / da.n - db.sumAbs / db.n;
        k++;
        sum += d;
        sq += d * d;
      }
      if (k < minDates) return null;
      const mean = sum / k;
      const sd = Math.sqrt(Math.max(sq / k - mean * mean, 0) * (k / (k - 1)));
      const nEff = k / BUCKET_MEAN_H[bucket];
      return sd > 0 ? mean / (sd / Math.sqrt(nEff)) : null;
    };
    const tStats: Record<string, number | null> = {};
    const beats = (a: string, b: string): boolean => {
      const t = pairedT(a, b);
      tStats[a] = t;
      return t !== null && t < -T_BEATS;
    };

    // Gate: a model is scored every day but only gets weight once it beats the random walk here.
    const promoted: Record<string, boolean> = {};
    for (const m of gated) promoted[m] = beats(m, "naive");
    const active = (m: string) => !(m in promoted) || promoted[m];

    const known = MODEL_NAMES.filter((m) => mae[m] !== null && active(m));
    const pooled = known.length ? known.reduce((s, m) => s + (mae[m] as number), 0) / known.length : null;

    const raw: Record<string, number> = {};
    for (const m of MODEL_NAMES) {
      if (!active(m)) {
        raw[m] = 0;
      } else if (pooled === null) {
        raw[m] = 1;
      } else {
        const shrunk = ((mae[m] ?? pooled) * n[m] + pooled * SHRINK_MAE) / (n[m] + SHRINK_MAE);
        raw[m] = 1 / (shrunk + 1e-5) ** WEIGHT_POWER;
      }
    }
    const total = Object.values(raw).reduce((a, b) => a + b, 0);
    const weights = Object.fromEntries(MODEL_NAMES.map((m) => [m, raw[m] / total]));

    // Bias of the raw blend, recency-weighted, shrunk toward 0 when few samples.
    const blendDays = index.days(bucket, "blend");
    let bw = 0;
    let bs = 0;
    let blendN = 0;
    if (blendDays) {
      for (const w of window) {
        const d = blendDays.get(w.date);
        if (!d) continue;
        const wt = 0.5 ** (w.age / HALF_LIFE);
        bw += wt * d.n;
        bs += wt * d.sum;
        blendN += d.n;
      }
    }
    const bias = bw ? (bs / bw) * (blendN / (blendN + SHRINK_BIAS)) : 0;

    // Gate: the bias correction must earn its place exactly like a model does (same paired test).
    const mb = agg("blend");
    const mc = agg("blend_bc");
    const biasOn = bucket <= MAX_BIAS_BUCKET && beats("blend_bc", "blend") ? 1 : 0;

    // Band: RMS (fallback) and the empirical 80th percentile of horizon-normalised |errors|.
    const ensDays = index.days(bucket, "ensemble");
    let ensN = 0;
    let ensSq = 0;
    const abs: number[] = [];
    if (ensDays) {
      for (const w of window) {
        const d = ensDays.get(w.date);
        if (!d) continue;
        ensN += d.n;
        ensSq += d.sumSq;
        if (d.absNorm) for (const a of d.absNorm) abs.push(a);
      }
    }
    const sigma = ensN >= 10 ? Math.sqrt(ensSq / ensN) : null;
    let q80: number | null = null;
    if (abs.length >= MIN_Q80_SAMPLES) {
      abs.sort((a, b) => a - b);
      q80 = abs[Math.min(abs.length - 1, Math.ceil(0.8 * abs.length) - 1)];
    }

    return {
      bucket,
      weights,
      mae: Object.fromEntries(MODEL_NAMES.map((m) => [m, mae[m] === null ? null : (mae[m] as number) * 100])),
      n,
      bias,
      biasN: blendN,
      biasOn,
      maeBlend: mb.mae === null ? null : mb.mae * 100,
      maeCorrected: mc.mae === null ? null : mc.mae * 100,
      sigma,
      sigmaN: ensN,
      q80,
      promoted,
      t: tStats,
    };
  });

  return { asOf, windowDays, buckets, nonTradingDow: [...nonTrading] };
}

export function statsFor(stats: LearnedStats, horizon: number): BucketStats {
  const b = bucketOf(horizon);
  return stats.buckets.find((x) => x.bucket === b)!;
}

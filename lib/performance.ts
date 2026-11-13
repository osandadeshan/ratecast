/**
 * Forecast performance metrics for the dashboard. Pure (no I/O), so they can be unit-tested.
 *
 * Input rows are scored forecasts (prediction_errors joined with the band of the prediction). Errors
 * are the stored ones: pct = (predicted − actual) / actual × 100, so + means the forecast was too high.
 * Target dates on non-trading weekdays are left out: they repeat the previous day and flatter every model.
 */
import { addDays } from "./dates";

export interface ScoredRow {
  model: string; // "ensemble" | "naive"
  horizon: number;
  madeOn: string;
  targetDate: string;
  predicted: number;
  actual: number;
  pct: number; // (predicted − actual) / actual × 100
  lower80: number | null;
  upper80: number | null;
  origin: string | null; // live | replay
}

export interface Metrics {
  n: number;
  /** Mean absolute % error (MAPE). */
  mape: number | null;
  /** Root mean squared % error. */
  rmse: number | null;
  /** Mean absolute error in rate units. */
  mae: number | null;
  /** Same target dates, the random walk's MAPE. */
  naiveMape: number | null;
}

export interface WindowMetrics extends Metrics {
  days: number;
}

export interface HorizonMetrics extends Metrics {
  horizon: number;
  /** % of actuals inside the final forecast's 80% range (should be ~80). */
  coverage: number | null;
}

export interface BiasVerdict {
  n: number;
  meanPct: number | null;
  t: number | null;
  verdict: "too high" | "too low" | "none" | "not enough data";
}

export interface TrendVerdict {
  /** Mean (|forecast error| − |random-walk error|), %, last 30 days and the 30 before. Negative = better than baseline. */
  recent: number | null;
  prior: number | null;
  verdict: "improving" | "deteriorating" | "no clear change" | "not enough data";
}

export interface Performance {
  windows: WindowMetrics[];
  horizons: HorizonMetrics[];
  bias: BiasVerdict;
  trend: TrendVerdict;
  /** How many scored final forecasts (all horizons, last 90 days) were made live vs rebuilt by the replay. */
  origin: { live: number; replay: number };
}

export const PERF_WINDOWS = [7, 30, 90] as const;
export const PERF_HORIZONS = [1, 7, 14, 30] as const;
/** Normal ≈ 2: a bias or trend is reported only when it is about two standard errors from zero. */
const T_CRIT = 2;
const MIN_N = 10;

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

function metrics(rows: ScoredRow[], naiveByKey: Map<string, ScoredRow>): Metrics {
  if (!rows.length) return { n: 0, mape: null, rmse: null, mae: null, naiveMape: null };
  const nv = rows.map((r) => naiveByKey.get(key(r))).filter((x): x is ScoredRow => !!x);
  return {
    n: rows.length,
    mape: mean(rows.map((r) => Math.abs(r.pct))),
    rmse: Math.sqrt(mean(rows.map((r) => r.pct * r.pct))!),
    mae: mean(rows.map((r) => Math.abs(r.predicted - r.actual))),
    naiveMape: nv.length ? mean(nv.map((r) => Math.abs(r.pct))) : null,
  };
}

const key = (r: ScoredRow) => `${r.horizon}|${r.targetDate}`;

/** Welch t-statistic of mean(a) − mean(b). */
function welchT(a: number[], b: number[]): number | null {
  if (a.length < 2 || b.length < 2) return null;
  const ma = mean(a)!;
  const mb = mean(b)!;
  const va = a.reduce((s, x) => s + (x - ma) ** 2, 0) / (a.length - 1);
  const vb = b.reduce((s, x) => s + (x - mb) ** 2, 0) / (b.length - 1);
  const se = Math.sqrt(va / a.length + vb / b.length);
  return se > 0 ? (ma - mb) / se : null;
}

/**
 * @param rows scored `ensemble` and `naive` forecasts, any horizons
 * @param today evaluation date (rows with targetDate <= today are used)
 * @param nonTradingDow weekdays to leave out (0 = Sunday)
 */
export function computePerformance(rows: ScoredRow[], today: string, nonTradingDow: readonly number[]): Performance {
  const dow = (d: string) => new Date(d + "T00:00:00Z").getUTCDay();
  const usable = rows.filter((r) => r.targetDate <= today && !nonTradingDow.includes(dow(r.targetDate)));
  const ens = usable.filter((r) => r.model === "ensemble");
  const naiveByKey = new Map(usable.filter((r) => r.model === "naive").map((r) => [key(r), r]));
  const since = (days: number) => addDays(today, -days);

  // Next-day forecasts over rolling windows.
  const oneDay = ens.filter((r) => r.horizon === 1);
  const windows = PERF_WINDOWS.map((days) => ({
    days,
    ...metrics(oneDay.filter((r) => r.targetDate > since(days)), naiveByKey),
  }));

  // Each horizon over the last 90 days, with band coverage.
  const last90 = ens.filter((r) => r.targetDate > since(90));
  const horizons = PERF_HORIZONS.map((h) => {
    const hs = last90.filter((r) => r.horizon === h);
    const banded = hs.filter((r) => r.lower80 != null && r.upper80 != null);
    const inside = banded.filter((r) => r.actual >= r.lower80! && r.actual <= r.upper80!).length;
    return {
      horizon: h,
      ...metrics(hs, naiveByKey),
      coverage: banded.length ? (inside / banded.length) * 100 : null,
    };
  });

  // Systematic over/under-prediction of next-day forecasts, last 90 days.
  const signed = oneDay.filter((r) => r.targetDate > since(90)).map((r) => r.pct);
  let bias: BiasVerdict = { n: signed.length, meanPct: mean(signed), t: null, verdict: "not enough data" };
  if (signed.length >= MIN_N) {
    const m = mean(signed)!;
    const sd = Math.sqrt(signed.reduce((s, x) => s + (x - m) ** 2, 0) / (signed.length - 1));
    const t = sd > 0 ? m / (sd / Math.sqrt(signed.length)) : 0;
    bias = { n: signed.length, meanPct: m, t, verdict: t > T_CRIT ? "too high" : t < -T_CRIT ? "too low" : "none" };
  }

  // Skill vs the random walk, last 30 days vs the 30 before (next-day forecasts). Raw error moves with
  // market volatility, so the trend is judged on the gap to the baseline on the same dates.
  const skill = (from: number, to: number) =>
    oneDay
      .filter((r) => r.targetDate > since(from) && r.targetDate <= since(to))
      .map((r) => {
        const nv = naiveByKey.get(key(r));
        return nv ? Math.abs(r.pct) - Math.abs(nv.pct) : null;
      })
      .filter((x): x is number => x !== null);
  const recent = skill(30, 0);
  const prior = skill(60, 30);
  let trend: TrendVerdict = { recent: mean(recent), prior: mean(prior), verdict: "not enough data" };
  if (recent.length >= MIN_N && prior.length >= MIN_N) {
    const t = welchT(recent, prior);
    trend = {
      ...trend,
      verdict: t === null ? "no clear change" : t < -T_CRIT ? "improving" : t > T_CRIT ? "deteriorating" : "no clear change",
    };
  }

  return {
    windows,
    horizons,
    bias,
    trend,
    origin: {
      live: last90.filter((r) => r.origin === "live").length,
      replay: last90.filter((r) => r.origin !== "live").length,
    },
  };
}

/**
 * Where the forecast says the rate is heading by `target`: only called a direction when today's rate
 * is outside the forecast's own 80% range, otherwise it's within normal noise.
 */
export function direction(
  today: number | null | undefined,
  predicted: number | null | undefined,
  lower: number | null | undefined,
  upper: number | null | undefined,
): "up" | "down" | "no clear direction" | null {
  if (today == null || predicted == null) return null;
  if (lower == null || upper == null) return "no clear direction";
  if (today < lower) return "up";
  if (today > upper) return "down";
  return "no clear direction";
}

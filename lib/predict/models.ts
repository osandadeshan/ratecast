import { LANKA_FACTORS, MACRO_FACTORS, MACRO_WINDOW_DAYS } from "../config";
import { addDays, addMonths } from "../dates";
import type { EventRecord } from "./events";
import { type NewsDriftStat, newsDriftBetween } from "./news";
import { type Series, diffs, mean, valueAt } from "./series";

export interface ModelContext {
  series: Series; // log rates, last element = anchor (made_on)
  rates: Map<string, number>; // raw known rates (only <= anchor are used)
  basket: Map<string, number>; // USD strength basket (log), known <= anchor
  anchorDate: string;
  /** Macro factor series (market_data), each already restricted to date <= anchor - lagDays. */
  factors?: Record<string, Map<string, number>>;
  /** Known events (knownSince <= anchor) with outcomes, and learned post-announcement drift. */
  events?: EventRecord[];
  newsStats?: NewsDriftStat[];
  /** Pair id (config TARGETS), so pair-specific models know what they forecast. */
  pair?: string;
  /**
   * SGD→LKR only: the legs' final forecasts made at the same anchor, as summed log moves
   * ln(SGD→USD_h / SGD→USD_0) + ln(USD→LKR_h / USD→LKR_0) for h = 1..H. Missing when a leg has no forecast.
   */
  legMoves?: number[];
}

/** Each model returns log-rate forecasts for horizons 1..H. */
export type Model = (ctx: ModelContext, H: number) => number[];

const last = (s: Series) => s.logs[s.logs.length - 1];
const dampedSum = (phi: number, h: number) => {
  let s = 0;
  for (let k = 1; k <= h; k++) s += phi ** k;
  return s;
};

/** Random walk: tomorrow = today. The baseline every FX model has to beat. */
const naive: Model = (ctx, H) => Array.from({ length: H }, () => last(ctx.series));

/** Recent average daily move (30d), damped so it fades over the horizon. */
const drift: Model = (ctx, H) => {
  const d = diffs(ctx.series.logs.slice(-31));
  const mu = mean(d);
  return Array.from({ length: H }, (_, i) => last(ctx.series) + mu * dampedSum(0.97, i + 1));
};

/** Damped Holt linear trend, parameters chosen by grid search on one-step error. */
const holt: Model = (ctx, H) => {
  const y = ctx.series.logs.slice(-120);
  if (y.length < 10) return naive(ctx, H);
  let best = { sse: Infinity, level: y[y.length - 1], trend: 0, phi: 0.9 };
  for (const alpha of [0.3, 0.5, 0.7, 0.9, 1]) {
    for (const beta of [0.02, 0.05, 0.1, 0.2]) {
      for (const phi of [0.8, 0.9, 0.98]) {
        let level = y[0];
        let trend = y[1] - y[0];
        let sse = 0;
        for (let t = 1; t < y.length; t++) {
          const f = level + phi * trend;
          sse += (y[t] - f) ** 2;
          const nl = alpha * y[t] + (1 - alpha) * f;
          trend = beta * (nl - level) + (1 - beta) * phi * trend;
          level = nl;
        }
        if (sse < best.sse) best = { sse, level, trend, phi };
      }
    }
  }
  return Array.from({ length: H }, (_, i) => best.level + best.trend * dampedSum(best.phi, i + 1));
};

/**
 * "What happened from this day-of-month last month?" — replays the path the rate took
 * from the same date 1, 2 and 3 months ago (weighted 50/30/20), damped by 0.6.
 * Captures month-cycle effects such as salary / remittance flows.
 */
const monthlyPattern: Model = (ctx, H) => {
  const weights = [0.5, 0.3, 0.2];
  const out: number[] = [];
  const base = last(ctx.series);
  for (let h = 1; h <= H; h++) {
    let acc = 0;
    let wsum = 0;
    weights.forEach((w, idx) => {
      const b = addMonths(ctx.anchorDate, -(idx + 1));
      const tgt = addDays(b, h);
      if (tgt > ctx.anchorDate) return; // must be known at anchor time
      const vb = valueAt(ctx.rates, b);
      const vt = valueAt(ctx.rates, tgt);
      if (!vb || !vt) return;
      acc += w * (Math.log(vt) - Math.log(vb));
      wsum += w;
    });
    out.push(base + (wsum ? (acc / wsum) * 0.6 : 0));
  }
  return out;
};

/** Pull back toward the 30-day mean (rates rarely run away in a straight line). */
const meanReversion: Model = (ctx, H) => {
  const y = ctx.series.logs;
  const m = mean(y.slice(-30));
  const k = 0.04;
  return Array.from({ length: H }, (_, i) => last(ctx.series) + (m - last(ctx.series)) * (1 - (1 - k) ** (i + 1)));
};

/**
 * Global USD strength signal (ECB basket). Estimates how this pair moves when the USD
 * strengthens (beta over 90 days) and projects the basket's 10-day momentum, damped.
 */
const market: Model = (ctx, H) => {
  const { dates, logs } = ctx.series;
  const n = dates.length;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = Math.max(1, n - 90); i < n; i++) {
    const b1 = valueAt(ctx.basket, dates[i]);
    const b0 = valueAt(ctx.basket, dates[i - 1]);
    if (b1 === undefined || b0 === undefined) continue;
    xs.push(b1 - b0);
    ys.push(logs[i] - logs[i - 1]);
  }
  const bNow = valueAt(ctx.basket, ctx.anchorDate);
  const bPast = valueAt(ctx.basket, addDays(ctx.anchorDate, -10));
  if (xs.length < 20 || bNow === undefined || bPast === undefined) return naive(ctx, H);
  const mx = mean(xs);
  const my = mean(ys);
  let cov = 0;
  let vx = 0;
  for (let i = 0; i < xs.length; i++) {
    cov += (xs[i] - mx) * (ys[i] - my);
    vx += (xs[i] - mx) ** 2;
  }
  const beta = vx > 0 ? cov / vx : 0;
  const momentum = (bNow - bPast) / 10;
  return Array.from({ length: H }, (_, i) => last(ctx.series) + beta * momentum * dampedSum(0.9, i + 1));
};

/** Solve (A + λI) x = b for a small symmetric system (Gaussian elimination). */
function ridgeSolve(A: number[][], b: number[], lambda: number): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row.map((v, j) => v + (i === j ? lambda : 0)), b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    if (Math.abs(M[c][c]) < 1e-12) return new Array(n).fill(0);
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/** One input of a factor model (see MACRO_FACTORS / LANKA_FACTORS in lib/config.ts). */
interface FactorSpec {
  series: string;
  kind: "move" | "gap";
  lagDays: number;
  windowDays: number;
  transform: "log" | "diff";
  maxStaleDays: number;
  fadeDays: number;
}

/**
 * Ridge regression (λ = n, no intercept, RMS-scaled features) of the pair's daily log return on
 * lagged factor features, over the last 250 days. A feature for day d only uses data dated
 * <= d − 1 − lagDays, i.e. public before day d. Beyond the last known date, "move" features see no
 * new data (so they fade to 0) and every feature is 0 once it is more than fadeDays stale.
 */
function factorModel(ctx: ModelContext, H: number, all: readonly FactorSpec[]): number[] {
  const f = ctx.factors;
  const specs = all.filter((s) => (f?.[s.series]?.size ?? 0) > 0);
  if (!f || !specs.length) return naive(ctx, H);
  const feature = (s: FactorSpec, d: string): number | undefined => {
    const known = addDays(ctx.anchorDate, -s.lagDays);
    const rawEnd = addDays(d, -1 - s.lagDays);
    if (rawEnd > addDays(known, s.fadeDays)) return 0;
    const clamp = (x: string) => (x > known ? known : x);
    const end = clamp(rawEnd);
    const b = valueAt(f[s.series], end, s.maxStaleDays);
    if (b === undefined) return undefined;
    if (s.kind === "gap") {
      const own = valueAt(ctx.rates, end);
      return own ? Math.log(b / own) : undefined;
    }
    const start = clamp(addDays(rawEnd, -s.windowDays));
    if (start === end) return 0;
    const a = valueAt(f[s.series], start, s.maxStaleDays);
    if (a === undefined) return undefined;
    return s.transform === "log" ? Math.log(b / a) : b - a;
  };

  const { dates, logs } = ctx.series;
  const X: number[][] = [];
  const y: number[] = [];
  for (let i = Math.max(1, dates.length - 250); i < dates.length; i++) {
    const x = specs.map((s) => feature(s, dates[i]));
    if (x.some((v) => v === undefined)) continue;
    X.push(x as number[]);
    y.push(logs[i] - logs[i - 1]);
  }
  if (y.length < 120) return naive(ctx, H);
  const k = specs.length;
  const rms = specs.map((_, j) => Math.sqrt(mean(X.map((r) => r[j] ** 2))) || 1);
  const Z = X.map((r) => r.map((v, j) => v / rms[j]));
  const A = Array.from({ length: k }, (_, a) => Array.from({ length: k }, (_, b) => Z.reduce((s, r) => s + r[a] * r[b], 0)));
  const zy = Array.from({ length: k }, (_, a) => Z.reduce((s, r, i) => s + r[a] * y[i], 0));
  const beta = ridgeSolve(A, zy, y.length); // λ = n: heavy shrinkage, roughly halves an uncorrelated OLS beta

  const out: number[] = [];
  let cum = last(ctx.series);
  for (let h = 1; h <= H; h++) {
    const target = addDays(ctx.anchorDate, h);
    specs.forEach((s, j) => {
      const x = feature(s, target);
      if (x !== undefined) cum += beta[j] * (x / rms[j]);
    });
    out.push(cum);
  }
  return out;
}

const MACRO_SPECS: (FactorSpec & { pairs?: readonly string[] })[] = MACRO_FACTORS.map((m) => ({
  pairs: "pairs" in m ? m.pairs : undefined,
  series: m.series,
  kind: "move",
  lagDays: m.lagDays,
  windowDays: MACRO_WINDOW_DAYS,
  transform: m.transform,
  maxStaleDays: 7,
  fadeDays: 3650, // effectively never: moves fade on their own (no new data past the known date)
}));

/** US 2-year yield, Brent oil and (SGD→USD only) the broad dollar index, lagged (slow pass-through, e.g. oil → LKR import bill). */
const macro: Model = (ctx, H) =>
  factorModel(ctx, H, MACRO_SPECS.filter((s) => !s.pairs || s.pairs.includes(ctx.pair ?? "")));

/**
 * Sri Lanka data from the central bank (CBSL): the gap between CBSL's official fixing and the pair's
 * Wise rate, CBSL's own recent USD/LKR move, the policy rate, 3-month T-bill yield, and year-on-year
 * remittances and tourism earnings. Only for LKR pairs; equals `naive` elsewhere.
 */
const lanka: Model = (ctx, H) => {
  const specs = LANKA_FACTORS.filter((s) => (s.pairs as readonly string[]).includes(ctx.pair ?? ""));
  return specs.length ? factorModel(ctx, H, specs as unknown as FactorSpec[]) : naive(ctx, H);
};

/** CBSL fixing used by `cbsl_gap` per pair (market_data series, lag 1 day via LANKA_FACTORS). */
const CBSL_FIXING: Record<string, string> = { LKR: "lk_sgd_ind", USDLKR: "lk_usd_spot" };
/** Training window and shrinkage of the gap-closing regression. */
const GAP_TRAIN_DAYS = 365;
const GAP_MIN_OBS = 120;
const GAP_SHRINK = 60; // pseudo-observations at beta = 0

/**
 * Wise vs the central bank's own fixing. gap(t) = ln(CBSL rate on the last day <= t − 1) − ln(Wise rate
 * on t). For each horizon h, a no-intercept regression of the realised move
 * ln(Wise_{t+h} / Wise_t) on gap(t), fitted on past anchors whose outcome is already known (t + h <= anchor),
 * shrunk toward 0. Forecast = today's rate + beta_h × today's gap. Out of sample (fit before 2026-03,
 * test after) it cut SGD→LKR 7-day error by ~6%. Only LKR pairs; equals `naive` elsewhere.
 */
const cbslGap: Model = (ctx, H) => {
  const fixing = ctx.factors?.[CBSL_FIXING[ctx.pair ?? ""] ?? ""];
  if (!fixing?.size) return naive(ctx, H);
  // gap(t) = ln(latest CBSL fixing dated <= t − 1) − ln(Wise rate on t). Both are known at t's sync.
  // (Same-day CBSL vs Wise at t − 1 was the weaker signal: corr. with the next 5 days 0.33 vs 0.47.)
  const gapAt = (t: string): number | undefined => {
    const c = valueAt(fixing, addDays(t, -1), 7);
    const w = ctx.rates.get(t);
    return c !== undefined && w !== undefined ? Math.log(c / w) : undefined;
  };
  const { dates, logs } = ctx.series;
  const n = dates.length;
  const gaps = dates.map((t) => gapAt(t));
  const now = gaps[n - 1];
  if (now === undefined) return naive(ctx, H);
  const base = logs[n - 1];
  const out: number[] = [];
  for (let h = 1; h <= H; h++) {
    let sxy = 0;
    let sxx = 0;
    let k = 0;
    for (let i = Math.max(0, n - 1 - GAP_TRAIN_DAYS); i + h <= n - 1; i++) {
      const g = gaps[i];
      if (g === undefined) continue;
      sxy += g * (logs[i + h] - logs[i]);
      sxx += g * g;
      k++;
    }
    if (k < GAP_MIN_OBS || sxx === 0) {
      out.push(base);
      continue;
    }
    // Ridge toward 0 with GAP_SHRINK pseudo-observations at the mean squared gap.
    const beta = sxy / (sxx + (GAP_SHRINK * sxx) / k);
    out.push(base + Math.max(-1, Math.min(1.5, beta)) * now);
  }
  return out;
};

/**
 * Two-part forecast for SGD→LKR: today's rate moved by the final forecasts of its two legs,
 * SGD→USD and USD→LKR (each learned separately). Equals `naive` when the legs are missing.
 */
const cross: Model = (ctx, H) => {
  const m = ctx.legMoves;
  if (!m || m.length < H) return naive(ctx, H);
  const base = last(ctx.series);
  return Array.from({ length: H }, (_, i) => base + m[i]);
};

/**
 * Random walk plus post-announcement drift (news.ts): for a few days after a classified central-bank
 * decision, add the learned average drift of that category. Equals `naive` on all other days.
 */
const news: Model = (ctx, H) => {
  const base = last(ctx.series);
  if (!ctx.events?.length || !ctx.newsStats?.length) return naive(ctx, H);
  return Array.from(
    { length: H },
    (_, i) => base + newsDriftBetween(ctx.events!, ctx.newsStats!, ctx.anchorDate, addDays(ctx.anchorDate, i + 1)),
  );
};

/**
 * ARIMA(p,1,0) without intercept: AR(p) on daily log returns over the last 250 days, p = 0..5 chosen by
 * BIC, coefficients ridge-shrunk (λ = 0.1·n) and the forecast iterated with future returns predicted
 * recursively, only from stationary fits (Σ|β| < 0.9). p = 0 (BIC's usual pick for FX) is the random walk. Non-trading days (flat returns) stay
 * in the sample: they are part of the observed return process.
 */
const arima: Model = (ctx, H) => {
  const r = diffs(ctx.series.logs.slice(-251));
  const P = 5;
  if (r.length < 120) return naive(ctx, H);
  let best = { bic: Infinity, beta: [] as number[] };
  for (let p = 0; p <= P; p++) {
    const X: number[][] = [];
    const y: number[] = [];
    for (let i = P; i < r.length; i++) {
      X.push(Array.from({ length: p }, (_, j) => r[i - 1 - j]));
      y.push(r[i]);
    }
    const n = y.length;
    const A = Array.from({ length: p }, (_, a) => Array.from({ length: p }, (_, b) => X.reduce((s, x) => s + x[a] * x[b], 0)));
    const xy = Array.from({ length: p }, (_, a) => X.reduce((s, x, i) => s + x[a] * y[i], 0));
    const trace = A.reduce((s, row, i) => s + row[i], 0) / Math.max(p, 1);
    const beta = p ? ridgeSolve(A, xy, 0.1 * trace) : [];
    const sse = y.reduce((s, v, i) => s + (v - X[i].reduce((t, x, j) => t + x * beta[j], 0)) ** 2, 0);
    const bic = n * Math.log(sse / n || 1e-30) + p * Math.log(n);
    // Σ|β| < 0.9 guarantees a stationary AR, so the iterated forecast can't run away (it did for USD→LKR
    // at 31 days without this: 2.6% error vs 0.95% for the random walk).
    if (bic < best.bic && beta.reduce((s, b) => s + Math.abs(b), 0) < 0.9) best = { bic, beta };
  }
  const hist = [...r];
  const out: number[] = [];
  let cum = last(ctx.series);
  for (let h = 1; h <= H; h++) {
    const next = best.beta.reduce((s, b, j) => s + b * hist[hist.length - 1 - j], 0);
    hist.push(next);
    cum += next;
    out.push(cum);
  }
  return out;
};

export const MODELS: Record<string, Model> = {
  naive,
  drift,
  holt,
  monthly_pattern: monthlyPattern,
  mean_reversion: meanReversion,
  market,
  macro,
  news,
  lanka,
  cross,
  cbsl_gap: cbslGap,
  arima,
};

export const MODEL_NAMES = Object.keys(MODELS);

/**
 * Models that are run and scored every day but get weight 0 until they beat the random walk in a
 * horizon bucket (see learning.ts). New external-data models start here: `macro` failed the
 * 2026-11-11 backtest (slightly worse than naive everywhere) and would have diluted the blend.
 */
export const SHADOW_MODELS: readonly string[] = ["macro", "news", "lanka", "cross", "cbsl_gap"];

export const MODEL_LABELS: Record<string, string> = {
  naive: "Random walk",
  drift: "30-day drift",
  holt: "Holt trend",
  monthly_pattern: "Last months' same-day path",
  mean_reversion: "Mean reversion",
  market: "USD-strength (ECB basket)",
  macro: "US yields, oil, dollar index (lagged)",
  arima: "AR on daily returns (ARIMA p,1,0)",
  news: "Post-announcement drift",
  lanka: "Sri Lanka data (CBSL)",
  cross: "Two-part: SGD→USD × USD→LKR",
  cbsl_gap: "Gap to CBSL official rate",
  blend: "Weighted blend (raw)",
  blend_bc: "Blend + bias correction",
  ensemble: "Final (bias-corrected)",
};

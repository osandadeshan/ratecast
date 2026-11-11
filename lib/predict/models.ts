import { MACRO_FACTORS, MACRO_WINDOW_DAYS } from "../config";
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

/**
 * US 2-year yield and Brent oil, lagged. The return on day d is regressed (ridge, no intercept)
 * on each factor's move over MACRO_WINDOW_DAYS ending at d − 1 − lagDays, i.e. information that was
 * public before day d. Future factor moves are unknown and count as zero, so the signal fades
 * within a week of the horizon. Captures slow pass-through (e.g. oil → LKR import bill).
 */
const macro: Model = (ctx, H) => {
  const f = ctx.factors;
  const specs = MACRO_FACTORS.filter((s) => (f?.[s.series]?.size ?? 0) > 0);
  if (!f || !specs.length) return naive(ctx, H);
  const feature = (s: (typeof specs)[number], d: string): number | undefined => {
    const known = addDays(ctx.anchorDate, -s.lagDays);
    const clamp = (x: string) => (x > known ? known : x);
    const end = clamp(addDays(d, -1 - s.lagDays));
    const start = clamp(addDays(d, -1 - s.lagDays - MACRO_WINDOW_DAYS));
    if (start === end) return 0;
    const a = valueAt(f[s.series], start);
    const b = valueAt(f[s.series], end);
    if (a === undefined || b === undefined) return undefined;
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

export const MODELS: Record<string, Model> = {
  naive,
  drift,
  holt,
  monthly_pattern: monthlyPattern,
  mean_reversion: meanReversion,
  market,
  macro,
  news,
};

export const MODEL_NAMES = Object.keys(MODELS);

/**
 * Models that are run and scored every day but get weight 0 until they beat the random walk in a
 * horizon bucket (see learning.ts). New external-data models start here: `macro` failed the
 * 2026-11-11 backtest (slightly worse than naive everywhere) and would have diluted the blend.
 */
export const SHADOW_MODELS: readonly string[] = ["macro", "news"];

export const MODEL_LABELS: Record<string, string> = {
  naive: "Random walk",
  drift: "30-day drift",
  holt: "Holt trend",
  monthly_pattern: "Last months' same-day path",
  mean_reversion: "Mean reversion",
  market: "USD-strength (ECB basket)",
  macro: "US yields + oil (lagged)",
  news: "Post-announcement drift",
  blend: "Weighted blend (raw)",
  blend_bc: "Blend + bias correction",
  ensemble: "Final (bias-corrected)",
};

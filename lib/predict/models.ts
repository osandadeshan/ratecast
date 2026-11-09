import { addDays, addMonths } from "../dates";
import { type Series, diffs, mean, valueAt } from "./series";

export interface ModelContext {
  series: Series; // log rates, last element = anchor (made_on)
  rates: Map<string, number>; // raw known rates (only <= anchor are used)
  basket: Map<string, number>; // USD strength basket (log), known <= anchor
  anchorDate: string;
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

export const MODELS: Record<string, Model> = {
  naive,
  drift,
  holt,
  monthly_pattern: monthlyPattern,
  mean_reversion: meanReversion,
  market,
};

export const MODEL_NAMES = Object.keys(MODELS);

export const MODEL_LABELS: Record<string, string> = {
  naive: "Random walk",
  drift: "30-day drift",
  holt: "Holt trend",
  monthly_pattern: "Last months' same-day path",
  mean_reversion: "Mean reversion",
  market: "USD-strength (ECB basket)",
  blend: "Weighted blend (raw)",
  blend_bc: "Blend + bias correction",
  ensemble: "Final (bias-corrected)",
};

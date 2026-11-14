import assert from "node:assert/strict";
import { test } from "node:test";
import { addDays } from "@/lib/dates";
import { MODELS, type ModelContext } from "@/lib/predict/models";
import { buildSeries } from "@/lib/predict/series";

const ANCHOR = "2026-11-11";

/**
 * Synthetic USD→LKR where Wise closes half of yesterday's gap to the CBSL fixing every day:
 * ln W_{t+1} = ln W_t + 0.5 · ln(C_{t} / W_{t}) and the fixing wanders on its own.
 */
function world(days = 400) {
  const rates = new Map<string, number>();
  const fixing = new Map<string, number>();
  let w = Math.log(300);
  let c = Math.log(300);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.01;
  for (let i = days; i >= 0; i--) {
    const d = addDays(ANCHOR, -i);
    rates.set(d, Math.exp(w));
    fixing.set(d, Math.exp(c));
    w += 0.5 * (c - w);
    c += rnd();
  }
  return { rates, fixing };
}

function ctx(rates: Map<string, number>, fixing: Map<string, number>, pair = "USDLKR"): ModelContext {
  return {
    series: buildSeries(rates, ANCHOR, 400),
    rates,
    basket: new Map(),
    anchorDate: ANCHOR,
    factors: { lk_usd_spot: fixing, lk_sgd_ind: fixing },
    pair,
  };
}

test("cbsl_gap: learns gap closing and moves toward the fixing", () => {
  const { rates, fixing } = world();
  // Today's gap: the fixing of yesterday vs Wise of yesterday.
  const y = addDays(ANCHOR, -1);
  const gap = Math.log(fixing.get(y)! / rates.get(y)!);
  const out = MODELS.cbsl_gap(ctx(rates, fixing), 7);
  const move = out[6] - Math.log(rates.get(ANCHOR)!);
  assert.ok(Math.abs(gap) > 0, "test world must have a gap");
  assert.equal(Math.sign(move), Math.sign(gap), "forecast moves toward the CBSL fixing");
});

test("cbsl_gap: ignores fixings dated on or after the anchor (no look-ahead)", () => {
  const { rates, fixing } = world();
  const a = MODELS.cbsl_gap(ctx(rates, fixing), 10);
  const tampered = new Map(fixing);
  tampered.set(ANCHOR, 999);
  for (let h = 1; h <= 10; h++) tampered.set(addDays(ANCHOR, h), 999);
  const b = MODELS.cbsl_gap(ctx(rates, tampered), 10);
  assert.deepEqual(a, b);
});

test("cbsl_gap: equals naive for pairs without a CBSL fixing", () => {
  const { rates, fixing } = world();
  const c = ctx(rates, fixing, "USD");
  assert.deepEqual(MODELS.cbsl_gap(c, 5), MODELS.naive(c, 5));
});

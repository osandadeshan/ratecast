import assert from "node:assert/strict";
import { test } from "node:test";
import { addDays } from "@/lib/dates";
import { compareVersions, runBacktest, type BacktestResult } from "@/lib/predict/backtest";
import type { LearnedStats } from "@/lib/predict/learning";
import { combineLegMoves, factorsAt, learningChanges } from "@/lib/predict/replay";

const TODAY = "2026-11-13";

/** A random walk with a fixed seed, ~0.3% daily moves. */
function walk(days: number, seed = 7): Map<string, number> {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647) - 0.5;
  const out = new Map<string, number>();
  let v = 100;
  for (let i = days; i >= 0; i--) {
    v *= Math.exp(rnd() * 0.01);
    out.set(addDays(TODAY, -i), v);
  }
  return out;
}

test("backtest of a random walk: the final forecast is scored against naive on the same forecasts", () => {
  const official = walk(800);
  const r = runBacktest([{ pair: "X", official, basket: new Map(), factors: {}, events: [] }], {}, TODAY);
  assert.equal(r.complete, true);
  assert.equal(r.pairs.length, 1);
  const p = r.pairs[0];
  assert.ok(p.overall.n > 1000);
  // Nothing can beat a true random walk significantly, so the gated ensemble stays (almost) naive.
  assert.ok(Math.abs(p.overall.skill - 1) < 0.02, `skill ${p.overall.skill}`);
  for (const b of p.buckets) assert.ok(b.coverage > 50 && b.coverage < 100, `coverage ${b.coverage}`);
});

test("backtest is look-ahead free: changing data on or after today does not change the result", () => {
  const a = walk(800);
  const b = new Map(a);
  b.set(TODAY, 1e6);
  b.set(addDays(TODAY, 3), 1e-6);
  const run = (official: Map<string, number>) =>
    runBacktest([{ pair: "X", official, basket: new Map(), factors: {}, events: [] }], {}, TODAY).pairs[0].overall;
  assert.deepEqual(run(a), run(b));
});

test("backtest stops when the deadline has passed", () => {
  const r = runBacktest([{ pair: "X", official: walk(800), basket: new Map(), factors: {}, events: [] }], {}, TODAY, 0);
  assert.equal(r.complete, false);
});

test("compareVersions uses skill vs the random walk with a 0.5% dead zone", () => {
  const res = (skill: number): BacktestResult => ({
    from: "",
    to: "",
    scoreFrom: "",
    complete: true,
    pairs: [{ pair: "X", buckets: [], overall: { n: 1, mae: skill, naiveMae: 1, skill, coverage: 80 } }],
  });
  assert.equal(compareVersions(res(0.98), res(1))[0].verdict, "better");
  assert.equal(compareVersions(res(1.003), res(1))[0].verdict, "same");
  assert.equal(compareVersions(res(1.01), res(1))[0].verdict, "worse");
});

test("learningChanges reports promotions and demotions per bucket", () => {
  const stats = (promoted: Record<string, boolean>, biasOn: number): LearnedStats =>
    ({ asOf: "", windowDays: 180, buckets: [{ bucket: 7, promoted, biasOn, t: { holt: -3, blend_bc: -2.7 } }] }) as unknown as LearnedStats;
  assert.deepEqual(learningChanges(undefined, stats({ holt: true }, 0)), []);
  assert.deepEqual(learningChanges(stats({ holt: false }, 0), stats({ holt: true }, 1)), [
    { bucket: 7, item: "holt", change: "promoted", t: -3 },
    { bucket: 7, item: "bias_correction", change: "promoted", t: -2.7 },
  ]);
  assert.deepEqual(learningChanges(stats({ holt: true }, 0), stats({ holt: false }, 0))[0].change, "demoted");
});

test("combineLegMoves sums the legs' log moves and needs both", () => {
  const path = Array.from({ length: 31 }, () => 110);
  const m = combineLegMoves([
    { path, anchor: 100 },
    { path, anchor: 100 },
  ])!;
  assert.ok(Math.abs(m[0] - 2 * Math.log(1.1)) < 1e-12);
  assert.equal(combineLegMoves([{ path, anchor: 100 }, { path: undefined, anchor: 100 }]), undefined);
});

test("factorsAt applies each factor's publication lag", () => {
  const brent = new Map([
    ["2026-11-01", 1],
    ["2026-11-05", 2],
  ]);
  // brent lag is 9 days: on 2026-11-13 only data up to 2026-11-04 was public.
  assert.deepEqual([...factorsAt({ brent }, TODAY).brent.keys()], ["2026-11-01"]);
});

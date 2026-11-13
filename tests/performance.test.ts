import assert from "node:assert/strict";
import { test } from "node:test";
import { addDays } from "@/lib/dates";
import { type ScoredRow, computePerformance, direction } from "@/lib/performance";
import { near } from "./helpers";

const TODAY = "2026-11-13";

function row(model: string, h: number, target: string, predicted: number, actual: number, extra: Partial<ScoredRow> = {}): ScoredRow {
  return {
    model,
    horizon: h,
    madeOn: addDays(target, -h),
    targetDate: target,
    predicted,
    actual,
    pct: ((predicted - actual) / actual) * 100,
    lower80: null,
    upper80: null,
    origin: "replay",
    ...extra,
  };
}

test("metrics: MAPE, RMSE, MAE and the baseline on the same dates", () => {
  const rows = [
    row("ensemble", 1, "2026-11-12", 101, 100),
    row("ensemble", 1, "2026-11-11", 98, 100),
    row("naive", 1, "2026-11-12", 100, 100),
    row("naive", 1, "2026-11-11", 104, 100),
  ];
  const p = computePerformance(rows, TODAY, []);
  const w7 = p.windows.find((w) => w.days === 7)!;
  assert.equal(w7.n, 2);
  near(w7.mape!, 1.5);
  near(w7.rmse!, Math.sqrt((1 + 4) / 2));
  near(w7.mae!, 1.5);
  near(w7.naiveMape!, 2);
});

test("non-trading weekdays and future targets are left out", () => {
  // 2026-11-08 is a Sunday.
  const rows = [row("ensemble", 1, "2026-11-08", 110, 100), row("ensemble", 1, "2026-11-14", 110, 100), row("ensemble", 1, "2026-11-10", 101, 100)];
  const p = computePerformance(rows, TODAY, [0]);
  assert.equal(p.windows[0].n, 1);
});

test("coverage counts actuals inside the 80% band", () => {
  const rows = [
    row("ensemble", 7, "2026-11-12", 100, 100, { lower80: 99, upper80: 101 }),
    row("ensemble", 7, "2026-11-11", 100, 102, { lower80: 99, upper80: 101 }),
  ];
  const h7 = computePerformance(rows, TODAY, []).horizons.find((h) => h.horizon === 7)!;
  near(h7.coverage!, 50);
});

test("bias: consistent overprediction is detected, noise is not", () => {
  const high: ScoredRow[] = [];
  const noise: ScoredRow[] = [];
  for (let i = 1; i <= 40; i++) {
    const d = addDays(TODAY, -i);
    high.push(row("ensemble", 1, d, 100.3 + (i % 3) * 0.05, 100));
    noise.push(row("ensemble", 1, d, i % 2 ? 100.3 : 99.7, 100));
  }
  assert.equal(computePerformance(high, TODAY, []).bias.verdict, "too high");
  assert.equal(computePerformance(noise, TODAY, []).bias.verdict, "none");
});

test("trend: equal to the baseline every day means no clear change", () => {
  const rows: ScoredRow[] = [];
  for (let i = 1; i <= 60; i++) {
    const d = addDays(TODAY, -i);
    const p = 100 + Math.sin(i);
    rows.push(row("ensemble", 1, d, p, 100), row("naive", 1, d, p, 100));
  }
  const t = computePerformance(rows, TODAY, []).trend;
  assert.equal(t.verdict, "no clear change");
  near(t.recent!, 0);
});

test("trend: a forecast that pulls ahead of the baseline is 'improving'", () => {
  const rows: ScoredRow[] = [];
  for (let i = 1; i <= 60; i++) {
    const d = addDays(TODAY, -i);
    const recent = i <= 30;
    const err = recent ? 0.1 + (i % 4) * 0.01 : 0.5 + (i % 4) * 0.01;
    rows.push(row("ensemble", 1, d, 100 + err, 100), row("naive", 1, d, 100.5, 100));
  }
  assert.equal(computePerformance(rows, TODAY, []).trend.verdict, "improving");
});

test("origin counts live vs replayed forecasts", () => {
  const rows = [row("ensemble", 1, "2026-11-12", 100, 100, { origin: "live" }), row("ensemble", 1, "2026-11-11", 100, 100)];
  assert.deepEqual(computePerformance(rows, TODAY, []).origin, { live: 1, replay: 1 });
});

test("direction only when today's rate is outside the forecast's 80% range", () => {
  assert.equal(direction(100, 100.1, 99, 101), "no clear direction");
  assert.equal(direction(98, 100, 99, 101), "up");
  assert.equal(direction(102, 100, 99, 101), "down");
  assert.equal(direction(null, 100, 99, 101), null);
});

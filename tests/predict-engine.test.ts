import assert from "node:assert/strict";
import { test } from "node:test";
import { addDays } from "../lib/dates";
import { detectNonTradingDow, dowOf } from "../lib/predict/calendar";
import { forecast } from "../lib/predict/engine";
import { ErrorIndex, learn, tBar } from "../lib/predict/learning";

const ANCHOR = "2026-06-30";

/** 120 daily rates ending at ANCHOR with a steady daily log move. */
function trending(dailyLog: number, start = 300): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 119; i >= 0; i--) m.set(addDays(ANCHOR, -i), start * Math.exp(dailyLog * (119 - i) + 0.001 * Math.sin(i)));
  return m;
}

test("tBar: Student-t bar is stricter than 2.6 for small samples and never below it", () => {
  assert.ok(tBar(5) > 4);
  assert.ok(tBar(10) > 3 && tBar(10) < tBar(5));
  assert.equal(tBar(1000), 2.6);
  for (const n of [5, 8, 13, 30, 61, 200]) assert.ok(tBar(n) >= 2.6);
});

test("forecast: LKR pairs stretch only the side the 30-day trend points to; SGD→USD stays symmetric", () => {
  const rates = trending(-0.002); // falling rate
  const stats = learn(new ErrorIndex(), ANCHOR);
  const ens = (pair: string) => forecast({ rates, basket: new Map(), anchorDate: ANCHOR, stats, pair, horizon: 14 })
    .filter((r) => r.model === "ensemble" && r.horizon === 14)[0];
  const lkr = ens("USDLKR");
  const usd = ens("USD");
  const down = (r: typeof lkr) => Math.log(r.predicted / r.lower80!);
  const up = (r: typeof lkr) => Math.log(r.upper80! / r.predicted);
  assert.ok(Math.abs(down(usd) - up(usd)) < 1e-12, "SGD→USD band is symmetric");
  assert.ok(down(lkr) > up(lkr) + 1e-4, "USD→LKR: falling trend widens the lower side");
  assert.ok(Math.abs(up(lkr) - up(usd)) < 1e-12, "the other side is unchanged");
  assert.equal(lkr.predicted, usd.predicted, "point forecast is not affected");
});

test("forecast: every stored value is finite", () => {
  const rates = trending(0.001);
  const stats = learn(new ErrorIndex(), ANCHOR);
  const rows = forecast({ rates, basket: new Map(), anchorDate: ANCHOR, stats, pair: "LKR" });
  assert.ok(rows.length > 0);
  for (const r of rows) assert.ok(Number.isFinite(r.predicted) && r.predicted > 0, `${r.model} h${r.horizon}`);
});

test("detectNonTradingDow: a weekday that moved on 2 of its last 4 occurrences is no longer non-trading", () => {
  const rates = new Map<string, number>();
  let v = 300;
  const start = addDays(ANCHOR, -200);
  const moveFrom = addDays(ANCHOR, -21); // the source starts moving on Sundays 3 weeks ago
  for (let d = start; d <= ANCHOR; d = addDays(d, 1)) {
    if (dowOf(d) !== 0 || d >= moveFrom) v *= Math.exp(0.001 * Math.sin(rates.size));
    rates.set(d, v);
  }
  assert.deepEqual(detectNonTradingDow(rates, addDays(ANCHOR, -28)), [0]);
  assert.deepEqual(detectNonTradingDow(rates, ANCHOR), []);
});

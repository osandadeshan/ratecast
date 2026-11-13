import assert from "node:assert/strict";
import { test } from "node:test";
import { crossGap, validateHistory, validateLive } from "@/lib/sources/validate";
import { near } from "./helpers";

test("validateHistory: drops non-positive, NaN and bad dates", () => {
  const { ok, rejected } = validateHistory("LKR", [
    { date: "2026-11-01", rate: 258 },
    { date: "2026-11-02", rate: 0 },
    { date: "2026-11-03", rate: Number.NaN },
    { date: "2026/11/04", rate: 258 },
    { date: "2026-11-05", rate: 259 },
  ]);
  assert.deepEqual(ok.map((p) => p.date), ["2026-11-01", "2026-11-05"]);
  assert.equal(rejected.length, 3);
});

test("validateHistory: rejects a jump beyond the limit but keeps the series going", () => {
  const { ok, rejected } = validateHistory("USD", [
    { date: "2026-11-01", rate: 0.78 },
    { date: "2026-11-02", rate: 0.078 }, // a misplaced decimal
    { date: "2026-11-03", rate: 0.781 },
  ]);
  assert.deepEqual(ok.map((p) => p.date), ["2026-11-01", "2026-11-03"]);
  assert.match(rejected[0].reason, /jump/);
});

test("validateHistory: real moves of 4.6% (the 2-year max for LKR pairs) pass", () => {
  const { ok } = validateHistory("LKR", [{ date: "2026-11-02", rate: 258 * 1.046 }], { date: "2026-11-01", rate: 258 });
  assert.equal(ok.length, 1);
});

test("validateHistory: checks the first new point against the last stored one", () => {
  const { ok } = validateHistory("USD", [{ date: "2026-11-02", rate: 1.2 }], { date: "2026-11-01", rate: 0.78 });
  assert.equal(ok.length, 0);
});

test("validateLive", () => {
  assert.equal(validateLive("USDLKR", 332, { date: "2026-11-12", rate: 331 }), null);
  assert.match(validateLive("USDLKR", 33.2, { date: "2026-11-12", rate: 331 })!, /%/);
  assert.match(validateLive("USD", -1)!, /positive/);
  assert.equal(validateLive("USD", 0.78), null);
});

test("crossGap is ~0 for consistent quotes", () => {
  near(crossGap(258.333, 0.77694, 258.333 / 0.77694), 0, 1e-12);
  assert.ok(crossGap(260, 0.77694, 332.5) > 0.005);
});

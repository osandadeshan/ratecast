import assert from "node:assert/strict";
import { test } from "node:test";
import { FACTOR_LAGS } from "@/lib/config";
import { parseFredCsv } from "@/lib/sources/macro";

test("DTWEXBGS CSV: skips missing values", () => {
  const csv = "observation_date,DTWEXBGS\n2026-11-02,120.51\n2026-11-03,.\n2026-11-04,120.9\n";
  assert.deepEqual(parseFredCsv(csv), [
    { date: "2026-11-02", value: 120.51 },
    { date: "2026-11-04", value: 120.9 },
  ]);
});

test("broad dollar index is lagged for the weekly H.10 release", () => {
  assert.ok(FACTOR_LAGS.usd_broad >= 8);
});

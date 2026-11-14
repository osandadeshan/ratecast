import { test } from "node:test";
import assert from "node:assert/strict";
import { allPairsForecast } from "../lib/sync";

test("allPairsForecast: every pair needs today's ensemble forecast", () => {
  assert.equal(allPairsForecast(["LKR", "USD", "USDLKR"]), true);
  assert.equal(allPairsForecast(["USDLKR", "LKR", "USD", "LKR"]), true);
  // An old-code run before a deploy that added USD→LKR: ok run, but the new pair is missing.
  assert.equal(allPairsForecast(["LKR", "USD"]), false);
  assert.equal(allPairsForecast([]), false);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { addMonths } from "../lib/dates";

// The chart window and the "same day last month" label depend on addMonths clamping (Mar 31 → Feb 28).
test("addMonths clamps to the shorter month, which the page labels as 'its last day'", () => {
  assert.equal(addMonths("2026-03-31", -1), "2026-02-28");
  assert.equal(addMonths("2026-03-15", -1), "2026-02-15");
  assert.equal(addMonths("2026-01-31", -1), "2025-12-31");
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { addDays, addMonths, dateRange, diffDays, monthBounds, parseISO, toISO, todayISO } from "@/lib/dates";

test("todayISO uses Singapore time, not UTC", () => {
  assert.equal(todayISO(new Date("2026-11-10T15:59:59Z")), "2026-11-10"); // 23:59 SGT
  assert.equal(todayISO(new Date("2026-11-10T16:00:00Z")), "2026-11-11"); // 00:00 SGT next day
});

test("addDays crosses months, years and leap days", () => {
  assert.equal(addDays("2026-01-31", 1), "2026-02-01");
  assert.equal(addDays("2026-01-01", -1), "2025-12-31");
  assert.equal(addDays("2024-02-28", 1), "2024-02-29");
  assert.equal(addDays("2025-02-28", 1), "2025-03-01");
  assert.equal(addDays("2026-11-11", 0), "2026-11-11");
});

test("diffDays is the inverse of addDays", () => {
  assert.equal(diffDays("2026-03-01", "2026-02-01"), 28);
  assert.equal(diffDays("2026-02-01", "2026-03-01"), -28);
  assert.equal(diffDays(addDays("2026-06-15", 400), "2026-06-15"), 400);
});

test("parseISO / toISO round-trip at UTC midnight", () => {
  assert.equal(toISO(parseISO("2026-11-11")), "2026-11-11");
  assert.equal(parseISO("1970-01-02"), 86_400_000);
});

test("addMonths clamps to the month length", () => {
  assert.equal(addMonths("2026-03-31", -1), "2026-02-28");
  assert.equal(addMonths("2024-03-31", -1), "2024-02-29");
  assert.equal(addMonths("2026-01-15", -1), "2025-12-15");
  assert.equal(addMonths("2026-10-31", 1), "2026-11-30");
});

test("monthBounds and dateRange", () => {
  assert.deepEqual(monthBounds("2024-02-10"), { start: "2024-02-01", end: "2024-02-29" });
  assert.deepEqual(monthBounds("2026-12-31"), { start: "2026-12-01", end: "2026-12-31" });
  assert.deepEqual(dateRange("2026-02-27", "2026-03-01"), ["2026-02-27", "2026-02-28", "2026-03-01"]);
  assert.deepEqual(dateRange("2026-03-02", "2026-03-01"), []);
});

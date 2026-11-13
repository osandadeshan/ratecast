import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCcpiYoy } from "@/lib/sources/srilanka";

test("parseCcpiYoy reads the headline CCPI year-on-year column by its header", () => {
  const rows: Record<string, string>[] = [
    { B: "Movements of the Colombo Consumer Price Index (CCPI) (2021=100)" },
    { B: "Period", C: "Index", E: "Monthly % Change", G: "Year-on-Year % Change", I: "Annual Average % Change" },
    { C: "CCPI", D: "CCPI Core", E: "CCPI", F: "CCPI Core", G: "CCPI", H: "CCPI Core" },
    { B: "2026 September", C: "209.1", G: "8" },
    { B: "2026 October", C: "209.9", G: "8.3000000000000007" },
    { B: "2026 September", C: "209.1", G: "8" },
    { J: "Source: Department of Census and Statistics" },
  ];
  assert.deepEqual(parseCcpiYoy(rows), [
    { date: "2026-09-30", value: 8 },
    { date: "2026-10-31", value: 8.3 },
  ]);
});

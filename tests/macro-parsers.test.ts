import assert from "node:assert/strict";
import { test } from "node:test";
import { parseFredCsv, parseTreasuryCsv } from "@/lib/sources/macro";

test("parseTreasuryCsv finds '2 Yr' by header name (2024 layout)", () => {
  const csv = [
    'Date,"1 Mo","2 Mo","3 Mo","4 Mo","6 Mo","1 Yr","2 Yr","3 Yr"',
    "01/03/2024,5.54,5.54,5.48,5.41,5.25,4.81,4.33,4.07",
    "01/02/2024,5.55,5.54,5.46,5.41,5.24,4.80,4.33,4.09",
  ].join("\n");
  assert.deepEqual(parseTreasuryCsv(csv), [
    { date: "2024-01-02", value: 4.33 },
    { date: "2024-01-03", value: 4.33 },
  ]);
});

test("parseTreasuryCsv copes with an extra column (2025+ layout) and CRLF", () => {
  const csv = [
    'Date,"1 Mo","1.5 Month","2 Mo","3 Mo","4 Mo","6 Mo","1 Yr","2 Yr","3 Yr"',
    "11/10/2026,4.05,4.16,4.21,4.30,4.28,4.38,4.56,4.73,4.74",
    "11/09/2026,4.04,4.13,4.19,4.24,4.20,4.26,4.38,4.56,4.58",
  ].join("\r\n");
  assert.deepEqual(parseTreasuryCsv(csv), [
    { date: "2026-11-09", value: 4.56 },
    { date: "2026-11-10", value: 4.73 },
  ]);
});

test("parseTreasuryCsv can read another column and skips blank cells and junk rows", () => {
  const csv = ['Date,"1 Mo","1.5 Month","2 Yr"', "01/02/2025,4.45,,4.25", "01/03/2025,4.44,4.40,", "N/A,1,2,3", ""].join("\n");
  assert.deepEqual(parseTreasuryCsv(csv), [{ date: "2025-01-02", value: 4.25 }]);
  assert.deepEqual(parseTreasuryCsv(csv, "1.5 Month"), [{ date: "2025-01-03", value: 4.4 }]);
});

test("parseTreasuryCsv returns nothing when the column is missing or the body is not CSV", () => {
  assert.deepEqual(parseTreasuryCsv('Date,"1 Mo"\n01/02/2025,4.45'), []);
  assert.deepEqual(parseTreasuryCsv("<html><title>Maintenance</title></html>"), []);
  assert.deepEqual(parseTreasuryCsv(""), []);
});

test("parseFredCsv skips the header and '.' (missing) rows", () => {
  const csv = "observation_date,DCOILBRENTEU\n2026-10-30,120.15\n2026-11-01,.\n2026-11-02,107.39\n2026-11-03,107.03\n";
  assert.deepEqual(parseFredCsv(csv), [
    { date: "2026-10-30", value: 120.15 },
    { date: "2026-11-02", value: 107.39 },
    { date: "2026-11-03", value: 107.03 },
  ]);
});

test("parseFredCsv drops non-positive values, bad dates and non-CSV bodies", () => {
  assert.deepEqual(parseFredCsv("observation_date,X\n2026-11-02,0\n2026-11-03,-1\n11/04/2026,5\n2026-11-05,abc"), []);
  assert.deepEqual(parseFredCsv("<!DOCTYPE html><html></html>"), []);
  assert.deepEqual(parseFredCsv(""), []);
});

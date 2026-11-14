import assert from "node:assert/strict";
import { test } from "node:test";
import { type WiseComparison, parseWiseComparison } from "@/lib/sources/wise";

const quote = (rate: number, received: number, mid: boolean) => ({
  rate,
  fee: 1,
  receivedAmount: received,
  markup: 0,
  isConsideredMidMarketRate: mid,
  dateCollected: "2026-11-14T03:45:22Z",
});

test("live mid is Wise's own quote even when another provider is flagged mid-market and listed first", () => {
  const data: WiseComparison = {
    providers: [
      { name: "Remitly", alias: "remitly", quotes: [quote(332.46, 331798, true)] },
      { name: "Wise", alias: "wise", quotes: [quote(332.59, 328479, true)] },
    ],
  };
  const q = parseWiseComparison("USDLKR", data);
  assert.equal(q.midRate, 332.59);
  assert.equal(q.providers[0].alias, "remitly"); // still sorted by amount received
});

test("falls back to another mid-market quote only when Wise is missing", () => {
  const data: WiseComparison = { providers: [{ name: "Remitly", alias: "remitly", quotes: [quote(332.46, 331798, true)] }] };
  assert.equal(parseWiseComparison("USDLKR", data).midRate, 332.46);
});

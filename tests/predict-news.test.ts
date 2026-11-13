import assert from "node:assert/strict";
import { test } from "node:test";
import { addDays } from "@/lib/dates";
import type { EventRecord } from "@/lib/predict/events";
import { DRIFT_DAYS, type NewsDriftStat, categoryOf, learnNewsDrift, newsDriftBetween } from "@/lib/predict/news";
import { near } from "./helpers";

const AS_OF = "2026-11-11";

function ev(kind: string, eventDate: string, outcome: string | null): EventRecord {
  return { kind, eventDate, knownSince: eventDate, source: "test", title: kind, url: null, outcome };
}

/** Rates that are flat except for a log drift `d` between E+1 and E+1+DRIFT_DAYS of each event. */
function ratesWithDrift(events: { date: string; drift: number }[]): Map<string, number> {
  const rates = new Map<string, number>();
  for (const e of events) {
    rates.set(addDays(e.date, 1), 250);
    rates.set(addDays(e.date, 1 + DRIFT_DAYS), 250 * Math.exp(e.drift));
  }
  return rates;
}

test("the drift window is 5 days", () => assert.equal(DRIFT_DAYS, 5));

test("categoryOf joins kind and outcome, and ignores missing or unclear outcomes", () => {
  assert.equal(categoryOf(ev("fomc", AS_OF, "cut")), "fomc:cut");
  assert.equal(categoryOf(ev("cbsl_policy", AS_OF, "hold")), "cbsl_policy:hold");
  assert.equal(categoryOf(ev("fomc", AS_OF, "unclear")), null);
  assert.equal(categoryOf(ev("fomc", AS_OF, null)), null);
  assert.equal(categoryOf({ ...ev("fomc", AS_OF, null), outcome: undefined }), null);
});

test("learnNewsDrift: mean drift from E+1 to E+6, shrunk by 8 zero pseudo-events", () => {
  const dates = ["2026-06-17", "2026-07-29", "2026-09-16"];
  const rates = ratesWithDrift(dates.map((date) => ({ date, drift: 0.011 })));
  const stats = learnNewsDrift(rates, dates.map((d) => ev("fomc", d, "cut")), AS_OF);
  assert.equal(stats.length, 1);
  assert.equal(stats[0].category, "fomc:cut");
  assert.equal(stats[0].n, 3);
  near(stats[0].drift, (3 * 0.011) / (3 + 8), 1e-12);
});

test("learnNewsDrift: one stat per category, sorted, signs kept", () => {
  const cut = ["2026-06-17", "2026-07-29"];
  const hold = ["2026-05-26", "2026-07-22", "2026-09-30"];
  const rates = ratesWithDrift([
    ...cut.map((date) => ({ date, drift: 0.004 })),
    ...hold.map((date) => ({ date, drift: -0.002 })),
  ]);
  const stats = learnNewsDrift(
    rates,
    [...cut.map((d) => ev("fomc", d, "cut")), ...hold.map((d) => ev("cbsl_policy", d, "hold"))],
    AS_OF,
  );
  assert.deepEqual(stats.map((s) => [s.category, s.n]), [["cbsl_policy:hold", 3], ["fomc:cut", 2]]);
  near(stats[0].drift, (3 * -0.002) / 11, 1e-12);
  near(stats[1].drift, (2 * 0.004) / 10, 1e-12);
});

test("learnNewsDrift: no look-ahead, an event counts only when its whole window is in the past", () => {
  const open = addDays(AS_OF, -DRIFT_DAYS); // window ends at AS_OF + 1
  const closed = addDays(AS_OF, -DRIFT_DAYS - 1); // window ends exactly at AS_OF
  const rates = ratesWithDrift([{ date: open, drift: 0.01 }, { date: closed, drift: 0.01 }]);
  const stats = learnNewsDrift(rates, [ev("fomc", open, "hike"), ev("fomc", closed, "hike")], AS_OF);
  assert.equal(stats[0].n, 1);
  assert.equal(learnNewsDrift(rates, [ev("fomc", open, "hike")], AS_OF).length, 0);
});

test("learnNewsDrift: ignores unclassified, unclear, duplicate, too-old and rate-less events", () => {
  const good = "2026-09-16";
  const rates = ratesWithDrift([{ date: good, drift: 0.01 }, { date: addDays(AS_OF, -800), drift: 0.01 }]);
  const events = [
    ev("fomc", good, "cut"),
    ev("fomc", good, "cut"), // duplicate
    ev("fomc", "2026-07-29", null),
    ev("fomc", "2026-06-17", "unclear"),
    ev("fomc", addDays(AS_OF, -800), "cut"), // beyond the 730-day lookback
    ev("fomc", "2025-03-19", "cut"), // no rates around it
  ];
  const stats = learnNewsDrift(rates, events, AS_OF);
  assert.deepEqual(stats.map((s) => [s.category, s.n]), [["fomc:cut", 1]]);
});

const E = "2026-03-10"; // outcome public from 03-11, window (03-11, 03-16]
const STATS: NewsDriftStat[] = [{ category: "fomc:cut", n: 3, drift: 0.005 }]; // 0.001 per day
const EVENTS = [ev("fomc", E, "cut")];

test("newsDriftBetween: nothing on the announcement day itself (outcome is public from E+1)", () => {
  assert.equal(newsDriftBetween(EVENTS, STATS, E, addDays(E, 1)), 0);
  assert.equal(newsDriftBetween(EVENTS, STATS, E, addDays(E, 10)), 0);
  assert.equal(newsDriftBetween(EVENTS, STATS, addDays(E, -3), addDays(E, 10)), 0);
});

test("newsDriftBetween: adds drift/5 per day from the anchor until the window ends", () => {
  near(newsDriftBetween(EVENTS, STATS, "2026-03-11", "2026-03-12"), 0.001);
  near(newsDriftBetween(EVENTS, STATS, "2026-03-11", "2026-03-16"), 0.005);
  near(newsDriftBetween(EVENTS, STATS, "2026-03-11", "2026-03-31"), 0.005); // capped at the window end
  near(newsDriftBetween(EVENTS, STATS, "2026-03-14", "2026-03-20"), 0.002); // 2 days left
  near(newsDriftBetween(EVENTS, STATS, "2026-03-15", "2026-03-16"), 0.001);
});

test("newsDriftBetween: nothing once the window has closed", () => {
  assert.equal(newsDriftBetween(EVENTS, STATS, "2026-03-16", "2026-03-20"), 0);
  assert.equal(newsDriftBetween(EVENTS, STATS, "2026-04-01", "2026-04-10"), 0);
});

test("newsDriftBetween: needs at least 3 past events, a matching category and a classified outcome", () => {
  const anchor = "2026-03-11";
  const target = "2026-03-13";
  assert.equal(newsDriftBetween(EVENTS, [{ category: "fomc:cut", n: 2, drift: 0.005 }], anchor, target), 0);
  assert.equal(newsDriftBetween(EVENTS, [{ category: "fomc:hold", n: 9, drift: 0.005 }], anchor, target), 0);
  assert.equal(newsDriftBetween([ev("fomc", E, "unclear")], STATS, anchor, target), 0);
  assert.equal(newsDriftBetween([ev("fomc", E, null)], STATS, anchor, target), 0);
  assert.equal(newsDriftBetween([], STATS, anchor, target), 0);
});

test("newsDriftBetween: overlapping announcements add up", () => {
  const stats: NewsDriftStat[] = [...STATS, { category: "cbsl_policy:hold", n: 9, drift: -0.01 }];
  const events = [...EVENTS, ev("cbsl_policy", "2026-03-11", "hold")]; // window (03-12, 03-17]
  near(newsDriftBetween(events, stats, "2026-03-12", "2026-03-14"), 2 * 0.001 + 2 * -0.002);
});

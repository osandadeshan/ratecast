import assert from "node:assert/strict";
import { test } from "node:test";
import { addDays } from "@/lib/dates";
import { type EventRecord, type EventVolStat, eventExtraVar, learnEventVol } from "@/lib/predict/events";
import { near } from "./helpers";

const AS_OF = "2026-11-11"; // a Wednesday

function ev(kind: string, eventDate: string, knownSince = addDays(eventDate, -300)): EventRecord {
  return { kind, eventDate, knownSince, source: "test", title: kind, url: null };
}

/**
 * Daily rates for `days` days ending at AS_OF. Ordinary days follow a +a, +a, −a, −a cycle (so
 * 2-day moves are non-zero); `overrides` sets the log move INTO a given date.
 */
function path(days: number, overrides: Record<string, number> = {}, a = 0.001): Map<string, number> {
  const rates = new Map<string, number>();
  let log = Math.log(250);
  const cycle = [a, a, -a, -a];
  for (let i = days; i >= 0; i--) {
    const d = addDays(AS_OF, -i);
    if (i !== days) log += overrides[d] ?? cycle[(days - i) % 4];
    rates.set(d, Math.exp(log));
  }
  return rates;
}

const move = (rates: Map<string, number>, e: string) => Math.log(rates.get(addDays(e, 1))! / rates.get(addDays(e, -1))!);
const stat = (s: EventVolStat[], kind: string) => s.find((x) => x.kind === kind)!;

/** `n` Wednesdays, 4 weeks apart, the latest one 3 weeks before AS_OF. */
const wednesdays = (n: number) => Array.from({ length: n }, (_, i) => addDays(AS_OF, -21 - 28 * i));

test("learnEventVol returns one stat per known kind, ratio 1 when there are no events", () => {
  const stats = learnEventVol(path(760), [], AS_OF);
  assert.deepEqual(stats.map((s) => s.kind).sort(), ["cbsl_policy", "fomc", "imf"]);
  for (const s of stats) {
    assert.equal(s.n, 0);
    assert.equal(s.ratio, 1);
    assert.ok(s.base2 > 0);
  }
});

test("learnEventVol: big moves around events give a ratio above 1, shrunk by 6 pseudo-events", () => {
  const dates = wednesdays(8);
  // a 1% jump into E+1 on top of the ordinary cycle
  const overrides = Object.fromEntries(dates.map((d) => [addDays(d, 1), 0.01]));
  const rates = path(760, overrides);
  const s = stat(learnEventVol(rates, dates.map((d) => ev("fomc", d)), AS_OF), "fomc");
  assert.equal(s.n, 8);
  const sumSq = dates.reduce((acc, d) => acc + move(rates, d) ** 2, 0);
  near(s.ratio, (sumSq + 6 * s.base2) / (8 + 6) / s.base2, 1e-9);
  assert.ok(s.ratio > 5, `expected a clearly elevated ratio, got ${s.ratio}`);
  // other kinds are untouched
  assert.equal(stat(learnEventVol(rates, dates.map((d) => ev("fomc", d)), AS_OF), "cbsl_policy").ratio, 1);
});

test("learnEventVol: the baseline excludes days next to events", () => {
  const dates = wednesdays(8);
  const quiet = path(760);
  const jumpy = path(760, Object.fromEntries(dates.map((d) => [addDays(d, 1), 0.01])));
  const events = dates.map((d) => ev("fomc", d));
  // The jumps must not leak into the ordinary-day variance.
  near(stat(learnEventVol(jumpy, events, AS_OF), "fomc").base2, stat(learnEventVol(quiet, events, AS_OF), "fomc").base2, 1e-12);
});

test("learnEventVol: fewer than 4 measurable events means no effect", () => {
  const dates = wednesdays(3);
  const rates = path(760, Object.fromEntries(dates.map((d) => [addDays(d, 1), 0.02])));
  const s = stat(learnEventVol(rates, dates.map((d) => ev("cbsl_policy", d)), AS_OF), "cbsl_policy");
  assert.equal(s.n, 3);
  assert.equal(s.ratio, 1);
});

test("learnEventVol: the ratio is floored at 1 (events calmer than usual never narrow the band)", () => {
  const dates = wednesdays(8);
  // no move at all from E−1 to E+1
  const overrides = Object.fromEntries(dates.flatMap((d) => [[d, 0], [addDays(d, 1), 0]]));
  const s = stat(learnEventVol(path(760, overrides), dates.map((d) => ev("fomc", d)), AS_OF), "fomc");
  assert.equal(s.n, 8);
  assert.equal(s.ratio, 1);
});

test("learnEventVol: no look-ahead, an event counts only once its move window has closed", () => {
  const past = wednesdays(4);
  const rates = path(760, Object.fromEntries([...past, AS_OF].map((d) => [addDays(d, 1), 0.01])));
  const events = [...past, AS_OF, addDays(AS_OF, 14)].map((d) => ev("fomc", d));
  assert.equal(stat(learnEventVol(rates, events, AS_OF), "fomc").n, 4); // today's and the future event are ignored
  // the same event is counted from the day after it
  const dayAfter = addDays(past[0], 1);
  const before = stat(learnEventVol(rates, events, past[0]), "fomc").n;
  const after = stat(learnEventVol(rates, events, dayAfter), "fomc").n;
  assert.equal(after, before + 1);
});

test("learnEventVol: duplicates of one event date count once, and events older than the lookback are dropped", () => {
  const dates = wednesdays(5);
  const rates = path(1000, Object.fromEntries(dates.map((d) => [addDays(d, 1), 0.01])));
  const events = [...dates, dates[0], dates[1]].map((d) => ev("fomc", d));
  events.push(ev("fomc", addDays(AS_OF, -800)));
  assert.equal(stat(learnEventVol(rates, events, AS_OF), "fomc").n, 5);
});

test("learnEventVol: too little history gives base2 = 0 and ratio 1", () => {
  const dates = [addDays(AS_OF, -7), addDays(AS_OF, -14), addDays(AS_OF, -21), addDays(AS_OF, -28)];
  const rates = path(40, Object.fromEntries(dates.map((d) => [addDays(d, 1), 0.01])));
  const s = stat(learnEventVol(rates, dates.map((d) => ev("fomc", d)), AS_OF), "fomc");
  assert.equal(s.base2, 0);
  assert.equal(s.ratio, 1);
});

const STATS: EventVolStat[] = [
  { kind: "fomc", n: 8, ratio: 3, base2: 1e-4 }, // +2e-4 per event
  { kind: "cbsl_policy", n: 8, ratio: 1.5, base2: 1e-4 }, // +0.5e-4 per event
  { kind: "imf", n: 0, ratio: 1, base2: 1e-4 },
];
const ANCHOR = "2026-11-11";

test("eventExtraVar: an event counts when its move (E+1) falls inside (anchor, target]", () => {
  const e = [ev("fomc", addDays(ANCHOR, 2))];
  assert.equal(eventExtraVar(e, STATS, ANCHOR, addDays(ANCHOR, 1)), 0);
  assert.equal(eventExtraVar(e, STATS, ANCHOR, addDays(ANCHOR, 2)), 0); // announced that day, move lands on E+1
  near(eventExtraVar(e, STATS, ANCHOR, addDays(ANCHOR, 3)), 2e-4);
  near(eventExtraVar(e, STATS, ANCHOR, addDays(ANCHOR, 31)), 2e-4);
});

test("eventExtraVar: an event on the anchor day still affects tomorrow, a past one does not", () => {
  near(eventExtraVar([ev("fomc", ANCHOR)], STATS, ANCHOR, addDays(ANCHOR, 1)), 2e-4);
  assert.equal(eventExtraVar([ev("fomc", addDays(ANCHOR, -1))], STATS, ANCHOR, addDays(ANCHOR, 5)), 0);
});

test("eventExtraVar: no look-ahead, events not yet public at the anchor are ignored", () => {
  const date = addDays(ANCHOR, 3);
  assert.equal(eventExtraVar([ev("fomc", date, addDays(ANCHOR, 1))], STATS, ANCHOR, addDays(ANCHOR, 10)), 0);
  near(eventExtraVar([ev("fomc", date, ANCHOR)], STATS, ANCHOR, addDays(ANCHOR, 10)), 2e-4);
});

test("eventExtraVar: sums different events, counts duplicates once, ignores ratio-1 and unknown kinds", () => {
  const events = [
    ev("fomc", addDays(ANCHOR, 2)),
    ev("fomc", addDays(ANCHOR, 2)), // same row from a second source
    ev("cbsl_policy", addDays(ANCHOR, 5)),
    ev("imf", addDays(ANCHOR, 4)),
    ev("mas_policy", addDays(ANCHOR, 6)),
  ];
  near(eventExtraVar(events, STATS, ANCHOR, addDays(ANCHOR, 31)), 2e-4 + 0.5e-4);
  assert.equal(eventExtraVar(events, [], ANCHOR, addDays(ANCHOR, 31)), 0);
  assert.equal(eventExtraVar([], STATS, ANCHOR, addDays(ANCHOR, 31)), 0);
});

/**
 * Automatic version backtest: replays the current code over the last year in memory (nothing is
 * written to `predictions`), starting from no learned state, and scores the final forecast against
 * the random walk on the same dates. Uses exactly the sync's forecast path (`forecastDay`), so it
 * measures the code that is deployed. Pure; the sync loads the inputs and stores the result.
 */
import { HORIZON_BUCKETS, MAX_HORIZON, bucketOf } from "../config";
import { addDays } from "../dates";
import { detectNonTradingDow, dowOf } from "./calendar";
import type { PredictionRow } from "./engine";
import { ErrorIndex } from "./learning";
import { type PairInputs, combineLegMoves, feedOutcomes, forecastDay, restrict } from "./replay";

export interface BucketScore {
  bucket: number;
  n: number;
  /** Mean |log error| × 100 of the final forecast and of the random walk on the same forecasts. */
  mae: number;
  naiveMae: number;
  /** mae / naiveMae: < 1 = better than the random walk. */
  skill: number;
  /** % of actuals inside the final forecast's 80% range. */
  coverage: number;
}

export interface PairBacktest {
  pair: string;
  buckets: BucketScore[];
  /** Over all horizons, n-weighted. */
  overall: { n: number; mae: number; naiveMae: number; skill: number; coverage: number };
}

export interface BacktestResult {
  /** Anchors replayed (from..to) and the scored target window (scoreFrom..to). */
  from: string;
  to: string;
  scoreFrom: string;
  pairs: PairBacktest[];
  /** false = the time budget ran out; nothing should be stored. */
  complete: boolean;
}

export const BACKTEST_DAYS = 365;
/** The first ~65 replayed days are warm-up (no model can be promoted before 30 distinct dates). */
export const BACKTEST_SCORE_DAYS = 300;

/**
 * @param inputs per pair, in forecast order (legs before the pair built from them)
 * @param legsOf which pairs a two-part pair is built from (CROSS_LEGS)
 * @param today scored targets are < today; anchors are today − BACKTEST_DAYS … today − 1
 */
export function runBacktest(
  inputs: PairInputs[],
  legsOf: Partial<Record<string, readonly string[]>>,
  today: string,
  deadline = Infinity,
  /** Called for every scored final forecast (for ad-hoc analysis, e.g. coverage in event windows). */
  onScored?: (pair: string, row: PredictionRow, actual: number) => void,
): BacktestResult {
  const from = addDays(today, -BACKTEST_DAYS);
  const to = addDays(today, -1);
  const scoreFrom = addDays(today, -BACKTEST_SCORE_DAYS);
  // Final-forecast paths per pair and anchor, for two-part pairs.
  const paths = new Map<string, Map<string, number[]>>();
  const pairs: PairBacktest[] = [];

  for (const inp of inputs) {
    const index = new ErrorIndex();
    const mine = new Map<string, number[]>();
    paths.set(inp.pair, mine);
    const legs = legsOf[inp.pair];
    type Acc = { n: number; abs: number; naive: number; inside: number };
    const acc = new Map<number, Acc>(HORIZON_BUCKETS.map((b) => [b, { n: 0, abs: 0, naive: 0, inside: 0 }]));
    const nonTrading = detectNonTradingDow(restrict(inp.official, to), to);

    for (let t = from; t <= to; t = addDays(t, 1)) {
      if (!inp.official.has(t)) continue;
      if (Date.now() > deadline) return { from, to, scoreFrom, pairs, complete: false };
      const legMoves = legs
        ? combineLegMoves(legs.map((l) => ({ path: paths.get(l)?.get(t), anchor: inputs.find((x) => x.pair === l)?.official.get(t) })))
        : undefined;
      const { rows } = forecastDay(inp, index, t, { legMoves });
      feedOutcomes(index, rows, inp.official, today);

      const path = new Array<number>(MAX_HORIZON);
      const naiveAt = new Map<number, number>();
      for (const r of rows) {
        if (r.model === "naive") naiveAt.set(r.horizon, r.predicted);
        if (r.model === "ensemble") path[r.horizon - 1] = r.predicted;
      }
      mine.set(t, path);
      for (const r of rows) {
        if (r.model !== "ensemble" || r.targetDate < scoreFrom || r.targetDate >= today) continue;
        if (nonTrading.includes(dowOf(r.targetDate))) continue;
        const actual = inp.official.get(r.targetDate);
        const nv = naiveAt.get(r.horizon);
        if (!actual || !nv) continue;
        onScored?.(inp.pair, r, actual);
        const a = acc.get(bucketOf(r.horizon))!;
        a.n++;
        a.abs += Math.abs(Math.log(r.predicted / actual));
        a.naive += Math.abs(Math.log(nv / actual));
        if (r.lower80 != null && r.upper80 != null && actual >= r.lower80 && actual <= r.upper80) a.inside++;
      }
    }

    const score = (a: Acc) => ({
      n: a.n,
      mae: a.n ? (a.abs / a.n) * 100 : 0,
      naiveMae: a.n ? (a.naive / a.n) * 100 : 0,
      skill: a.naive ? a.abs / a.naive : 1,
      coverage: a.n ? (a.inside / a.n) * 100 : 0,
    });
    const all = [...acc.values()].reduce(
      (s, a) => ({ n: s.n + a.n, abs: s.abs + a.abs, naive: s.naive + a.naive, inside: s.inside + a.inside }),
      { n: 0, abs: 0, naive: 0, inside: 0 },
    );
    pairs.push({
      pair: inp.pair,
      buckets: HORIZON_BUCKETS.map((b) => ({ bucket: b, ...score(acc.get(b)!) })),
      overall: score(all),
    });
  }
  return { from, to, scoreFrom, pairs, complete: true };
}

export interface VersionComparison {
  pair: string;
  /** Skill vs the random walk (lower = better) of this version and the previous one. */
  skill: number;
  prevSkill: number;
  verdict: "better" | "worse" | "same";
}

/**
 * Compares two versions' backtests. They were run on different days (windows shifted), so they are
 * compared on skill relative to the random walk on their own window, not on raw error. A difference
 * under 0.5% of the random walk's error is "same".
 */
export function compareVersions(cur: BacktestResult, prev: BacktestResult): VersionComparison[] {
  return cur.pairs.flatMap((p) => {
    const q = prev.pairs.find((x) => x.pair === p.pair);
    if (!q) return [];
    const d = p.overall.skill - q.overall.skill;
    return [{ pair: p.pair, skill: p.overall.skill, prevSkill: q.overall.skill, verdict: d < -0.005 ? "better" : d > 0.005 ? "worse" : "same" }];
  });
}

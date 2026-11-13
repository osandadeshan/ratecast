// Backtest the current forecasting code without touching stored forecasts:  npm run backtest
// Replays the last 365 days in memory (same code path as the sync), scores the last 300 days
// (Sundays excluded) and prints the final forecast's error vs the random walk per horizon bucket.
// Optional: an evaluation date (YYYY-MM-DD) as the first argument, default today (SGT).
import { CROSS_LEGS, PAIRS, type Target } from "../lib/config";
import { todayISO } from "../lib/dates";
import { db } from "../lib/db";
import { runBacktest } from "../lib/predict/backtest";
import { loadBacktestInputs } from "../lib/sync";

async function main() {
  const today = process.argv[2] ?? todayISO();
  const t0 = Date.now();
  const r = runBacktest(await loadBacktestInputs(), CROSS_LEGS, today);
  console.log(`Backtest ${r.from} … ${r.to}, scored from ${r.scoreFrom} (${Date.now() - t0} ms)`);
  console.log("MAE % of the final forecast / random walk · skill (< 1 = better) · % inside the 80% range");
  for (const p of r.pairs) {
    const pair = PAIRS[p.pair as Target];
    console.log(`\n${pair ? `${pair.base} → ${pair.quote}` : p.pair}`);
    for (const b of [...p.buckets, { bucket: 0, ...p.overall }]) {
      const label = b.bucket === 0 ? "all" : `≤${b.bucket}d`;
      console.log(
        `  ${label.padEnd(5)} n ${String(b.n).padStart(5)}  ${b.mae.toFixed(4)} / ${b.naiveMae.toFixed(4)}  ` +
          `skill ${b.skill.toFixed(4)}  cover ${b.coverage.toFixed(1)}%`,
      );
    }
  }
  await db().end();
}

main().catch(async (e) => {
  console.error(e);
  await db().end();
  process.exit(1);
});

// Run the daily sync locally:  npm run sync   (reads DATABASE_URL from .env.local)
import { runSync } from "../lib/sync";
import { db } from "../lib/db";

runSync()
  .then(async (r) => {
    console.log(`[${r.status}] ${r.runDate} in ${r.ms}ms`);
    for (const l of r.log) console.log("  " + l);
    await db().end();
    process.exit(r.status === "error" ? 1 : 0);
  })
  .catch(async (e) => {
    console.error(e);
    process.exit(1);
  });

---
name: verify-deploy
description: Check a RateCast deployment on Vercel after a push - page loads, Wise is reachable from Vercel, the first sync ran, cron auth works. Use when the user says they deployed, gives a *.vercel.app URL, or production looks wrong.
---

# Verify a Vercel deployment

Ask for the production URL if you don't have it. Call it `$URL`.

1. **Page.** `curl -s -o /dev/null -w "%{http_code}\n" $URL/` should return 200.
2. **Data.** Run `curl -s $URL/api/dashboard | jq '{db: .dbConfigured, sync: .lastSync.status, live: [.currencies[] | {target, src: .liveSource, rate: .live.midRate}]}'`.
   - `db: false` means Neon isn't connected. Fix in Vercel: Storage → Neon → connect to the project, then redeploy.
   - `live` null / `src: "none"` means Wise is blocking Vercel's IPs. Check `sync_runs.message` for
     `live quote failed`. A fallback would be ExchangeRate-API/Currency-API (already fetched as cross-checks).
   - `sync: null` means the first sync hasn't run. Load the page once (it triggers via `after()`), wait ~60 s, retry.
   - `sync: "error"` means reading the message. It's in the JSON as `.lastSync.message`.
3. **Cron auth.** `curl -s -o /dev/null -w "%{http_code}\n" $URL/api/cron/sync` must be **401** (proves
   `CRON_SECRET` is set). Don't call it with the secret unless the user provides it and asks for a manual run.
4. **Next day.** `.lastSync.at` should be about 01:30 UTC and `recentDeltas` should gain a row each day.
5. Report findings plainly, with the exact fix in the Vercel dashboard.

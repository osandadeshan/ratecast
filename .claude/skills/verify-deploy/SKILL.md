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
   - `sync: null` means the first sync hasn't run. Load the page once after 10:30 SGT (it triggers via `after()`;
     earlier visits leave it to the cron), wait ~60 s, retry.
   - `sync: "error"` means reading the message. It's in the JSON as `.lastSync.message`.
3. **Cron auth.** `curl -s -o /dev/null -w "%{http_code}\n" $URL/api/cron/sync` must be **401** (proves
   `CRON_SECRET` is set). Don't call it with the secret unless the user provides it and asks for a manual run.
4. **Policy events.** The sync log (`.lastSync.message`) must have an `events:` line with a count per source. Then:
   `curl -s $URL/api/dashboard | jq '.events | {upcoming: [.upcoming[] | "\(.date) \(.short)"], health: [.health[] | {source, ok, error, note}]}'`
   - Every `health[].ok` should be `true`, and `upcoming` should list the next FOMC/CBSL dates and the
     BLS CPI/jobs days (`CPI`, `Jobs`; display-only, they don't widen the band).
   - `ok: false` with an `error` means a scraper broke or the site blocks Vercel. Reproduce from the shell with a
     generic UA (URLs are in `.claude/rules/events.md`). If it works locally but not on Vercel, it's an IP block
     (report it, don't work around it with paid proxies). If the layout changed, fix the parse function in
     `lib/sources/events.ts`. Forecasts still work meanwhile: that event kind just stops widening the band.
   - A `note` (e.g. "next review date not announced yet") is expected around year end, not a failure.
5. **Macro factors.** The log must have `ust2y: N points (latest …)`, `brent: N points …` and
   `usd_broad: N points …` lines. Then:
   `curl -s $URL/api/dashboard | jq '.macro, [.events.health[] | select(.source=="treasury" or .source=="fred-brent" or .source=="fred-usd-broad")]'`
   - `.macro` should list `ust2y` (date = last US business day), `brent` (about a week old, which is normal) and
     `usd_broad` (weekly release, up to ~10 days old).
   - The first sync takes ~1 min longer: it downloads 3 yearly Treasury CSVs, one at a time, and home.treasury.gov
     can take ~20 s each. `treasury` failing with a timeout once is OK; it should be ok after the next run.
   - Every model except the random walk shows "not used" in the weights table until it passes the significance
     gate (t < −2.6 vs naive, stricter Student-t bar for small samples). As of 2026-11-14 none has (and the bias correction is off in every bucket), so the forecast equals today's rate. That's by design.
   - **Sri Lanka series.** The log must have `lk_usd_spot`, `lk_sgd_ind`, `lk_opr`, `lk_tbill3m`, `lk_remit`,
     `lk_tourism`, `lk_ccpi_yoy` lines, and `source_health` rows `cbsl-fx`, `cbsl-rates`, `cbsl-external`,
     `cbsl-prices` should be ok. `.macro` on the dashboard lists them; monthly series are 1–2 months old, which
     is normal. `lk_ccpi_yoy` (Colombo CPI) is context only, not a model input.
   - **Three pairs.** `.currencies` has `LKR`, `USD` and `USDLKR`. The first sync replays 365 days in 40 s
     slices, so `.lastSync.status` is `partial` for the first ~2 runs.
6. **Decision outcomes.** After the first sync, past events should carry outcomes:
   `curl -s $URL/api/dashboard | jq '[.events.recent[] | "\(.date) \(.short) \(.outcome)"], [.events.health[] | select(.source=="outcomes")]'`
   - Recent Fed/CBSL events show `cut`/`hold`/`hike`. `outcomes` health is `ok: true`. The log has an
     `outcomes: classified N/M` line on runs that had pending events.
   - The first run reads up to 32 statements (FOMC HTML + CBSL PDFs), which adds ~20 s. Any rest follow next day,
     shown as the note "N statements not read yet". `unclear` means a statement's wording changed: update the
     classifier in `lib/sources/events.ts` (phrases are in `.claude/rules/events.md`).
   - `news` shows "not used" in the weights table until it beats the random walk. That's by design.
7. **Next day.** `.lastSync.at` should be about 01:30 UTC and `recentDeltas` should gain a row each day.
8. Report findings plainly, with the exact fix in the Vercel dashboard.

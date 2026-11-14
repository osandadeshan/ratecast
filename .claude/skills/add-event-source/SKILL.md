---
name: add-event-source
description: Add a new automatic policy-event source to RateCast (e.g. MAS statements, IMF board dates, another central bank) - verify the feed, write a pure parser, pick an honest known_since rule, wire it into sync, health and the UI, and backtest the band. Use when asked to track a new announcement/calendar that can move SGD, LKR or USD.
---

# Add an automatic event source

Read `.claude/rules/events.md` first. Hard requirements: **no hand-entered dates**, no API keys, no paid
services, no second cron. Events only widen the band. They never move the point forecast.

1. **Check the feed from the shell** with a generic UA. Save a sample to the scratchpad and look at the real structure:
   ```bash
   A="Mozilla/5.0 (compatible; RateCast/1.0)"
   curl -s -m 20 -A "$A" -L "<url>" -o "$SCRATCH/sample.html" -w "%{http_code} %{content_type} %{size_download}\n"
   grep -o '<title>[^<]*' "$SCRATCH/sample.html"   # "Maintenance" / captcha / JS challenge = unusable
   ```
   Prefer, in order: JSON/RSS > static HTML > PDF. Avoid unofficial endpoints that break terms of service.
   Check that the source has **history** (for learning) and **future dates** (for warning ahead). If it only
   has one of them, say so.
2. **Parser** in `lib/sources/events.ts`: an exported **pure** `parseX(text): EventRecord[]` plus a fetch
   wrapper returning `SourceResult` (`{ source, events, error?, note? }`). Use `getText`/`getBytes`/`getJSON`
   from `http.ts`, and `pdfText` + `compact` for PDFs. Wrap everything in try/catch. Parsing 0 rows is an
   `error`. "Nothing new yet" is a `note`.
3. **Kind.** Add to `EVENT_KINDS` in `lib/predict/events.ts` (`label`, `short` ≤ 5 chars for the chart,
   `widens`). Use `widens: true` only if the backtest shows the band under-covers on those days; otherwise
   make it display-only (`widens: false`), like `us_cpi` / `us_jobs` (BLS schedule): widening on them over-covered.
   Kinds are stored data: never rename one later. Reuse an existing kind if it's the same institution/decision.
4. **`known_since`**: the first day the date was really public. Be conservative. Too early = look-ahead in
   replay; too late only loses a little band widening. Write the rule and its approximation into `events.md`.
5. **Wire it up.** Add the fetcher to `fetchAllEvents()`. Add a `SOURCE_LABEL` entry in `lib/dashboard.ts`. If
   it's a new kind, check the Policy events card copy in `app/components/DashboardView.tsx` still reads right.
6. **Run it.** Run `npx tsc --noEmit && npm run lint`, then `npm run sync | grep events:`, then:
   ```bash
   docker exec ratecast-pg psql -U postgres -d rates -c "SELECT * FROM source_health;" \
     -c "SELECT kind, count(*), min(event_date), max(event_date) FROM events GROUP BY 1;"
   ```
   Spot-check a few dates against the source by eye.
7. **Decisions.** If the source announces *decisions* (a rate cut, an approval), add an exported pure classifier
   (`classifyX(text): string | null`) next to `classifyFomc`/`classifyCbsl`, and extend `fetchOutcomes()` to
   read **the event's own** statement (never the one that announced the date). Outcome values are stored data:
   never rename them. Test the phrase list on every past statement, and watch for substring traps
   ("increases" contains "eases"). Unparsable → `unclear`. New `kind:outcome` categories feed the `news`
   drift learner automatically, and it stays in shadow.
8. **Backtest** with the "Event windows" section of the `backtest` skill: MAE identical, event-window coverage
   closer to 80%. Fewer than 4 past events in 730 days means ratio = 1 (no effect yet). That's fine, just say so.
9. **Docs.** Update the source table in `.claude/rules/events.md`, `docs/ARCHITECTURE.md` and `docs/CONTEXT.md`
   (sources, limitations), the footer source list, and the `verify-deploy` health expectations.

## Tried and deferred (2026-11-11)
- **MAS** (mas.gov.sg news / monetary-policy pages, eservices API): every URL returned a "Maintenance" page
  to scripted requests. Retry before building. MAS statements come quarterly (Jan/Apr/Jul/Oct), but the day
  within the month isn't fixed, so don't guess dates from the pattern: read them from MAS.
- **GDELT DOC API**: limit 1 request per 5 s, and it rejected even single requests from this IP with the
  rate-limit notice (rechecked for Phase 3, same result). It only searches a rolling 3 months, so it can't be
  backfilled for a backtest either. Too unreliable for the daily sync. It could detect IMF staff-level agreements and
  MAS/geopolitical news if it becomes reachable (one combined OR query per sync, max).
- **IMF** (imf.org RSS / country page): 403 to bots. IMF news is collected after the fact via CBSL RSS (`imf` kind).
- **Stooq** (JS challenge): unusable. Not an event source anyway. FRED is now used for Brent (see `macro.md`).

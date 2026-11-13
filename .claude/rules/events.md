---
paths:
  - "lib/sources/events.ts"
  - "lib/sources/pdf.ts"
  - "lib/predict/events.ts"
  - "lib/predict/news.ts"
  - "lib/sync.ts"
---

# Policy events rules (FOMC, CBSL, IMF, US CPI / jobs)

- **Fully automatic. The owner never enters dates by hand.** Don't add hand-maintained calendars, date
  constants or "remind the owner" flows. If a source has no clean feed, scrape or parse it, infer the date, or
  record it after the fact. Show breakage through `source_health`.
- **Events only widen the 80% band. They never move the point forecast.** Nobody knows the decision in
  advance, so a direction would be fake precision.
- `events.kind` is data, like model names: `fomc`, `cbsl_policy`, `imf`, `us_cpi`, `us_jobs`. Never rename one.
  Add new kinds to `EVENT_KINDS` in `lib/predict/events.ts`.
- Each kind has `widens`. Only `widens: true` kinds (`fomc`, `cbsl_policy`, `imf`) add band variance or are
  excluded from the ordinary-day baseline. `us_cpi` / `us_jobs` are `widens: false`: stored, shown on the chart
  and card, their ratio is learned and displayed, but the band is exactly what it is without them. Reason
  (2026-11-14 backtest, fixed date 2026-11-13): MAE identical, and with widening SGD→USD coverage on CPI
  windows rose from 80–85% to 87–100% and on jobs windows from 78–86% to 81–88%, i.e. those days were already
  covered. Turn widening on for a kind only if a backtest shows its windows under-covered.
- `OUTCOME_KINDS` (`fomc`, `cbsl_policy`, `imf`): only these get a decision outcome. Data releases have none.

## Source contract (`lib/sources/events.ts`)
- Each fetcher returns `SourceResult { source, events, error?, note? }`. It never throws out of `fetchAllEvents()`.
- `error` = broken (fetch failed, or parsed 0 rows). `note` = fine but worth showing (e.g. "next date not announced yet").
- `ingestEvents()` in `sync.ts` writes `source_health`: `last_ok_at`/`last_note` on success,
  `last_error_at`/`last_error` on failure. An event failure must never fail the sync.
- Keep parse functions **pure and exported** (`parseFomcPage`, `parseFomcJson`, `parseCbslList`,
  `parseCbslNextDate`, `parseCbslRss`) so they can be tested on saved HTML/PDF.
- All fetches go through `lib/sources/http.ts` (`getText`, `getBytes`, `getJSON`): generic UA, timeout, no-store.

## Sources and how they break
| source | URL | parse | fragility |
|---|---|---|---|
| `fed-page` | federalreserve.gov/monetarypolicy/fomccalendars.htm | HTML → text tokens. Heading `YYYY FOMC Meetings`, then a month token (`June`, `Apr/May`) followed by days (`16-17*`). Decision = last day. Cross-month `Apr/May 30-1` → 2nd month. Skips `(notation vote)`/`(cancelled)`. `(unscheduled)` is kept. | Layout change gives 0 rows → error. Covers ~5 past years + next year. |
| `fed-json` | federalreserve.gov/json/calendar.json | `type: "FOMC"` + title `FOMC Meeting` (case varies), `month` + last number of `days`. | Fallback/redundancy. Covers 2017 → end of the current year only. |
| `cbsl-mpr` | cbsl.gov.lk/en/press/press-releases/monetary-policy-review | Past review dates from PDF file names `press_YYYYMMDD_Monetary_Policy_Review_No_N_YYYY_*.pdf`. Next date from the **latest PDF** via `pdfText()`: `next regular statement … will be on D Month YYYY`, matched on whitespace-free text (`compact()`). | The year's last statement (Nov/Dec) names no next date → `note`, not error. Missing next date in other months → error. PDF text uses odd spacing, so always match compacted text. |
| `bls` | bls.gov/schedule/YYYY/home.htm (years y−2 … y+1) | `<tr>` rows: `date-cell` "Weekday, Month D, YYYY" + `desc-cell` `<strong>` release name. Exact names only: "Consumer Price Index" → `us_cpi`, "Employment Situation" → `us_jobs` (not "… Average Price", "State Employment …"). | A missing current year or 0 rows → error. A missing future year → note "schedule not published yet". |
| `cbsl-rss` | cbsl.gov.lk/en/rss.xml | Items whose title matches the IMF regex (`IMF`, `International Monetary Fund`, `EFF`, `staff-level agreement`), dated in `Asia/Colombo`. | Only ~10 latest items, so it only collects going forward (daily polling is enough). |

- `lib/sources/pdf.ts` is a dependency-free extractor (inflates FlateDecode streams, reads `Tj`/`TJ` literal
  strings). It handles simple Latin PDFs only. If CBSL switches to hex/CID fonts, it returns empty text and the
  next date shows up as an error. Don't add a heavy PDF library unless that happens.
- Tried and deferred: **MAS** (every page returned a "Maintenance" page) and **GDELT** (limit 1 request per
  5 s, and it rejected even single requests). Rechecked for Phase 3 on 2026-11-11 with the same result. GDELT's
  DOC API also only covers a rolling 3 months, so it couldn't be backtested anyway. See the `add-event-source` skill.

## `known_since` (no-look-ahead gate)
The replay at day `t` only uses events with `known_since <= t`. The rules:
- FOMC scheduled: `event_date − 300 d` (the Fed publishes its schedule more than a year ahead). Unscheduled: the event day.
- CBSL past review: the previous review's date if it was ≤ 120 days earlier (each statement announces the
  next), else `event − 56 d`. Scheduled next date: the latest statement's date.
- IMF (RSS): the event day (recorded after the fact).
- BLS (`blsKnownSince`): Dec 1 of the previous year if the day is in the usual range (CPI days 10–15, jobs days
  1–10: BLS publishes the next year's schedule in the autumn), else `date − 7` (a rescheduled release, e.g.
  after the Oct–Nov 2025 shutdown).
- The upsert keeps `LEAST(old, new)`, so `known_since` can only move earlier.
- Known approximation: the first review of a year really becomes public with CBSL's yearly schedule (Dec/Jan),
  but it gets the November review's date. The effect is small: that's > 31 days out until late December.

## Math (`lib/predict/events.ts`, pure)
- Move around an announcement on day E: `ln(r(E+1) / r(E−1))` (2-day window, robust to Wise's UTC-midnight timing).
- Baseline: the same 2-day move around every **ordinary weekday** in the last 730 days, excluding ±2 days
  around any **band-widening** event (so `widens: false` kinds change nothing). `base2` = its mean square (needs ≥ 60 days).
- Per kind: `ratio = (Σ move² + 6·base2) / (n + 6) / base2`, floored at 1, with a minimum of 4 events
  (otherwise ratio = 1). It only uses events with `E + 1 <= asOf`.
- Band: `sigma = sqrt(sigma_learned² + Σ (ratio − 1)·base2)`, adding one term per known event with
  `anchor <= E` and `E + 1 <= target`. The point forecast is untouched.
- The learned ratios are stored as `model_stats.stats.events` (`EventVolStat[]`) and shown in the Policy events card.

## Outcomes: what was decided (`events.outcome`)
- `classifyOutcomes()` in `sync.ts` runs right after `ingestEvents()`. It picks events with no outcome,
  `event_date < today` and within 800 days, sends them to `fetchOutcomes()` **newest first**, capped at
  `maxFetches = 32` per run (the rest follow on later runs), then runs `UPDATE ... WHERE outcome IS NULL`.
- Classifiers in `lib/sources/events.ts`. They are exported and pure. Outcome values are stored data: never rename them.
  | kind | read from | phrase | outcome |
  |---|---|---|---|
  | `fomc` | `newsevents/pressreleases/monetaryYYYYMMDDa.htm` (the event's own statement) | `decided to (lower\|reduce\|cut\|maintain\|keep\|raise\|increase) … target range` | `cut` / `hold` / `hike` |
  | `cbsl_policy` | the review's own PDF (`event.url`) | headline after `TheCentralBankofSriLanka` (compacted), up to `TheMonetaryPolicyBoard` | `hike` if `increases\|raises\|tightens\|hikes`, else `cut` if `reduces\|lowers\|eases\|cuts\|decreases`, else `hold` if `keeps\|maintains\|unchanged\|holds\|leaves` |
  | `imf` | the RSS title (set at parse time) | `staff-level agreement` / `executive board\|approv\|disburse` | `sla` / `board` / `other` |
- **Ordering trap:** "incr**eases**" contains "eases". Always test tightening words before easing words.
- Unparsable → `'unclear'`, stored so it isn't refetched every day. `categoryOf()` ignores `unclear`.
- **Never classify from a different statement.** A scheduled CBSL row's `url` points to the *previous* review
  (the one that announced the date). `fetchOutcomes` only reads a CBSL PDF whose file name contains
  `press_<YYYYMMDD of event_date>_`, otherwise it skips the row (it stays pending until the list page links its own PDF).
- The upsert keeps `COALESCE(events.outcome, EXCLUDED.outcome)`, so an outcome is never overwritten by a re-scrape.
- An outcome counts as public **from E+1** (CBSL publishes ~07:30 Sri Lanka time, after the 09:30 SGT sync).
  `news.ts` enforces `anchor >= E+1`.
- The health row `outcomes` is written on **every** run, even with nothing pending. Otherwise it would go
  stale after 3 days and show red. Its note says "N statements not read yet" only when N > 0.
- First run (2026-11-11): classified 30/30. CBSL 2 cut / 9 hold / 1 hike, FOMC 6 cut / 11 hold / 1 hike (last 800 days).

## Post-announcement drift (`lib/predict/news.ts`, pure)
- Category = `kind:outcome` (e.g. `fomc:cut`). Learned per currency from events in the last 730 days whose
  window has closed (`E + 1 + 5 <= asOf`): drift = `ln(r(E+6) / r(E+1))`. The jump into E+1 is already in the
  anchor rate, so only the drift after it is learned.
- Shrunk hard toward 0: `Σ drift / (n + 8)`. Categories need ≥ 3 events to be used. Stored as
  `model_stats.stats.news` (`NewsDriftStat[]`).
- `newsDriftBetween(events, stats, anchor, target)` adds `drift / 5` per day in `(anchor, min(target, E+6)]` for
  every event whose window is open at the anchor (`E+1 <= anchor < E+6`). It feeds the shadow model `news`
  (see `forecasting.md`).

## Verify
```bash
npm run sync | grep events:     # "events: N rows · fed-page 56, fed-json 63, cbsl-mpr 13, cbsl-rss 0"
curl -s localhost:3123/api/dashboard | jq '.events | {upcoming, health}'
docker exec ratecast-pg psql -U postgres -d rates -c "SELECT * FROM source_health;" \
  -c "SELECT kind, count(*), min(event_date), max(event_date) FROM events GROUP BY 1;" \
  -c "SELECT kind, outcome, count(*) FROM events WHERE event_date < current_date GROUP BY 1,2 ORDER BY 1,2;"
npm run sync | grep outcomes:   # "outcomes: classified N/M (...)" only when something was pending
```
For any change to event logic, run the event-window comparison in the `backtest` skill.

# RateCast: project context

Background a new contributor (human or AI) needs that isn't obvious from the code.

## Owner's requirements (original brief, 2026-11-09)
- Simple currency-rate **predictor**. Base **SGD**; targets **LKR** and **USD**.
- Use **Wise** for rates: comparisons API for today's rate, `rates/history` for history. Keep history in a DB.
- Show the **whole current month**: past days accurate, future days predicted.
- **Always check the previous month's same-date rate**: implemented as a UI stat, a chart overlay, and the
  `monthly_pattern` model.
- Use **other sources** to gauge the financial situation. The owner didn't specify which, so we chose the ECB
  USD-strength basket (Frankfurter) plus two cross-check rate APIs.
- **Auto-learn and correct**: store each prediction's delta against the actual rate (e.g. predicted 262.5,
  actual 262.0) in a table, and use those stats to improve later predictions.
- Deploy on **Vercel for free**, using only **totally free tools**. **No login.**
- Owner preference: Claude must **not** appear as co-author/contributor in git history.

## Policy events (requested 2026-11-11)
The owner asked for financial decisions to count, e.g. Sri Lanka receiving its next IMF tranche (rupee
strengthens, SGD→LKR down), CBSL and Treasury announcements, and geopolitical moves (Iran war / ceasefire)
that change the dollar. **Hard requirement from the owner: everything must be fully automatic. No
hand-entered dates, calendars or tags.** If a source has no clean feed, scrape or parse it, or detect the event
after the fact, and show a health flag when it breaks.

Honest framing used in the design and the UI copy: prices react to public news within minutes, and the sync
runs once a day, so knowing *that* a decision is coming says nothing about its *direction*. Events therefore
feed **uncertainty, not direction**: they widen the 80% band on announcement days by an amount learned from
history, and never move the predicted number. Any future signal that tries to move the point (Phase 2/3)
must earn weight through the existing learner and the backtest.

### Source survey (tested 2026-11-11 from the dev machine, plain HTTP + generic User-Agent)
| source | result | use |
|---|---|---|
| CBSL `cbsl.gov.lk/en/rss.xml` | ✅ RSS, last ~10 press releases | IMF items after the fact (`cbsl-rss`) |
| CBSL Monetary Policy Review list | ✅ links back to 2024, date in each PDF name | past review dates (`cbsl-mpr`) |
| CBSL review PDFs | ✅ text extractable with `node:zlib`; each statement names the next review date, except the year's last one | next review date |
| CBSL Weekly Economic Indicators (PDF) | not tested | idea: CBSL net USD purchases (strong LKR signal) |
| Treasury `treasury.gov.lk` | ⚠️ redirect, not explored | — |
| IMF site / RSS / Sri Lanka page | ❌ 403 to bots | IMF news only via CBSL RSS for now |
| IMF SDMX API `api.imf.org` | ✅ | slow monthly macro, not used |
| Fed `press_all.xml` / `press_monetary.xml` | ✅ | not used yet (calendar sources are enough) |
| Fed `json/calendar.json` | ✅ FOMC meetings 2017 → current year | `fed-json` |
| Fed `fomccalendars.htm` | ✅ 2021 → next year (2027 already listed) | `fed-page` |
| US Treasury Fiscal Data API | ✅ | not used |
| US Treasury daily par yield curve CSV (`home.treasury.gov`) | ✅ keyless, current to the previous US day; slow at times | `ust2y` (Phase 2) |
| FRED `fredgraph.csv` (Brent, DGS2, dollar index) | ✅ from Node and the web; curl is blocked by the dev sandbox. Brent lags ~1 week | `brent` (Phase 2) |
| MAS website (statements, news, eservices API) | ❌ "Maintenance" page on every URL | MAS events not implemented |
| GDELT DOC 2.0 | ❌ rate-limited ("one request every 5 seconds") even on single requests; DOC API only covers a rolling 3 months | not used (Phase 3 uses decision outcomes instead) |
| Fed FOMC statements (`monetaryYYYYMMDDa.htm`) | ✅ keyless HTML, "decided to lower / maintain / raise the target range" | `fomc` outcomes (Phase 3) |
| Polymarket gamma API, Kalshi public API | ✅ keyless; one market per FOMC meeting ("Fed decision in December?", 5 outcomes) | deferred (see Phase 2) |
| Yahoo Finance chart API | ✅ but unofficial / against terms | backup only |
| Stooq CSV | ❌ JavaScript challenge | — |
| Paid feeds (Bloomberg, Reuters, LSEG), keyed APIs (FRED API, EIA), LLM APIs to read headlines | ruled out | free-tier / no-key rule |

### Phased plan
| phase | what | status |
|---|---|---|
| 0 | `events` + `source_health` tables, fetch helpers (`getText`, `getBytes`), dependency-free PDF text | **done 2026-11-11** |
| 1 | Automatic FOMC + CBSL calendars, IMF news from CBSL RSS, event-aware 80% band, Policy events card, chart markers | **done 2026-11-11** |
| 2 | `macro` model: lagged moves in the US 2y yield (Treasury) and Brent (FRED) → ridge regression on pair returns, plus automatic **shadow mode** for unproven models | **done 2026-11-11, in shadow** (failed the backtest; weight 0 until it beats the random walk) |
| 3 | Decision outcomes (cut/hold/hike) read from each FOMC statement and CBSL review PDF; `news` model = random walk + learned post-announcement drift for 5 days after E+1, in shadow mode | **done 2026-11-11, in shadow** (ensemble unchanged) |
| 4 | More sources and candidates: BLS US CPI / jobs days (display-only events), Fed broad dollar index as a `macro` input for SGD→USD, gated `arima` candidate, recency-weighted 80% band, Colombo CPI for context | **done 2026-11-14** (see Backtest results) |
| 5 | UI panel "what moved the forecast today" | not started |

Polymarket/Kalshi Fed odds were deferred: each contract covers one meeting and lives a few months, so a daily
series means stitching rolling contracts with short histories, and the US 2-year yield already prices the
expected Fed path with years of clean data. The yield earned no weight in the backtest, so the odds are
unlikely to either. Revisit only if `macro` gets promoted.

Phase 3 classifies **what was decided** instead of headline sentiment. GDELT was rate-limited from the dev
machine and only searches a rolling 3 months (too short to learn from), and MAS still served a maintenance
page. Fed and CBSL decisions, in contrast, are unambiguous, have years of statements behind them, and the
dates were already in `events`. Classified outcomes on 2026-11-11 (last 800 days): `fomc` 6 cut / 11 hold /
1 hike, `cbsl_policy` 2 cut / 9 hold / 1 hike (30/30 classified).

MAS statements (quarterly) and forward IMF board dates (≈ 4–8 weeks after a staff-level agreement) are not
automated yet: no reachable source in the survey above.

## Key decisions
| decision | why |
|---|---|
| Next.js 16 App Router on Vercel Hobby | free, cron included, the owner asked for Vercel |
| Neon Postgres (Vercel Marketplace, free) | free, auto-injects `DATABASE_URL`; postgres.js works locally too |
| Neon in Singapore + Vercel functions pinned to `sin1` | DB round-trips stay local (sync runs dozens of queries); Wise is called from SG to match `sourceCountry=SG` |
| One daily cron + `after()` self-heal | Hobby allows daily crons only; a missed run is caught by the next visit |
| Ensemble of simple models, weights learned from deltas | FX is near-random; transparent and cheap; learns which model works per horizon |
| Keep `naive` as a model and show it in the UI | the honest baseline; the learner can fall back to it |
| Gated bias correction (≤ 7 days, only if proven) | ungated, it doubled long-horizon error in backtests |
| 365-day no-lookahead replay on first run (`BACKFILL_DAYS`; 90 days until 2026-11-12) | the learner starts with real stats instead of an empty table |
| ECB basket as the "financial situation" signal | free, keyless, daily; at the time no free LKR macro feed was known (CBSL data was added 2026-11-13) |
| Wise endpoints called without `wiseFee`/`midMarketRate` params | optional; the response is the same |
| Policy events widen the band only, never the point | the decision's direction is unknown in advance; prices move within minutes |
| Event effect learned per kind from 2 years of 2-day moves vs ordinary weekdays, shrunk (k = 6, min 4 events) | data decides which events matter for which pair (e.g. FOMC adds nothing for LKR) |
| No hand-maintained calendars; scrape Fed/CBSL/BLS and track `source_health` | owner requirement (fully automatic); breakage is visible on the page instead of silent |
| Own PDF text extraction (`node:zlib`) instead of a PDF library | CBSL PDFs are simple; no new dependency |
| `macro` uses factor moves lagged past publication (yield 1 day, Brent 9 days, broad dollar index 10 days), applied identically in replay and live | Wise's UTC-midnight point already contains the last US close; only slow pass-through can add anything, and the backtest must not see data the live run wouldn't have |
| Unproven models run in **shadow mode** (scored daily, weight 0 until ≥ 30 distinct target dates and a paired t-test vs naive with t < −2.6 per bucket; until 2026-11-13 the bar was ≥ 2% better than naive). Since 2026-11-13 every model except `naive` is gated this way | near-equal MAEs give near-equal weights under the 1/MAE⁴ rule, so a weak model would still take ~15% of the blend; promotion stays automatic (owner requirement) |
| Promotion counts distinct target dates, not forecasts | long-horizon forecasts overlap; "≥ 60 forecasts" promoted `macro` on thin evidence and hurt LKR 8–31 days |
| Automatic promotion stays on despite a +0.0006 pp slip in one bucket (owner, 2026-11-11) | the only alternative is a manual switch, which breaks "fully automatic"; the slip is noise-sized and demotion is automatic too |
| Polymarket/Kalshi deferred | rolling single-meeting contracts, short histories; the 2y yield carries the same information |
| Phase 3 uses decision outcomes, not headline sentiment | outcomes are unambiguous and have years of history; GDELT was unreachable and only covers 3 months |
| Outcome counts as public from E+1; only the drift E+1 → E+6 is forecast | CBSL publishes after the 09:30 SGT sync on day E; the jump into E+1 is already in the anchor rate |
| Drift shrunk toward 0 by 8 pseudo-events, needs ≥ 3 events per category, and `news` starts in shadow | categories have 1–11 events; anything less conservative would fit noise |

## Backtest results
Until 2026-11-12: replay of 90 days, scored on forecasts made in the last 60 days. Average |% miss|, `ensemble` vs `naive`.

| date | currency | 1 day | 2–7 days | 8–14 days | 15–31 days |
|---|---|---|---|---|---|
| 2026-11-09 | LKR | 0.126 / 0.126 | 0.224 / 0.221 | 0.275 / 0.274 | 0.396 / 0.399 |
| 2026-11-09 | USD | 0.095 / 0.093 | 0.190 / 0.185 | 0.270 / 0.241 | 0.380 / 0.315 |

**2026-11-11 · policy-event bands (Phase 1).** Same replay, old code vs new code. `ensemble` MAE is
**identical in every bucket** for both currencies (events don't touch the point). 80% band coverage / average
width (% of rate) on forecasts whose horizon includes a known FOMC or CBSL move, old → new:

| currency | 1 day | 2–7 days | 8–14 days | 15–31 days |
|---|---|---|---|---|
| LKR | 100 → 100 % · 0.487 → 0.809 | 97.4 → 97.4 % · 1.168 → 1.394 | 97.3 → 97.3 % · 1.443 → 1.665 | 80.1 → 82.7 % · 1.350 → 1.677 |
| USD | 66.7 → 100 % · 0.419 → 0.707 | 82.1 → 82.1 % · 1.053 → 1.207 | 85.6 → 87.2 % · 1.368 → 1.484 | 87.5 → 88.1 % · 1.970 → 2.050 |

Learned variance ratios (event-day 2-day moves vs ordinary weekdays, 2 years): LKR `cbsl_policy` 2.09,
`fomc` 1.00; USD `fomc` 1.49, `cbsl_policy` 1.15. Verdict: **inconclusive** on this window (only 2–3 events per
kind in 60 days; 1-day rows are n = 3). LKR event windows were calm this time, so its bands were already
over-covering and got wider than needed; USD event windows really had bigger misses (0.27% vs 0.15% at 2–7
days). Kept on because the ratios come from 2 years of history and the point forecast is untouched. Re-check
after a few more FOMC/CBSL dates.

**2026-11-11 · `macro` model + shadow mode (Phase 2).** Same replay; the baseline is the code with `macro`
removed (numbers differ slightly from Phase 1 because the data moved on). `macro` on its own vs `naive`, MAE %:

| currency | 1 day | 2–7 days | 8–14 days | 15–31 days |
|---|---|---|---|---|
| LKR | 0.1273 / 0.1240 | 0.2219 / 0.2203 | 0.2836 / 0.2672 | 0.4177 / 0.3970 |
| USD | 0.0932 / 0.0911 | 0.1821 / 0.1770 | 0.2184 / 0.2135 | 0.2790 / 0.2688 |

Worse than the random walk everywhere, so lagged yields and oil don't predict these pairs day to day.
`ensemble` MAE %, baseline → each variant:

| variant | LKR 8–14 | LKR 15–31 | USD 8–14 | USD 15–31 | other buckets |
|---|---|---|---|---|---|
| `macro` fully weighted (~15%) | 0.2698 → 0.2715 | 0.3982 → 0.4024 | 0.2357 → 0.2325 | 0.3089 → 0.3064 | ±0.001 |
| shadow, promote at ≥ 60 forecasts beating naive | 0.2698 → 0.2731 | 0.3982 → 0.4032 | same | same | identical |
| shadow, promotion disabled (check) | identical | identical | identical | identical | 0 differing rows |
| **shipped then:** shadow, ≥ 30 distinct dates and < 0.98 × naive (replaced 2026-11-13 by the paired t-test) | 0.2698 → 0.2704 | 0.3982 → 0.3977 | same | same | identical |

Fully weighted, it failed the "no worse in every bucket" rule (LKR worse in 3 buckets). The shipped rule
changes 89 of ~2,700 ensemble forecasts: LKR 15–31 slightly better, LKR 8–14 slightly worse (+0.0006 pp on
14 forecasts), everything else identical. That tiny 8–14 regression technically breaks the rule. **Decided by the owner on 2026-11-11: keep automatic
promotion as shipped.** The alternative (promotion disabled, fully identical to baseline) would mean `macro`
and `news` could never earn weight without a manual switch, which conflicts with the fully-automatic
requirement. The regression is noise-sized and is offset by the 15–31 day gain, and a promoted model that
stops beating the random walk is demoted again automatically. Not tuned further, to avoid fitting the same
60 days.

**2026-11-11 · decision outcomes + `news` model (Phase 3).** Same replay; the baseline is the code with `news`
removed. `ensemble` is **identical in every bucket** for both currencies (`news` was never promoted). `news`
differs from `naive` on 310 of 2,821 forecasts per currency. `news` vs `naive` on its own, MAE %:

| | 1 day | 2–7 days | 8–14 days | 15–31 days |
|---|---|---|---|---|
| LKR | 0.1235 / 0.1240 | 0.2197 / 0.2203 | 0.2654 / 0.2672 | 0.4081 / 0.3970 |
| USD | 0.0931 / 0.0911 | 0.1795 / 0.1770 | 0.2079 / 0.2135 | 0.2769 / 0.2688 |

Slightly better up to 14 days for LKR and at 8–14 days for USD, worse elsewhere. The learned drifts look like
noise: categories hold 1–11 events, and some make no economic sense (`cbsl_policy:hold` → SGD→USD −0.21% over
5 days). Shadow mode is the right place for it until the evidence grows.

What this means: next-day forecasts match the random walk, which is about as good as FX forecasting gets.
USD long horizons are currently worse than the random walk, because trend models were rewarded in an earlier
regime. The learner should shift weight to `naive`/`holt` over time. Watch this. (Superseded 2026-11-13: every
model except `naive` is now gated, see below.)

**2026-11-13 · audit fixes, USD→LKR, CBSL data, gating by significance.** New method: 365-day replay, 180-day
learning window, Sundays excluded from scoring (Wise's Sunday point repeats Saturday's), scored on forecasts made
in the last 300 days. Average |% miss|, `ensemble` / `naive`:

| pair | 1 day | 2–7 days | 8–14 days | 15–31 days |
|---|---|---|---|---|
| SGD→LKR | 0.2735 / 0.2735 | 0.4413 / 0.4413 | 0.6269 / 0.6269 | 0.9322 / 0.9322 |
| SGD→USD | 0.1636 / 0.1636 | 0.3037 / 0.3037 | 0.4530 / 0.4530 | 0.6280 / 0.6280 |
| USD→LKR | 0.1788 / 0.1788 | 0.3382 / 0.3382 | 0.5595 / 0.5595 | 1.0087 / 1.0087 |

- Before the gate, the ensemble was **worse** than the random walk in every bucket (e.g. SGD→USD 15–31d
  +15%). Now no model passes the significance test (t < −2.6) in any bucket, so the ensemble equals the random
  walk: no longer worse, not better. Honest result: over a year, no model here reliably beats "no change".
- Best candidates, MAE vs naive: `cbsl_gap` SGD→LKR 8–14d −2.3%, 2–7d −0.4%, 15–31d −0.5% (but +2–7% worse
  for USD→LKR); `mean_reversion` SGD→LKR 1d −0.3%; `macro` USD→LKR 15–31d −0.9%. None is significant yet.
  They keep being scored daily and are promoted automatically if the evidence builds.
- `cbsl_gap` evidence: in a fit-before-March / test-after split, Wise's gap to CBSL's fixing cut SGD→LKR 7-day
  error by 5.7% out of sample. Within the rolling replay the gain is smaller (−2.3% at 8–14d).
- 80% band coverage (last 180 days): SGD→USD ~90% at every horizon, USD→LKR 78–82%, SGD→LKR 85–96%. Bands are
  now percentile-based per bucket instead of RMS.
- Scoring speed: the first scoring after a full replay took 13 min (nested-loop anti-join on an empty
  `prediction_errors`); with `enable_nestloop = off` for that statement, 8 s. Full first sync locally: 54 s.

**2026-11-13 · automatic version backtest (Phase 3).** `lib/predict/backtest.ts` replays the deployed code
in memory over the last 365 days (from no learned state, no rows written), scores targets in the last 300 days
(Sundays excluded) and stores the result in `model_versions` on the first sync of each `MODEL_VERSION`. It uses the
sync's own forecast path (`forecastDay`). Buckets are the learner's (1, 2–3, 4–7, 8–14, 15–31 days), so the numbers
differ slightly from the table above. First stored run (`2026.11.13`), MAE % final / random walk, skill, 80% coverage:

| pair | 1 day | 2–3 | 4–7 | 8–14 | 15–31 | all |
|---|---|---|---|---|---|---|
| SGD→USD | 0.1637 / 0.1637 | 0.2343 / 0.2343 | 0.3360 / 0.3360 | 0.4570 / 0.4570 | 0.6511 / 0.6511 | skill 1.0000 · 83.5% |
| USD→LKR | 0.1783 / 0.1783 | 0.2487 / 0.2487 | 0.3801 / 0.3801 | 0.5473 / 0.5473 | 0.9465 / 0.9453 | skill 1.0009 · 67.2% |
| SGD→LKR | 0.2724 / 0.2724 | 0.3520 / 0.3520 | 0.4832 / 0.4832 | 0.6357 / 0.6357 | 0.9332 / 0.9429 | skill 0.9930 · 80.2% |

- During the year a model passed the gate briefly at 15–31 days for both LKR pairs: SGD→LKR gained 1.0% there,
  USD→LKR lost 0.1%. Everywhere else the final forecast was the random walk.
- USD→LKR 80% ranges are too narrow (63–76% coverage): its error distribution changed when the 2025 flat-Monday
  regime ended (below), so ranges learned on the calm months under-cover the busier ones. Candidate for Phase 4.
- **Non-trading days beyond Sundays: tested, not changed.** Wise's USD→LKR point was flat on 51 Mondays (most of
  Jun 2025 – Jan 2026, almost none since Mar 2026) and on 12 of 25 Sri Lankan Poya (full-moon) days or the day
  after; SGD pairs almost never. Neither pattern is a fixed weekday, so the weekday detector correctly ignores
  them. Two variants were backtested: (a) a shorter/looser detector (13 weeks at 75%, 8 weeks at 70%): identical
  results to the digit; (b) dropping observed-flat target dates from learning: USD→LKR 2–3d 0.2487 → 0.2497 and
  4–7d 0.3801 → 0.3844 (worse), others unchanged. Neither was kept. Flat days stay in scoring because a holiday
  forecast that stays flat is genuinely right; the random walk gets the same credit on the same dates.

**2026-11-14 · Phase 4: more sources and candidates (`2026.11.14`).** All runs: in-memory backtest at fixed date
2026-11-13 (365 days replayed, targets in the last 300 days scored, Sundays excluded). MAE % of the final forecast.

- **BLS US CPI and jobs-report days** (`us_cpi`, `us_jobs`, 94 dates 2024–2027 from the BLS schedule pages).
  With band widening on: MAE identical; SGD→USD 80% coverage on CPI windows rose from 80–85% to 87–100% and on
  jobs windows from 78–86% to 81–88%. Those days were already covered, so widening would only make ranges wider
  than needed. **Kept as display-only events** (`widens: false`): stored, on the chart and card, ratio learned
  and shown (SGD→USD CPI ≈ 1.41, jobs 1.00), band unchanged. The baseline's "near an event" exclusion now only
  counts widening kinds, so with them the backtest is identical to the digit to the run without them.
- **Fed broad dollar index** (FRED `DTWEXBGS`, weekly H.10 release, lag 10 days, SGD→USD only) as a third
  `macro` input. `macro` for SGD→USD before → after: 1d 0.1639 → 0.1640, 2–3d 0.2375 → 0.2375, 4–7d 0.3413 →
  0.3403, 8–14d 0.4581 → 0.4569, 15–31d 0.6538 → 0.6534 (random walk 0.1637 / 0.2343 / 0.3360 / 0.4570 /
  0.6511). A hair better than before, still behind the random walk, so `macro` stays at weight 0. Applied to all
  pairs first, it made `macro` worse for both LKR pairs, so it's scoped to SGD→USD (decided before the scoped run).
- **`arima` candidate** (ARIMA(p,1,0), p = 0–5 by BIC, ridge-shrunk, stationary fits only, gated like every
  model). MAE vs random walk: SGD→USD identical (BIC picks p = 0 = random walk); USD→LKR worse everywhere
  (0.1829 / 0.2522 / 0.4113 / 0.5783 / 0.9668 vs 0.1783 / 0.2487 / 0.3801 / 0.5473 / 0.9453); SGD→LKR worse at
  1–7 days, better at 8–14 (0.6253 vs 0.6357, −1.6%) and 15–31 (0.9302 vs 0.9429, −1.3%). Not significant, so
  weight 0; the gate will promote it if that holds. Without the stationarity guard USD→LKR 15–31d was 2.57%.
- **80% band, recency-weighted errors** (half-life on target age): MAE identical. Coverage, all horizons:

  | half-life | SGD→USD | USD→LKR | SGD→LKR |
  |---|---|---|---|
  | none (before) | 83.5% | 67.2% | 80.2% |
  | 60 days | 82.4% | 69.6% | 80.4% |
  | **30 days (adopted)** | **81.6%** | **70.7%** | **79.1%** |
  | 15 days | 80.1% | 71.2% | 75.7% |

  30 days is the smallest total distance to 80%. USD→LKR is still under-covered (1–7d 78%, 8–14d 74.5%,
  15–31d 66%) because its errors come in regimes: monthly coverage ran 98–99% in Jan–Feb 2026, 7–43% in Mar–Jun
  2026 (range too narrow after the flat-Monday period), then 99–100% in Oct–Nov. A faster window over-reacts on
  SGD→LKR, so this is where the trade-off sits. Stored backtest of `2026.11.14`: skill USD 1.0000 / USDLKR
  1.0000 / LKR 0.9934; "same" as `2026.11.13` for all three.
- **Colombo CPI** (CBSL `CCPI_and_CCPI_CORE_*.xlsx`, headline YoY): ingested as `lk_ccpi_yoy`, shown in Market
  context. The sheet only holds the last 13 months, so it can't be backtested as an input yet. History builds up
  in `market_data` run by run; test it as a `lanka` input after ~2 years.
- **MAS**: still a maintenance page on 2026-11-13. Deferred again.
- **Offline Prophet / XGBoost test (run once, never deployed).** Throwaway Python venv, walk-forward from every
  3rd anchor in the same window (86 scored anchors per pair), training only on data up to the anchor. Prophet:
  730 days of log rates, weekly seasonality. XGBoost: 10 lagged daily returns + 20-day volatility, one regressor
  per horizon, trained only on targets already known. MAE % (1 / 3 / 7 / 14 / 31 days):

  | pair | random walk | Prophet | XGBoost |
  |---|---|---|---|
  | SGD→USD | 0.188 / 0.267 / 0.373 / 0.500 / 0.788 | 0.510 / 0.608 / 0.593 / 0.731 / 1.056 | 0.194 / 0.280 / 0.397 / 0.549 / 0.840 |
  | USD→LKR | 0.171 / 0.274 / 0.465 / 0.574 / 1.281 | 1.114 / 1.131 / 1.347 / 1.562 / 2.410 | 0.219 / 0.312 / 0.564 / 0.665 / 1.377 |
  | SGD→LKR | 0.303 / 0.390 / 0.577 / 0.694 / 1.179 | 0.975 / 0.992 / 1.167 / 1.306 / 1.922 | 0.314 / 0.412 / 0.563 / 0.658 / 1.194 |

  **Not recommended.** Prophet is 2–6× worse at every horizon (its trend extrapolation and changepoints chase
  noise in a near-random walk). XGBoost loses to the random walk in 13 of 15 cells; its two wins (SGD→LKR 7d
  −2.4%, 14d −5.2%) are the horizons where `cbsl_gap` and `arima` already show a similar small edge, on 86
  overlapping anchors, nowhere near significant. Both would also need a Python runtime or a model artifact
  on Vercel, which the free tier and the "one code path" rule argue against.

## Known limitations / risks
- **Wise may block Vercel IPs** (untested at the time of writing). The live quote and sync would fail; check
  with the `verify-deploy` skill.
- Wise endpoints are undocumented/public and could change shape without notice.
- Weekends: Wise's Sunday point repeats Saturday's. Fixed 2026-11-12: such weekdays are detected (`calendar.ts`),
  forecasts stay flat across them, and they're excluded from learning.
- "Today" uses Singapore time, while Wise daily points are UTC-midnight snapshots (08:00 SGT).
- Accuracy stats on the page include replayed forecasts until live ones replace them (the longest window is 90
  days). The Performance card shows how many scored forecasts were live vs replayed.
- **Event scrapers are fragile.** The Fed page, CBSL list and CBSL PDF wording can change. A broken source shows
  a red line in the Policy events card (after 3 days without success) and just stops widening; fix the parser.
- **CBSL year-end gap.** The year's last review (Nov/Dec) doesn't name the next one (CBSL publishes a yearly
  schedule instead), so there is no upcoming CBSL date until the first review of the new year. Shown as a grey
  note, not an error.
- **`known_since` is approximate.** FOMC dates are assumed public 300 days ahead. The first CBSL review of a year
  is marked known from the previous November review, a few weeks earlier than the schedule's real release.
- **IMF events are after the fact only.** They come from CBSL RSS titles (only the last ~10 items, read daily),
  have no history yet, so their ratio stays 1 until ≥ 4 are recorded. Board dates are not predicted.
- **Small double-counting.** The learned band (from past ensemble errors) already contains some past event noise, and the event
  term adds more on top. The effect is small but makes event-day bands slightly conservative.
- **`macro` is unproven.** It lost to the random walk in every bucket on 2026-11-11 and runs in shadow. Its
  promotion rule was first checked on one 60-day window (2026-11-11) and since 2026-11-12 on the 365-day replay
  scored over its last 300 days; it has still not been promoted.
- **Brent is ~1 week stale** (FRED/EIA publishing delay), so the oil signal is the move from about 2 weeks ago.
- **Treasury CSVs are slow** (up to ~19 s each). The first sync fetches 3 years one at a time, about a minute
  longer; daily syncs fetch the current year (plus the previous one in January).
- **FRED from the dev machine:** the Claude Code sandbox blocks curl to `fred.stlouisfed.org`, though Node
  `fetch` worked during `npm run sync`. If a local sync fails for `fred-brent`, the production sync on Vercel is
  unaffected.
- **`news` categories are tiny.** 1–11 events each within 2 years of rates; the drift estimates are mostly noise
  and are shrunk hard toward zero.
- **The promotion margin is hard for `news` to reach.** It equals `naive` on ≈ 89% of forecasts, so even a real
  post-announcement effect has to be large to pass the paired t-test vs the random walk for the whole bucket.
- **Outcome classifiers are fragile.** They depend on the FOMC statement phrase "decided to … target range" and
  the CBSL PDF headline wording. Unparsable statements are stored as `unclear` (no drift learned from them);
  fetch failures show on the `outcomes` health row.
- ~~Today's USD→LKR "live Wise" rate could be another provider's~~: fixed 2026-11-14. The comparison API also
  flags e.g. Remitly as mid-market, and the first such provider in the list won (332.46 vs Wise 332.59).
  `parseWiseComparison` now always prefers Wise's own quote. The live forecasts already stored on 2026-11-13/14
  happened to anchor on 332.59/332.60 (the official point), so no stored forecast was affected.
- ~~Live forecast used the ECB basket `<= today`~~: fixed, live and replay both use `< anchor`.
- **No model beats the random walk yet** (2026-11-13). The forecast equals "no change" in every bucket. That
  is the honest floor; candidates (`cbsl_gap`, `mean_reversion`, `macro`) are promoted automatically if
  they become significantly better.
- **USD→LKR 80% band under-covers** (2026-11-14 backtest: 78% at 1–7 days, 74.5% at 8–14, 66% at 15–31) because
  its errors come in regimes. The 30-day recency weighting helped (67.2% → 70.7% overall). Watch it.
- **CBSL reserves / net USD purchases aren't ingested.** They're only in a weekly PDF the dependency-free
  PDF reader can't extract text from.
- **CBSL monthly tables are published 1–2 months late**, so policy-rate, T-bill, remittance and tourism
  inputs are lagged 45–60 days and can only explain slow drifts.

## Ideas backlog (not started)
- **Light refresh** (discussed 2026-11-09): at most hourly on page view, re-run only the forecast step from the
  current live rate using the day's stored weights. Keeps "Tomorrow" fresh without full syncs. Full sync on
  every visit was rejected (free-tier compute, Wise blocking risk, no accuracy gain).
- Fallback live rate from cross-check sources when Wise fails.
- CBSL weekly reserves and net USD purchases: only in the Weekly Economic Indicators PDF, which the `node:zlib`
  reader can't extract yet. (CBSL daily fixings, policy rate, T-bill, remittances, tourism and Colombo CPI are
  already ingested.)
- "What moved the forecast today" (from the policy-events plan).
- Colombo CPI as a `lanka` input once ~2 years of `lk_ccpi_yoy` are stored. Polymarket/Kalshi Fed odds if `macro`
  ever gets promoted. Headline sentiment (GDELT) if it becomes reachable and a longer history is available.
- Email/notification when tomorrow's forecast moves > x% (would need a free mail provider).

## Environment
| var | where | purpose |
|---|---|---|
| `DATABASE_URL` | Vercel (auto from Neon), `.env.local` | Postgres connection |
| `CRON_SECRET` | Vercel env | protects `/api/cron/sync` (required on any deployment; only `next dev` runs without it) |
| `POSTGRES_URL` | Vercel (fallback) | used when `DATABASE_URL` is not set |
| `REPLAY_BUDGET_MS` | optional, local | replay time budget per sync (default 40 000); `100000000` for a full replay |
| `BACKTEST_BUDGET_MS` | optional | deadline (ms from sync start) for the version backtest: page-triggered syncs default 50 000, `npm run sync` 600 000; the cron always uses 240 000 |
| `VERCEL_GIT_COMMIT_SHA` | set by Vercel | first 7 characters appended to `MODEL_VERSION` |

Repo: https://github.com/osandadeshan/ratecast · Local DB container: `ratecast-pg` (port 54329).

# RateCast

**SGD → LKR, SGD → USD and LKR → USD exchange-rate forecasts that learn from their own misses.**

🔗 **Live:** https://ratecast.vercel.app · No login · Runs entirely on free tiers

RateCast shows today's SGD → LKR, SGD → USD and LKR → USD rates from Wise and a full-month view: past days show the actual
rate, future days show a forecast. Every forecast is stored. Once the real rate is published, the miss is
recorded, and those misses decide how future forecasts are made. Inputs are fetched automatically from
Wise, the ECB, the US Treasury, FRED (Brent), the Federal Reserve and the Central Bank of Sri Lanka (official
USD/LKR and SGD/LKR fixings, policy rate, T-bill yield, remittances, tourism, policy-review calendar). A model
only gets weight once it is statistically better than the random walk ("no change").

---

## Contents

1. [Features](#features)
2. [How it works (big picture)](#how-it-works-big-picture)
3. [Data sources](#data-sources)
4. [When syncs happen](#when-syncs-happen)
5. [What a sync does, step by step](#what-a-sync-does-step-by-step)
6. [What data is refreshed, how often, and why](#what-data-is-refreshed-how-often-and-why)
7. [How a page view works](#how-a-page-view-works)
8. [Forecasting models](#forecasting-models)
9. [The learning loop (auto-learn and correct)](#the-learning-loop-auto-learn-and-correct)
10. [Policy events (Fed, CBSL)](#policy-events-fed-cbsl)
11. [Database design](#database-design)
12. [API endpoints](#api-endpoints)
13. [Project structure](#project-structure)
14. [Deploy to Vercel (free)](#deploy-to-vercel-free)
15. [Run locally](#run-locally)
16. [Free-tier budget](#free-tier-budget)
17. [Accuracy: what to expect](#accuracy-what-to-expect)
18. [Limitations and known risks](#limitations-and-known-risks)
19. [Further documentation](#further-documentation)

---

## Features

| | |
|---|---|
| **Today's rate** | Wise mid-market rate for 1 SGD → LKR, 1 SGD → USD and 1,000 LKR → USD (three tabs). The third pair is forecast as USD → LKR, the way Sri Lanka's central bank quotes it, and shown inverted, with the change since yesterday |
| **Same day last month** | Rate on this date last month and how far it has moved since |
| **Tomorrow & month-end forecast** | Forecast with an 80% likely range |
| **Whole-month view** | Chart and day-by-day table: actual for past days, forecast for future days, and last month's rate for comparison |
| **Provider comparison** | What the recipient gets for 1,000 SGD via Wise, Western Union and others |
| **Market context** | 30-day trend, volatility, US-dollar strength (ECB), US 2-year yield and Brent oil (latest value + 30-day change), and cross-checks against two other rate sources. On the LKR tabs also the Sri Lanka central bank (CBSL) series: official USD/LKR and SGD/LKR rates, policy rate, 3-month T-bill yield, remittances and tourism earnings (year-on-year) |
| **Policy events** | Upcoming and recent US Fed (FOMC) and Central Bank of Sri Lanka decisions, read automatically, with what was decided (cut / hold / hike) read from each statement. They widen the 80% range where such days have historically moved the rate more; markers on the chart |
| **Learning panel** | Accuracy by horizon vs a "no change" baseline, recent predicted-vs-actual deltas, current model weights ("not used" until a model is statistically better than "no change"), bias-correction status |
| **Light & dark mode, mobile friendly** | Works at phone width (390px) |

---

## How it works (big picture)

```mermaid
flowchart LR
    subgraph Sources["Free external sources"]
        W1["Wise rates/history<br/>daily official rates"]
        W2["Wise comparisons<br/>live rate + providers"]
        F["Frankfurter / ECB<br/>USD vs EUR, JPY, GBP, CNY"]
        X["ExchangeRate-API<br/>Currency-API"]
        EV["Fed FOMC calendar<br/>CBSL policy reviews + RSS"]
        MF["US Treasury yields<br/>FRED Brent oil"]
        LK["CBSL official rates<br/>+ statistical tables .xlsx"]
    end

    subgraph Vercel["Vercel, region sin1 Singapore"]
        C["Vercel Cron<br/>daily 01:30 UTC"]
        S["Sync pipeline<br/>lib/sync.ts"]
        P["Web page<br/>app/page.tsx"]
        A["JSON API<br/>/api/dashboard"]
    end

    subgraph Neon["Neon Postgres, Singapore"]
        DB[("rates_history<br/>live_quotes<br/>market_data<br/>events<br/>source_health<br/>predictions<br/>prediction_errors<br/>model_stats<br/>sync_runs")]
    end

    C -->|triggers| S
    P -.->|"backup trigger: first visit<br/>of the day if no sync yet"| S
    W1 --> S
    W2 --> S
    F --> S
    X --> S
    EV --> S
    MF --> S
    LK --> S
    S -->|writes| DB
    DB -->|reads| P
    DB -->|reads| A
    W2 -->|"live rate, cached 5 min"| P
    U(("Visitor")) --> P
```

Two separate paths:

- **Write path (sync):** about once a day. Collects data, scores old forecasts, re-learns, writes new forecasts.
- **Read path (page view):** every visit. Reads what the sync stored and adds a live Wise rate that is at
  most 5 minutes old.

---

## Data sources

All free, no API keys.

| Source | Endpoint | Used for | Fetched |
|---|---|---|---|
| **Wise rate history** | `wise.com/rates/history?source=SGD|USD&target=…&resolution=daily` | Official daily rates: the "actual" values forecasts are scored against, and model input | Each sync (3 months; 2 years on first run) |
| **Wise comparisons** | `wise.com/gateway/v4/comparisons?sendAmount=1000&sourceCurrency=SGD&…` | Today's live mid-market rate (forecast starting point) and provider comparison | Each sync, and on page views (cached 5 min) |
| **Frankfurter (ECB)** | `api.frankfurter.dev/v1/<start>..<end>?base=USD&symbols=EUR,JPY,GBP,CNY` | "US-dollar strength" signal used by the market model and the Market context card | Each sync (45 days; ~14 months on first run) |
| **US Treasury yield curve** | `home.treasury.gov/…/daily-treasury-rates.csv/<year>/all?type=daily_treasury_yield_curve…` | US 2-year yield (the market's expected Fed path) for the `macro` model and Market context card. The "2 Yr" column is found by header name, because the columns change between years | Each sync: current year (+ previous year in January; 3 years on first run). Fetched one year at a time with a 40 s timeout: the server is sometimes slow (0.6–19 s) |
| **FRED Brent crude** | `fred.stlouisfed.org/graph/fredgraph.csv?id=DCOILBRENTEU&cosd=<start>` | Oil price for the `macro` model and Market context card. EIA-sourced, so it runs ~1 week behind | Each sync (60 days; 800 days on first run) |
| **ExchangeRate-API** | `open.er-api.com/v6/latest/SGD` | Independent cross-check of today's rate | Each sync |
| **Currency-API** | `cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/…/sgd.json` | Independent cross-check of today's rate | Each sync |
| **Fed FOMC calendar page** | `federalreserve.gov/monetarypolicy/fomccalendars.htm` | FOMC decision dates: history and next year's schedule | Each sync |
| **Fed calendar feed** | `federalreserve.gov/json/calendar.json` | FOMC meeting dates (fallback, back to 2017) | Each sync |
| **CBSL Monetary Policy Review list** | `cbsl.gov.lk/en/press/press-releases/monetary-policy-review` | Every past CBSL review date (from the PDF file names); the latest review PDF states the next date | Each sync |
| **CBSL RSS** | `cbsl.gov.lk/en/rss.xml` | IMF-programme press releases, recorded after the fact | Each sync |
| **CBSL exchange rates** | `cbsl.gov.lk/cbsl_custom/exrates/exrates_results_spot_mid.php` and `exrates_results.php` (form POST) | CBSL's daily indicative USD/LKR (`lk_usd_spot`) and SGD/LKR (`lk_sgd_ind`) fixings: input of `lanka` and `cbsl_gap`, and a cross-check. Lag 1 day | Each sync (120 days; 800 on first run) |
| **CBSL statistical tables** | `.xlsx` linked from `cbsl.gov.lk/en/statistics/statistical-tables/…` (newest file picked by the date in its name) | Table 4.04: policy rate `lk_opr`, 3-month T-bill `lk_tbill3m` (lag 60 days). Tables 2.14.2 / 2.14.1: workers' remittances `lk_remit`, tourism earnings `lk_tourism` (USD mn, lag 45 days). Read with a dependency-free .xlsx reader | Each sync |

---

## When syncs happen

```mermaid
flowchart TD
    T1["⏰ Vercel Cron<br/>daily, 01:30 UTC = 09:30 SGT<br/>Hobby plan: runs within that hour"] --> RUN
    T2["👤 Someone opens the page"] --> CHK{"Successful sync already<br/>for today's date, SGT?"}
    CHK -->|yes, the usual case| NOOP["Nothing more.<br/>Page shows stored data"]
    CHK -->|no| BG["Start sync in background<br/>after the page is sent"]
    BG --> RUN
    RUN{"Sync lock free?"} -->|no, another sync running| SKIP["Skip"]
    RUN -->|yes| SYNC["Run full sync<br/>~10–20 s normally; first time replays<br/>365 days in 40 s slices"]
```

| Trigger | When | Purpose |
|---|---|---|
| **Daily cron** | Every day 01:00–01:59 UTC (09:00–09:59 SGT) | Main schedule. Always runs, even if a sync already happened that day (it refreshes the forecast with a newer live rate). |
| **First visit of the day** | First page view after midnight SGT, only if no successful sync exists for that date | Backup, so a missed or failed cron never leaves the site stale. The visitor doesn't wait; the next page load shows fresh data. |
| **Manual** | `GET /api/cron/sync` with `Authorization: Bearer <CRON_SECRET>`, or `npm run sync` locally | Debugging / forcing a refresh |

A typical day:

```mermaid
sequenceDiagram
    autonumber
    participant V1 as First visitor after midnight SGT
    participant App as RateCast
    participant DB as Neon
    participant Cron as Vercel Cron
    Note over App: 00:00 SGT, new date
    V1->>App: open page
    App->>DB: read stored data
    App-->>V1: page (yesterday's forecasts)
    App->>DB: sync done for today? no
    App->>App: run sync in background
    Note over App,DB: forecasts now start from the midnight live rate
    Note over Cron: ~09:30 SGT
    Cron->>App: GET /api/cron/sync
    App->>App: run sync again
    Note over App,DB: forecasts refreshed from the morning live rate
    Note over App: rest of the day: visits only read, plus a live rate cached 5 min
```

---

## What a sync does, step by step

```mermaid
flowchart TD
    L["🔒 Take sync lock<br/>expires after 5 min"] --> M
    M["1 · Market data<br/>ECB dollar-strength series<br/>+ cross-check rates"] --> MA
    MA["1a · Macro factors<br/>Treasury 2y yield + FRED Brent<br/>+ CBSL rates and tables → market_data<br/>scraper status → source_health"] --> EV
    EV["1b · Policy events<br/>Fed + CBSL calendars → events<br/>+ decision outcomes from statements<br/>scraper status → source_health"] --> I
    I["2 · Wise rates, per pair<br/>SGD→LKR, SGD→USD, USD→LKR<br/>official daily history<br/>+ today's live quote and providers"] --> E
    E["3 · Score past forecasts<br/>every prediction whose day now has<br/>an official rate → prediction_errors"] --> R
    R["4 · Fill gaps<br/>replay any missed day in the last 365<br/>using only data known on that day<br/>(40 s budget, resumes next run)"] --> F
    F["5 · Learn + forecast today<br/>legs first: SGD→USD, USD→LKR, then SGD→LKR<br/>weights, bias, range from last 180 days of misses<br/>→ 31-day forecast from today's live rate"] --> H
    H["6 · Housekeeping<br/>prune old predictions & quotes<br/>log result in sync_runs"] --> U["🔓 Release lock"]
```

| Step | Reads | Writes | Notes |
|---|---|---|---|
| **1. Market data** | Frankfurter, ExchangeRate-API, Currency-API | `market_data` | USD strength = average of log(EUR, JPY, GBP, CNY per USD); rises when the dollar strengthens |
| **1a. Macro factors** | Treasury yield CSV, FRED Brent CSV, CBSL rate lookup + statistical .xlsx | `market_data` (`ust2y`, `brent`, `lk_*`), `source_health` (`treasury`, `fred-brent`, `cbsl-fx`, `cbsl-rates`, `cbsl-external`) | Same failure model as 1b (shared `recordHealth` helper). A missing factor just means the model using it falls back to "no change" |
| **1b. Policy events** | Fed page + JSON, CBSL review list + latest PDF, CBSL RSS; then each past event's own statement (FOMC HTML, CBSL review PDF) | `events` (incl. `outcome`), `source_health` (incl. `outcomes`) | Each source fails on its own: a failure is logged and recorded in `source_health`, never fails the sync. Outcomes: past events with no outcome (last ~800 days), newest first, at most 32 statements per run |
| **2. Wise rates** | Wise history, Wise comparisons | `rates_history`, `live_quotes` | History rows are `source='wise'` (official). Today's live rate goes in as `source='wise_live'` (provisional) and is replaced by the official value once Wise publishes it |
| **3. Score** | `predictions` + official `rates_history` | `prediction_errors` | For each forecast: predicted, actual, delta = actual − predicted, % miss. Only official rates count as "actual". One INSERT…SELECT with nested loops disabled (after a big replay the planner otherwise picked a plan that took 13 min instead of 8 s) |
| **4. Fill gaps** | stored rates, errors | `predictions` | On first deploy this replays 365 days (40 s per run, resumed on the next run until done), so the learner starts with real statistics. Afterwards it only fills days the cron missed |
| **5. Learn + forecast** | rates, ECB series, macro + CBSL factors, errors, events + outcomes, the legs' forecasts | `model_stats`, `predictions` | 11 models × 31 days ahead, blended with learned weights. Every model except the random walk gets weight 0 until it is statistically better than the random walk in that horizon bucket. Known events widen the 80% range (step 4's replay does the same, using only events public on each day). Re-running on the same day overwrites that day's forecast |
| **6. Housekeeping** | | `sync_runs` | Deletes predictions older than ~400 days and quotes older than 60 days, to stay within Neon's free 0.5 GB |

---

## What data is refreshed, how often, and why

| Data | Refreshed | Why this frequency |
|---|---|---|
| **Live Wise rate & provider comparison** (Today card, Send 1,000 SGD card) | On page view, cached **5 minutes**; also stored by each sync | The only number that genuinely changes minute to minute. A 5-minute cache keeps it current without calling Wise on every visit (avoids rate limits and blocking) |
| **Official daily rates** (past days in the month view) | Each sync (≈ daily) | Wise publishes one official point per day. Re-fetching 3 months also picks up any corrections |
| **ECB dollar-strength series** | Each sync | ECB publishes once per business day |
| **Cross-check rates** | Each sync | Sanity check of Wise; daily is plenty |
| **Macro factors** (2y yield, Brent) | Each sync | Both publish once per business day; Brent arrives ~1 week late from FRED |
| **CBSL series** (fixings, policy rate, T-bill, remittances, tourism) | Each sync | Fixings are daily; the monthly tables come out 1–2 months late, so they are lagged 45–60 days |
| **Policy events + source health** | Each sync | Schedules change rarely; a daily read catches a new date within a day |
| **Decision outcomes** (cut / hold / hike) | Each sync, only for past events not yet classified | A statement never changes once published, so each is read once |
| **Prediction deltas** (`prediction_errors`) | Each sync | A forecast can only be scored once its day's official rate exists, i.e. once a day |
| **Model weights, bias, range** (`model_stats`) | Each sync | Changes only when new deltas arrive, i.e. once a day |
| **Forecasts** (Tomorrow, Month end, future days) | Each sync: at least daily, often twice (first visit after midnight + 09:30 cron) | Recomputed from the latest live rate. Re-running more often would mostly repeat the same work |
| **Accuracy panel, recent deltas** | Each sync | Derived from the deltas above |
| **`/api/dashboard` JSON** | CDN-cached 2 minutes | Cheap for repeated API callers |

**Why not sync on every visit?** Most data only changes once a day, and the one thing that changes
continuously (the live rate) is already fetched on page view. Syncing on every visit would burn free-tier
compute (Vercel Hobby and Neon free both cap it monthly), risk Wise blocking the app, and add no accuracy,
because learning only gets new information once a day.

---

## How a page view works

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant Edge as Vercel sin1
    participant Page as app/page.tsx
    participant Cache as Next cache, 5 min
    participant Wise
    participant DB as Neon
    User->>Edge: GET /
    Edge-->>User: static shell + loading skeleton, instant
    Edge->>Page: render data, streamed
    par in parallel
        Page->>DB: month rates, forecasts, deltas, accuracy, stats, market data
        Page->>Cache: live quote SGD→LKR / SGD→USD / USD→LKR
        Cache-->>Wise: only if older than 5 min
    end
    Page-->>User: dashboard HTML streamed in
    Page->>DB: after response: sync done today?
    opt not yet
        Page->>Page: run sync in background
    end
```

If the live Wise call fails, the page falls back to the last stored live quote ("cached" label).
If no database is configured, the page still shows today's live rates plus a setup notice.

---

## Forecasting models

Every model works on log rates and forecasts 1 to 31 days ahead from today's rate.

| Model | Idea | Why it's in the mix |
|---|---|---|
| **Random walk** (`naive`) | Every future day = today | The honest baseline. FX rates are close to a random walk, and every other model has to beat this |
| **30-day drift** (`drift`) | Average daily move over 30 days, fading over the horizon | Captures steady depreciation/appreciation |
| **Holt trend** (`holt`) | Damped trend smoothing, parameters re-fitted every run | Adapts to recent trend changes |
| **Last months' same-day path** (`monthly_pattern`) | How the rate moved from this day-of-month in each of the last 3 months (weights 50/30/20%), dampened | Month-cycle effects (salaries, remittances). Implements "check the previous month's same-date rate" |
| **Mean reversion** (`mean_reversion`) | Pull back toward the 30-day average | Rates rarely run away in a straight line |
| **USD strength** (`market`) | How this pair reacts to the US dollar (90-day β) × the dollar's 10-day momentum | Brings in the wider financial situation |
| **Post-announcement drift** (`news`, *shadow*) | Random walk, plus, for 5 days after a classified decision (e.g. `fomc:cut`, `cbsl_policy:hold`), the average drift that followed past decisions of that category (E+1 → E+6), shrunk hard toward zero (8 pseudo-events, needs ≥ 3 real ones). Equals `naive` on all other days | Tests whether rates keep moving after a decision. **Shadow**: in the 11 Nov 2026 backtest the learned drifts looked like noise (categories have 1–11 events) |
| **Sri Lanka data** (`lanka`, *shadow*, LKR pairs) | The same ridge factor model on CBSL inputs (`LANKA_FACTORS` in `lib/config.ts`): gap between CBSL's fixing and the Wise rate, CBSL's 5-day USD/LKR move, policy-rate and T-bill changes, year-on-year remittances and tourism. Each input has its own publication lag, staleness limit and fade | Local fundamentals that move LKR (dollar inflows, rates) |
| **Gap to CBSL rate** (`cbsl_gap`, *shadow*, LKR pairs) | For each horizon, a regression (365 days, shrunk toward 0) of how far Wise moved on yesterday's gap ln(CBSL fixing / Wise rate). Forecast = today + β × today's gap | Wise tends to drift toward the central bank's own rate. Best candidate so far: −2.3% error for SGD→LKR at 8–14 days, not yet significant |
| **Two-part** (`cross`, *shadow*, SGD→LKR) | Today's SGD→LKR moved by the final forecasts of SGD→USD and USD→LKR, made the same day | ~73% of SGD→LKR's daily movement comes from USD→LKR, and the two legs are almost uncorrelated, so each leg is learned on its own |
| **US yields + oil** (`macro`, *shadow*) | Ridge regression (no intercept, λ = n) of the pair's daily move on the 5-day move of the US 2-year yield (lagged 1 day) and Brent (lagged 9 days), fitted on the last 250 days. Future factor moves count as zero, so its effect fades within about a week | Slow pass-through, e.g. oil → Sri Lanka's import bill → LKR. **Runs in shadow mode**: it failed the backtest, so it gets weight 0 until it proves itself (see below) |

They're combined into:

- `blend`: weighted by past accuracy (raw).
- `blend_bc`: blend with bias correction. Always stored, so we can measure whether correction helps.
- `ensemble`: the **final forecast shown to users**. It's the blend, plus the bias correction only where it
  has been shown to help.

---

## The learning loop (auto-learn and correct)

```mermaid
flowchart LR
    A["Day t<br/>forecast for day t+h<br/>stored in predictions"] --> B["Day t+h<br/>Wise publishes official rate"]
    B --> C["Sync scores it<br/>delta = actual − predicted<br/>→ prediction_errors"]
    C --> D["Learner, last 180 days of deltas,<br/>per horizon bucket, Sundays skipped"]
    D --> D1["Model weights<br/>only models proven better than<br/>'no change' get any weight"]
    D --> D2["Bias correction<br/>only if proven helpful, ≤ 7 days"]
    D --> D3["80% range width<br/>80th percentile of recent misses"]
    D1 --> N["Next forecast"]
    D2 --> N
    D3 --> N
    N --> A
```

**Worked example.** On 29 Nov, RateCast predicts **262.5** LKR for 30 Nov. On 30 Nov Wise's official rate
is **262.0**. The next sync writes:

| model | made_on | target_date | horizon | predicted | actual | delta | pct_error |
|---|---|---|---|---|---|---|---|
| ensemble | 2026-11-29 | 2026-11-30 | 1 | 262.5 | 262.0 | −0.5 | +0.19% |

The same row is written for each of the 11 models and for `blend` / `blend_bc`. Over the 180-day window:

- A model only gets weight once it has **proven** it beats the random walk (see "gate" below). Among the
  models that pass, smaller average misses get more weight (weight ∝ 1 / miss⁴, shrunk toward average when
  there are few samples).
- If the blend has been running consistently high, a bias correction pulls the next forecast down. It is
  switched on only when the corrected variant passes the same significance test against the uncorrected
  one, and only up to 7 days ahead. Backtests showed that correcting long horizons doubled the error, because
  long-horizon misses arrive weeks late, after the market has moved on.
- The 80% range is the 80th percentile of recent misses in that horizon bucket, scaled by √(horizon) inside
  the bucket, so day 15 and day 31 no longer get the same width.
- Sundays: Wise's Sunday point repeats Saturday's ~98% of the time. Such weekdays are detected from the data,
  forecasts stay flat across them and they are left out of learning (they'd make every model look perfect).

**The gate (every model must earn its weight).** Since 12 Nov 2026 this applies to **every model except the
random walk**, not only the new ones: the 365-day replay showed the classic models made the forecast worse
than "no change" at every horizon. A model is run and scored every day, but gets weight 0 in a horizon bucket
until it has been scored on **≥ 30 distinct target dates** there **and** a paired t-test on its per-day misses
vs the random walk's gives **t < −2.6**. The sample size is divided by the bucket's mean horizon, because
neighbouring forecasts overlap. 2.6 is a Bonferroni correction for ~10 candidates per bucket: a plain t < −2
promoted a lucky model for USD→LKR in May 2026 and made 2–7 day forecasts 5% worse. Promotion and demotion are
automatic and daily; the weights table shows "not used" until then. `SHADOW_MODELS` (`macro`, `news`,
`lanka`, `cross`, `cbsl_gap`) marks the models built on external data.

Horizon buckets are learned separately: **1 day, 2–3, 4–7, 8–14, 15–31 days**. A model can be best for
tomorrow and poor for next month.

**No look-ahead.** A forecast made on day *t* only ever uses data known on day *t*. Macro factors are cut at
*t* − lag (1 day for yields and CBSL fixings, 9 for Brent, 45–60 for CBSL monthly tables) in both the live run
and the replay. This holds for live runs and for the 365-day replay, so backtest numbers are honest.

---

## Policy events (Fed, CBSL)

Nobody knows a central bank's decision in advance, so events **never move the predicted number**. They
only widen the 80% range on days where this currency pair has historically moved more than usual.
Everything is read automatically; no dates are entered by hand.

| Event (`events.kind`) | Upcoming dates from | Past dates from |
|---|---|---|
| US Fed decision (`fomc`) | FOMC calendar page (includes next year) | Same page + Fed calendar JSON |
| CBSL policy review (`cbsl_policy`) | The latest review PDF: *"the next regular statement … will be on 20 November 2026"* | File names on the CBSL review list (`press_YYYYMMDD_…`) |
| IMF / Sri Lanka (`imf`) | (not available) | CBSL RSS items mentioning the IMF, recorded after the fact |

How the range is widened (`lib/predict/events.ts`, pure):

1. For each event kind, compare the 2-day move around past announcements, ln(rate(E+1) / rate(E−1)), with
   the same move around every ordinary weekday over the last 2 years. The squared-move ratio is shrunk
   toward 1 (6 pseudo-events) and needs ≥ 4 events.
2. A forecast made on day *t* for day *T* adds `(ratio − 1) × normal 2-day variance` for every event with
   `known_since ≤ t` whose move falls inside (*t*, *T*]. The point forecast is unchanged.
3. No look-ahead: events count only once public (`known_since`), and the ratio is learned only from events
   whose move window has closed (`event_date + 1 ≤ t`).

**What was decided** (`events.outcome`). After each event, the sync reads that event's **own** statement and
stores `cut`, `hold` or `hike` (IMF items: `sla` staff-level agreement, `board` approval, `other`; `unclear`
if unparsable):

- FOMC: the statement page `monetaryYYYYMMDDa.htm` (*"decided to lower / maintain / raise the target range"*).
- CBSL: the review PDF whose file name carries that event's `press_YYYYMMDD` (headline *"… keeps the OPR
  unchanged"*, *"further reduces …"*, *"increases …"*). Never a different statement's PDF.
- IMF: from the RSS title.

An outcome counts only from the day after the event (CBSL publishes around 07:30 Sri Lanka time, after the
09:30 SGT sync), and once stored it is never overwritten. The first run classified all 30 events of the last
2 years: Fed 6 cuts / 11 holds / 1 hike, CBSL 2 cuts / 9 holds / 1 hike. Outcomes feed the shadow `news`
model (post-announcement drift, `lib/predict/news.ts`); recent events show a cut / hold / hike badge on the
card.

Example (Nov 2026): CBSL review days showed about 1.4× a normal day's move for SGD → LKR (12 past reviews),
so the LKR range widens from 21 Nov. FOMC days showed no extra move for LKR (range unchanged) but about
1.2× for SGD → USD.

The **Policy events** card lists upcoming and recent events with their learned effect and decision badge, and
flags any event scraper that has failed or not succeeded in 3 days (`source_health`). Treasury and FRED
health is shown in the Market context card instead. The same data is in `/api/dashboard` under
`.events` (`upcoming`, `recent`, `health`; each event has `outcome`), each currency's learned ratios are in
`.currencies[].stats.events`, and the learned post-announcement drifts in `.currencies[].stats.news`.

Not implemented yet: MAS (Singapore) statements (mas.gov.sg served a maintenance page to the scraper),
a forward window for IMF board approvals, and GDELT news tone (rate-limited, and its DOC API keeps only a
rolling 3 months, so there is nothing to backfill or backtest on). CBSL's year-end review names
no next date, so the card shows a note until the first review of the new year names one.

---

## Database design

```mermaid
erDiagram
    rates_history {
        text currency PK
        date date PK
        float rate
        text source "wise or wise_live"
        timestamptz updated_at
    }
    live_quotes {
        bigint id PK
        text currency
        date date
        float mid_rate
        jsonb providers
        timestamptz fetched_at
    }
    market_data {
        text series PK "usd_basket, ust2y, brent, lk_*, xc:CUR:source"
        date date PK
        float value
    }
    predictions {
        bigint id PK
        text currency
        date made_on
        date target_date
        int horizon
        text model
        float predicted
        float lower80
        float upper80
    }
    prediction_errors {
        bigint prediction_id PK, FK
        text currency
        text model
        date made_on
        date target_date
        int horizon
        float predicted
        float actual
        float delta
        float pct_error
        float log_error
    }
    model_stats {
        text currency PK
        date as_of PK
        jsonb stats "weights, bias, range"
    }
    events {
        text kind PK "fomc, cbsl_policy, imf"
        date event_date PK
        date known_since "no-look-ahead gate"
        text source
        text title
        text url
        text outcome "cut, hold, hike, sla, board, other, unclear"
    }
    source_health {
        text source PK
        timestamptz last_ok_at
        timestamptz last_error_at
        text last_error
        text last_note
        int last_count
    }
    sync_runs {
        bigint id PK
        date run_date
        text status
        text message
        timestamptz started_at
        timestamptz finished_at
    }
    predictions ||--o| prediction_errors : "scored once actual known"
    rates_history ||--o{ prediction_errors : "provides actual"
```

- `currency` holds the pair id: `LKR` (SGD→LKR), `USD` (SGD→USD), `USDLKR` (USD→LKR). These ids are data:
  never rename them.
- Schema is created automatically (`CREATE TABLE IF NOT EXISTS`) on first use. No migrations to run.
- `predictions` is unique on (currency, made_on, target_date, model).
- `sync_lock` (single row) prevents two syncs at once.
- `events` is unique on (kind, event_date); re-reads keep the earliest `known_since` and never overwrite a stored `outcome`. A few hundred rows, never pruned.

---

## API endpoints

| Route | Method | Auth | Description |
|---|---|---|---|
| `/` | GET | none | The dashboard |
| `/api/dashboard` | GET | none | Everything on the page as JSON (CDN-cached 2 min), including `.events` (upcoming, recent, source health) and `.macro` (latest 2y yield / Brent with 30-day change) |
| `/api/cron/sync` | GET | `Authorization: Bearer $CRON_SECRET` | Runs a sync; returns `{ status, runDate, log, ms }`. Returns 401 without the secret. On a deployment it refuses to run (500) if `CRON_SECRET` isn't set, instead of being open to anyone |

---

## Project structure

```
app/
  page.tsx                  Dashboard page: streamed data + background sync check
  layout.tsx, globals.css   Shell, theme tokens (light/dark)
  components/
    DashboardView.tsx       All page sections (cards, table, learning panel)
    MonthChart.tsx          Month chart (Recharts)
  api/
    cron/sync/route.ts      Daily cron endpoint
    dashboard/route.ts      JSON API
lib/
  config.ts                 Currencies, horizons, windows, timezone, macro factors + lags
  dates.ts, format.ts       Date math (YYYY-MM-DD strings), number formatting
  db.ts                     Postgres client + schema
  sources/                  wise.ts, market.ts, macro.ts (Treasury yield, FRED Brent), events.ts (Fed/CBSL
                            calendars), srilanka.ts + srilanka-xlsx.ts (CBSL rates and tables), pdf.ts, http.ts
  predict/                  series.ts, calendar.ts (non-trading days), models.ts, learning.ts, events.ts,
                            news.ts, engine.ts (pure, no I/O)
  sync.ts                   The sync pipeline
  dashboard.ts              All read queries for the page
scripts/sync.ts             Run a sync from the command line
vercel.json                 Region sin1 + daily cron
tests/                      Unit tests (node:test via tsx): parsers, dates, PDF text, events, news, cbsl_gap
docs/                       ARCHITECTURE.md, CONTEXT.md
AGENTS.md, CLAUDE.md, .claude/   Guidance for AI coding agents (rules, skills, lint hook)
```

**Stack:** Next.js 16 (App Router, Cache Components) · React 19 · TypeScript · Tailwind CSS 4 · Recharts ·
postgres.js · Neon Postgres · Vercel Cron.

---

## Deploy to Vercel (free)

1. Push this repo to GitHub.
2. On vercel.com: **Add New → Project →** import the repo. The defaults are fine.
3. In the project: **Storage → Create Database → Neon (Postgres, Free)**, region **Singapore**, and connect
   it to the project. This sets `DATABASE_URL` automatically. Functions are pinned to `sin1` in
   `vercel.json`, so the app and the database sit in the same region. Realtime/auth add-ons aren't needed.
4. **Settings → Environment Variables:** add `CRON_SECRET` = any long random string (`openssl rand -hex 32`).
5. Redeploy and open the site. The first visit triggers the initial sync (2 years of history, then the
   365-day replay in 40-second slices). Each later visit or cron run continues the replay until it's done
   (about 2 runs); until then the sync status is `partial`. Refresh after a minute.

**Check it worked:**

```bash
curl -s https://<your-app>.vercel.app/api/dashboard | jq '{db: .dbConfigured, sync: .lastSync.status, live: [.currencies[] | {target, rate: .live.midRate}]}'
curl -s -o /dev/null -w "%{http_code}\n" https://<your-app>.vercel.app/api/cron/sync   # expect 401
```

| Environment variable | Set by | Purpose |
|---|---|---|
| `DATABASE_URL` | Neon integration (automatic) | Postgres connection |
| `CRON_SECRET` | You | Protects `/api/cron/sync`; Vercel Cron sends it automatically |

---

## Run locally

```bash
docker run -d --name ratecast-pg -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=rates -p 54329:5432 postgres:16-alpine
echo 'DATABASE_URL=postgres://postgres:dev@localhost:54329/rates' > .env.local
npm install
npm run sync      # download history, replay 365 days, forecast
npm run dev       # http://localhost:3000
```

| Command | What it does |
|---|---|
| `npm run sync` | One full sync against `.env.local`'s database |
| `npm run dev` / `npm run build` / `npm start` | Next.js dev / production build / production server |
| `npm run lint`, `npx tsc --noEmit` | Lint, typecheck |
| `npm test` | Unit tests (59). Inside the Claude Code sandbox use `node --import tsx --test tests/*.test.ts`, because the `tsx` CLI needs an IPC socket the sandbox blocks |
| `REPLAY_BUDGET_MS=100000000 npm run sync` | Full 365-day replay in one run (about 1 minute locally) |

---

## Free-tier budget

| Service | Free limit (approx.) | RateCast usage |
|---|---|---|
| Vercel Hobby | Daily crons only; functions up to 300 s | 1 cron/day; sync ~10–20 s (first run: 40 s replay slices) |
| Neon Free | 0.5 GB storage, monthly compute cap, auto-suspend when idle | ~1,300 forecast rows/day (3 pairs × 14 rows × 31 days); ~1 year kept ≈ 470k rows + their scores, ~150 MB; DB idle most of the day |
| Wise / ECB / Fed / CBSL / Treasury / FRED / other APIs | Public, keyless | ~25 calls per sync (incl. one CBSL PDF and three CBSL .xlsx) + at most 3 live Wise calls per 5 min while people are visiting |

---

## Accuracy: what to expect

Backtest on 13 Nov 2026: 365-day no-look-ahead replay, forecasts made in the last 300 days, Sundays excluded,
average miss (%), final forecast vs "no change":

| | 1 day | 2–7 days | 8–14 days | 15–31 days |
|---|---|---|---|---|
| **SGD → LKR** | 0.274 vs 0.274 | 0.441 vs 0.441 | 0.627 vs 0.627 | 0.932 vs 0.932 |
| **SGD → USD** | 0.164 vs 0.164 | 0.304 vs 0.304 | 0.453 vs 0.453 | 0.628 vs 0.628 |
| **USD → LKR** (shown as LKR → USD; % misses are the same) | 0.179 vs 0.179 | 0.338 vs 0.338 | 0.560 vs 0.560 | 1.009 vs 1.009 |

Before the significance gate (12 Nov 2026) the forecast was *worse* than "no change" at every horizon (up to
15% for SGD → USD at 15–31 days). Now no model has proven itself, so the forecast equals "no change". That's
the honest floor; candidates keep being scored and are switched on automatically if they prove better. The
closest are `cbsl_gap` for SGD → LKR (−2.3% at 8–14 days) and `macro` for USD → LKR at 15–31 days (−0.9%).
80% ranges hold 78–96% of actual rates depending on pair and horizon.

Exchange rates are close to unpredictable; matching "no change" is about as good as FX forecasting
realistically gets. The page always shows the current numbers next to the baseline.
This is **not financial advice**.

---

## Limitations and known risks

- Wise endpoints are public but undocumented and may change shape without notice.
- The Fed and CBSL calendars are scraped from HTML/PDF. A layout change stops that source (flagged on the
  Policy events card); forecasts keep working, only that event kind stops widening the range.
- Past CBSL reviews are assumed public from the previous review (each statement names the next), and FOMC
  dates 300 days ahead. For January reviews the real announcement may have come a little later.
- The `macro` model (yields + oil) was slightly worse than "no change" in every bucket in the 11 Nov 2026
  backtest, so it runs in shadow mode. During that replay it was briefly promoted for SGD → LKR: 15–31 days
  improved (0.3982% → 0.3977%) but 8–14 days got slightly worse (0.2698% → 0.2704%, 14 forecasts). That
  technically breaks the "no worse in every bucket" rule by 0.0006 pp. The owner accepted this on
  11 Nov 2026 and kept automatic promotion: the slip is noise-sized, and a model that stops beating the
  random walk drops back to shadow by itself.
- Brent from FRED runs ~1 week late, so the oil signal is always stale by design (lag 9 days).
- `home.treasury.gov` is sometimes slow (up to ~19 s per CSV); the first sync fetches 3 years and can take
  about a minute.
- The `news` model (post-announcement drift) never got promoted in the 11 Nov 2026 backtest; the ensemble was
  identical in every bucket. On its own it beat "no change" slightly for SGD → LKR up to 14 days and for
  SGD → USD at 8–14 days (0.2079% vs 0.2135%), but was worse elsewhere, and the learned drifts look like noise
  (e.g. "CBSL hold → SGD→USD −0.21% over 5 days", n = 9). With 1–11 events per category it will take years of
  data to prove anything.
- Outcomes are read with simple text patterns; an unusual statement headline is stored as `unclear` and simply
  ignored by the model.
- Polymarket/Kalshi Fed odds are not used: contracts are per meeting with short histories, and the 2-year
  yield already carries that information and earned no weight.
- Wise's Sunday point repeats Saturday's. Handled since 12 Nov 2026: detected from the data and left out of
  learning and accuracy.
- No model beats "no change" significantly yet (13 Nov 2026), so the forecast currently equals today's rate.
- CBSL reserves and CBSL's net dollar purchases aren't used: they're only in a weekly PDF whose text the
  dependency-free PDF reader can't extract.
- CBSL monthly tables are published 1–2 months late, so remittances, tourism, policy rate and T-bill can only
  explain slow drifts.
- "Today" follows Singapore time; Wise daily points are midnight-UTC (08:00 SGT) snapshots.
- Until ~180 real days have passed, the accuracy panel partly reflects the initial 365-day replay.
- Forecasts between syncs start from the latest synced rate, not the current live one (see the
  "light refresh" idea in `docs/CONTEXT.md`).

---

## Further documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): exact learning formulas and internal details.
- [`docs/CONTEXT.md`](docs/CONTEXT.md): original requirements, design decisions, backtest log, backlog.
- [`AGENTS.md`](AGENTS.md) / [`CLAUDE.md`](CLAUDE.md): rules for AI coding agents working on this repo.

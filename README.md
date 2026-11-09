# RateCast

**SGD → LKR / USD exchange-rate forecasts that learn from their own misses.**

🔗 **Live:** https://ratecast.vercel.app · No login · Runs entirely on free tiers

RateCast shows today's Singapore-dollar rates from Wise and a full-month view: past days show the actual
rate, future days show a forecast. Every forecast is stored. Once the real rate is published, the miss is
recorded, and those misses decide how future forecasts are made.

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
10. [Database design](#database-design)
11. [API endpoints](#api-endpoints)
12. [Project structure](#project-structure)
13. [Deploy to Vercel (free)](#deploy-to-vercel-free)
14. [Run locally](#run-locally)
15. [Free-tier budget](#free-tier-budget)
16. [Accuracy: what to expect](#accuracy-what-to-expect)
17. [Limitations and known risks](#limitations-and-known-risks)
18. [Further documentation](#further-documentation)

---

## Features

| | |
|---|---|
| **Today's rate** | Wise mid-market rate for 1 SGD → LKR and → USD, with the change since yesterday |
| **Same day last month** | Rate on this date last month and how far it has moved since |
| **Tomorrow & month-end forecast** | Forecast with an 80% likely range |
| **Whole-month view** | Chart and day-by-day table: actual for past days, forecast for future days, and last month's rate for comparison |
| **Provider comparison** | What the recipient gets for 1,000 SGD via Wise, Western Union and others |
| **Market context** | 30-day trend, volatility, US-dollar strength (ECB) and cross-checks against two other rate sources |
| **Learning panel** | Accuracy by horizon vs a "no change" baseline, recent predicted-vs-actual deltas, current model weights, bias-correction status |
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
    end

    subgraph Vercel["Vercel, region sin1 Singapore"]
        C["Vercel Cron<br/>daily 01:30 UTC"]
        S["Sync pipeline<br/>lib/sync.ts"]
        P["Web page<br/>app/page.tsx"]
        A["JSON API<br/>/api/dashboard"]
    end

    subgraph Neon["Neon Postgres, Singapore"]
        DB[("rates_history<br/>live_quotes<br/>market_data<br/>predictions<br/>prediction_errors<br/>model_stats<br/>sync_runs")]
    end

    C -->|triggers| S
    P -.->|"backup trigger: first visit<br/>of the day if no sync yet"| S
    W1 --> S
    W2 --> S
    F --> S
    X --> S
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
| **Wise rate history** | `wise.com/rates/history?source=SGD&target=…&resolution=daily` | Official daily rates: the "actual" values forecasts are scored against, and model input | Each sync (3 months; 2 years on first run) |
| **Wise comparisons** | `wise.com/gateway/v4/comparisons?sendAmount=1000&sourceCurrency=SGD&…` | Today's live mid-market rate (forecast starting point) and provider comparison | Each sync, and on page views (cached 5 min) |
| **Frankfurter (ECB)** | `api.frankfurter.dev/v1/<start>..<end>?base=USD&symbols=EUR,JPY,GBP,CNY` | "US-dollar strength" signal used by the market model and the Market context card | Each sync (45 days; ~14 months on first run) |
| **ExchangeRate-API** | `open.er-api.com/v6/latest/SGD` | Independent cross-check of today's rate | Each sync |
| **Currency-API** | `cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/…/sgd.json` | Independent cross-check of today's rate | Each sync |

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
    RUN -->|yes| SYNC["Run full sync<br/>~2 s normally, ~10–20 s first time"]
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
    M["1 · Market data<br/>ECB dollar-strength series<br/>+ cross-check rates"] --> I
    I["2 · Wise rates, per currency<br/>official daily history<br/>+ today's live quote and providers"] --> E
    E["3 · Score past forecasts<br/>every prediction whose day now has<br/>an official rate → prediction_errors"] --> R
    R["4 · Fill gaps<br/>replay any missed day in the last 90<br/>using only data known on that day"] --> F
    F["5 · Learn + forecast today<br/>weights, bias, range from last 60 days of misses<br/>→ 31-day forecast from today's live rate"] --> H
    H["6 · Housekeeping<br/>prune old predictions & quotes<br/>log result in sync_runs"] --> U["🔓 Release lock"]
```

| Step | Reads | Writes | Notes |
|---|---|---|---|
| **1. Market data** | Frankfurter, ExchangeRate-API, Currency-API | `market_data` | USD strength = average of log(EUR, JPY, GBP, CNY per USD); rises when the dollar strengthens |
| **2. Wise rates** | Wise history, Wise comparisons | `rates_history`, `live_quotes` | History rows are `source='wise'` (official). Today's live rate goes in as `source='wise_live'` (provisional) and is replaced by the official value once Wise publishes it |
| **3. Score** | `predictions` + official `rates_history` | `prediction_errors` | For each forecast: predicted, actual, delta = actual − predicted, % miss. Only official rates count as "actual" |
| **4. Fill gaps** | stored rates, errors | `predictions` | On first deploy this replays all 90 days, so the learner starts with real statistics. Afterwards it only fills days the cron missed |
| **5. Learn + forecast** | rates, ECB series, errors | `model_stats`, `predictions` | 6 models × 31 days ahead, blended with learned weights. Re-running on the same day overwrites that day's forecast |
| **6. Housekeeping** | | `sync_runs` | Deletes predictions older than ~400 days and quotes older than 60 days, to stay within Neon's free 0.5 GB |

---

## What data is refreshed, how often, and why

| Data | Refreshed | Why this frequency |
|---|---|---|
| **Live Wise rate & provider comparison** (Today card, Send 1,000 SGD card) | On page view, cached **5 minutes**; also stored by each sync | The only number that genuinely changes minute to minute. A 5-minute cache keeps it current without calling Wise on every visit (avoids rate limits and blocking) |
| **Official daily rates** (past days in the month view) | Each sync (≈ daily) | Wise publishes one official point per day. Re-fetching 3 months also picks up any corrections |
| **ECB dollar-strength series** | Each sync | ECB publishes once per business day |
| **Cross-check rates** | Each sync | Sanity check of Wise; daily is plenty |
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
        Page->>Cache: live quote LKR / USD
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
    C --> D["Learner, last 60 days of deltas,<br/>per horizon bucket"]
    D --> D1["Model weights<br/>more accurate → more weight"]
    D --> D2["Bias correction<br/>only if proven helpful, ≤ 7 days"]
    D --> D3["80% range width<br/>from size of recent misses"]
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

The same row is written for each of the 6 models. Over the 60-day window:

- Models with smaller average misses at the 1-day horizon get more weight (weight ∝ 1 / miss⁴, shrunk toward
  average when there are few samples).
- If the blend has been running consistently high, a bias correction pulls the next forecast down. It is
  switched on only when the corrected variant has actually beaten the uncorrected one (≥ 20 samples) and
  only up to 7 days ahead. Backtests showed that correcting long horizons doubled the error, because
  long-horizon misses arrive weeks late, after the market has moved on.
- The 80% range shrinks or widens based on how big the misses really were.

Horizon buckets are learned separately: **1 day, 2–3, 4–7, 8–14, 15–31 days**. A model can be best for
tomorrow and poor for next month.

**No look-ahead.** A forecast made on day *t* only ever uses data known on day *t*. This holds for live
runs and for the 90-day replay, so backtest numbers are honest.

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
        text series PK "usd_basket, xc:CUR:source"
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

- Schema is created automatically (`CREATE TABLE IF NOT EXISTS`) on first use. No migrations to run.
- `predictions` is unique on (currency, made_on, target_date, model).
- `sync_lock` (single row) prevents two syncs at once.

---

## API endpoints

| Route | Method | Auth | Description |
|---|---|---|---|
| `/` | GET | none | The dashboard |
| `/api/dashboard` | GET | none | Everything on the page as JSON (CDN-cached 2 min) |
| `/api/cron/sync` | GET | `Authorization: Bearer $CRON_SECRET` | Runs a sync; returns `{ status, runDate, log, ms }`. Returns 401 without the secret |

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
  config.ts                 Currencies, horizons, windows, timezone
  dates.ts, format.ts       Date math (YYYY-MM-DD strings), number formatting
  db.ts                     Postgres client + schema
  sources/                  wise.ts, market.ts, http.ts (external APIs)
  predict/                  series.ts, models.ts, learning.ts, engine.ts (pure, no I/O)
  sync.ts                   The sync pipeline
  dashboard.ts              All read queries for the page
scripts/sync.ts             Run a sync from the command line
vercel.json                 Region sin1 + daily cron
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
5. Redeploy and open the site. The first visit triggers the initial sync (2 years of history + 90-day replay,
   ~10–20 s). Refresh after a minute.

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
npm run sync      # download history, replay 90 days, forecast
npm run dev       # http://localhost:3000
```

| Command | What it does |
|---|---|
| `npm run sync` | One full sync against `.env.local`'s database |
| `npm run dev` / `npm run build` / `npm start` | Next.js dev / production build / production server |
| `npm run lint`, `npx tsc --noEmit` | Lint, typecheck |

---

## Free-tier budget

| Service | Free limit (approx.) | RateCast usage |
|---|---|---|
| Vercel Hobby | Daily crons only; functions up to 300 s | 1 cron/day; sync ~2 s (first run ~20 s) |
| Neon Free | 0.5 GB storage, monthly compute cap, auto-suspend when idle | ~560 forecast rows/day; ~1 year kept ≈ < 50 MB; DB idle most of the day |
| Wise / ECB / other APIs | Public, keyless | ~7 calls per sync + at most 2 live Wise calls per 5 min while people are visiting |

---

## Accuracy: what to expect

Backtest on 9 Nov 2026: forecasts made in the last 60 days of a 90-day no-look-ahead replay, average miss
(%), final forecast vs "no change":

| | 1 day | 2–7 days | 8–14 days | 15–31 days |
|---|---|---|---|---|
| **SGD → LKR** | 0.126 vs 0.126 | 0.224 vs 0.221 | 0.275 vs 0.274 | 0.396 vs 0.399 |
| **SGD → USD** | 0.095 vs 0.093 | 0.190 vs 0.185 | 0.270 vs 0.241 | 0.380 vs 0.315 |

Exchange rates are close to unpredictable. Next-day forecasts match the "no change" baseline, which is about
as good as FX forecasting realistically gets. The page always shows the current numbers next to the baseline.
This is **not financial advice**.

---

## Limitations and known risks

- Wise endpoints are public but undocumented and may change shape without notice.
- Wise repeats Friday's rate over weekends, which makes weekend 1-day forecasts look artificially good.
- "Today" follows Singapore time; Wise daily points are midnight-UTC (08:00 SGT) snapshots.
- Until ~60 real days have passed, the accuracy panel partly reflects the initial 90-day replay.
- Forecasts between syncs start from the latest synced rate, not the current live one (see the
  "light refresh" idea in `docs/CONTEXT.md`).

---

## Further documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): exact learning formulas and internal details.
- [`docs/CONTEXT.md`](docs/CONTEXT.md): original requirements, design decisions, backtest log, backlog.
- [`AGENTS.md`](AGENTS.md) / [`CLAUDE.md`](CLAUDE.md): rules for AI coding agents working on this repo.

---
paths:
  - "lib/db.ts"
  - "lib/sync.ts"
  - "lib/dashboard.ts"
  - "scripts/**"
---

# Database rules (postgres.js v4 → Neon / local Postgres)

- Client: `db()` from `lib/db.ts`. One pooled client per process (`globalThis.__sql`), `prepare: false`
  (required by Neon's pooled pgbouncer endpoint), SSL off only for localhost.
- postgres.js v4 lets the **server** decide parameter types. Pass dates as `'YYYY-MM-DD'` strings, select them
  as `date::text`, and cast counts with `::int`. Rates are `double precision` and come back as JS numbers.
- Bulk insert with `sql(rows, ...columns)` in chunks of ≤ 1000 rows.
- Schema lives in the `SCHEMA` string in `lib/db.ts` and runs via `ensureSchema()` on every cold start.
  **Only additive, idempotent DDL** (`CREATE TABLE/INDEX IF NOT EXISTS`, `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`).
- `currency` columns hold the **pair id**: `LKR` (SGD→LKR), `USD` (SGD→USD), `USDLKR` (USD→LKR). Never rename.
- Tables and what writes them:
  | table | written by | notes |
  |---|---|---|
  | `rates_history` | ingest | `source` = `wise` (official) or `wise_live` (provisional today) |
  | `live_quotes` | ingest | provider comparison JSON, pruned after 60 days |
  | `market_data` | ingest | `usd_basket`, `xc:<CUR>:<source>` cross-checks, `ust2y` (Treasury 2y %, US date), `brent` (FRED USD/bbl), `usd_broad` (FRED DTWEXBGS index, SGD→USD macro input), CBSL `lk_usd_spot`, `lk_sgd_ind` (daily fixings), `lk_opr`, `lk_tbill3m` (%), `lk_remit`, `lk_tourism` (USD mn, dated to month end), `lk_ccpi_yoy` (Colombo CPI YoY %, context only, source `cbsl-prices`) |
  | `predictions` | predict | unique (currency, made_on, target_date, model); **write-once** (`DO NOTHING`). `origin` live/replay, `model_version`. `ensemble`/`naive` kept forever, other models pruned after 550 days |
  | `prediction_errors` | evaluate SQL | the delta table; FK cascade from predictions |
  | `model_stats` | predict | JSON of `LearnedStats` per currency per day |
  | `events` | `ingestEvents` + `classifyOutcomes` (sync) | PK (kind, event_date). `known_since` gates replay (upsert keeps `LEAST`). `outcome` (added via `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`): `cut`/`hold`/`hike`, `sla`/`board`/`other`, `unclear`, or NULL until classified; the upsert never overwrites it. ~10 rows/year/kind |
  | `source_health` | `recordHealth` (sync) | PK source. Last ok / error / note per automatic source: fed-page, fed-json, cbsl-mpr, cbsl-rss, bls, outcomes, treasury, fred-brent, fred-usd-broad, cbsl-fx, cbsl-rates, cbsl-external, cbsl-prices, wise-history:*, wise-live:*, cross-rate |
  | `model_versions` | `backtestVersion` (sync step 4b) | PK version. One row per `MODEL_VERSION` that ran (`first_run`); `backtest` (JSON from `runBacktest`), `backtest_on`, `previous`, `comparison` written once, never updated. Step 4b runs only when the replay is complete (not `partial`), and the backtest is stored only when it finished inside its budget (page sync 50 s from sync start, `BACKTEST_BUDGET_MS`; cron 240 s, `CRON_BACKTEST_BUDGET_MS`) |
  | `learning_log` | predict (live run) | PK (currency, as_of, bucket, item). Append-only audit of promotions/demotions (model or `bias_correction`) vs the previous stored `model_stats`, with the deciding t |
  | `sync_runs`, `sync_lock` | runSync | lock row has an owner token and expires after `SYNC_LOCK_MINUTES` (6); `sync_runs.model_version` |
- **Scoring** (`evaluatePredictions`): `ANALYZE predictions, prediction_errors, rates_history` and then one `INSERT … SELECT` inside
  `sql.begin` with `SET LOCAL enable_nestloop = off`. After a 365-day replay (~454k rows on 2026-11-12) the planner otherwise
  chose nested loops and the insert took 13 min (8 s with the setting). Don't remove it.
- Neon free tier is 0.5 GB. Three pairs × 15 stored model rows (12 models + `blend`, `blend_bc`, `ensemble`) × 31 days ≈ 1,400 prediction rows/day. Keep pruning in place, and estimate rows/day before adding per-model or per-day data.
- Local inspection: `docker exec ratecast-pg psql -U postgres -d rates -c "<sql>"`.

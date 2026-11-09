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
- Tables and what writes them:
  | table | written by | notes |
  |---|---|---|
  | `rates_history` | ingest | `source` = `wise` (official) or `wise_live` (provisional today) |
  | `live_quotes` | ingest | provider comparison JSON, pruned after 60 days |
  | `market_data` | ingest | `usd_basket`, `xc:<CUR>:<source>` cross-checks |
  | `predictions` | predict | unique (currency, made_on, target_date, model); pruned after ~400 days |
  | `prediction_errors` | evaluate SQL | the delta table; FK cascade from predictions |
  | `model_stats` | predict | JSON of `LearnedStats` per currency per day |
  | `sync_runs`, `sync_lock` | runSync | lock row expires after 5 min |
- Neon free tier is 0.5 GB. Keep pruning in place, and estimate rows/day before adding per-model or per-day data.
- Local inspection: `docker exec ratecast-pg psql -U postgres -d rates -c "<sql>"`.

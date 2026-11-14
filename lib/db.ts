import postgres from "postgres";

type Sql = ReturnType<typeof postgres>;

const globalForDb = globalThis as unknown as { __sql?: Sql; __schemaReady?: Promise<void> };

export function hasDb(): boolean {
  return Boolean(process.env.DATABASE_URL || process.env.POSTGRES_URL);
}

export function db(): Sql {
  if (!globalForDb.__sql) {
    const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    const local = /localhost|127\.0\.0\.1/.test(url);
    globalForDb.__sql = postgres(url, {
      ssl: local ? false : "require",
      max: 3,
      idle_timeout: 20,
      connect_timeout: 15,
      prepare: false, // safe with Neon's pooled (pgbouncer) endpoint
      onnotice: () => {},
    });
  }
  return globalForDb.__sql;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rates_history (
  currency    text NOT NULL,
  date        date NOT NULL,
  rate        double precision NOT NULL,
  source      text NOT NULL DEFAULT 'wise',
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (currency, date)
);

CREATE TABLE IF NOT EXISTS live_quotes (
  id          bigserial PRIMARY KEY,
  currency    text NOT NULL,
  fetched_at  timestamptz NOT NULL DEFAULT now(),
  date        date NOT NULL,
  mid_rate    double precision NOT NULL,
  providers   jsonb NOT NULL DEFAULT '[]'::jsonb
);
CREATE INDEX IF NOT EXISTS live_quotes_cur_time ON live_quotes (currency, fetched_at DESC);

-- External market signals (USD basket from ECB/Frankfurter, cross-check rates, ...)
CREATE TABLE IF NOT EXISTS market_data (
  series      text NOT NULL,
  date        date NOT NULL,
  value       double precision NOT NULL,
  PRIMARY KEY (series, date)
);

-- Every forecast every model makes. model = one of MODELS (lib/predict/models.ts) or blend|blend_bc|ensemble
CREATE TABLE IF NOT EXISTS predictions (
  id            bigserial PRIMARY KEY,
  currency      text NOT NULL,
  made_on       date NOT NULL,
  target_date   date NOT NULL,
  horizon       int  NOT NULL,
  model         text NOT NULL,
  predicted     double precision NOT NULL,
  lower80       double precision,
  upper80       double precision,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (currency, made_on, target_date, model)
);
CREATE INDEX IF NOT EXISTS predictions_target ON predictions (currency, target_date, model);

-- The "delta" table: how close each prediction was once the real rate is known.
CREATE TABLE IF NOT EXISTS prediction_errors (
  prediction_id bigint PRIMARY KEY REFERENCES predictions(id) ON DELETE CASCADE,
  currency      text NOT NULL,
  model         text NOT NULL,
  made_on       date NOT NULL,
  target_date   date NOT NULL,
  horizon       int  NOT NULL,
  predicted     double precision NOT NULL,
  actual        double precision NOT NULL,
  delta         double precision NOT NULL,      -- actual - predicted
  pct_error     double precision NOT NULL,      -- (predicted - actual) / actual * 100
  log_error     double precision NOT NULL,      -- ln(predicted / actual)
  evaluated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS prediction_errors_lookup ON prediction_errors (currency, model, target_date);

-- Snapshot of what the learner concluded on each run (weights, bias), for transparency.
CREATE TABLE IF NOT EXISTS model_stats (
  currency    text NOT NULL,
  as_of       date NOT NULL,
  stats       jsonb NOT NULL,
  PRIMARY KEY (currency, as_of)
);

-- Policy events, fetched automatically (FOMC, CBSL reviews, IMF news, BLS CPI/jobs days). kind is data: never rename.
-- known_since = first day the event and its date were public (no-look-ahead gate for replay).
CREATE TABLE IF NOT EXISTS events (
  kind        text NOT NULL,                 -- fomc | cbsl_policy | imf | us_cpi | us_jobs
  event_date  date NOT NULL,                 -- announcement date (institution's local date)
  known_since date NOT NULL,
  source      text NOT NULL,                 -- fed-page | fed-json | cbsl-mpr | cbsl-rss | bls
  title       text NOT NULL,
  url         text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, event_date)
);

-- What was decided (cut | hold | hike for policy reviews; sla | board | other for IMF news).
-- Filled automatically after the announcement from the statement itself; 'unclear' if unparsable.
ALTER TABLE events ADD COLUMN IF NOT EXISTS outcome text;

-- Last outcome of each automatic scraper, so a broken source is visible instead of silent.
CREATE TABLE IF NOT EXISTS source_health (
  source        text PRIMARY KEY,
  last_ok_at    timestamptz,
  last_error_at timestamptz,
  last_error    text,
  last_note     text,
  last_count    int
);

-- Immutable forecast record (added 2026-11-13). origin: 'live' = made by the run on made_on, 'replay' =
-- reconstructed later from data known on made_on. model_version: MODEL_VERSION (+ git commit) that wrote it.
ALTER TABLE predictions ADD COLUMN IF NOT EXISTS origin text;
ALTER TABLE predictions ADD COLUMN IF NOT EXISTS model_version text;
-- Partial index: once every row has an origin it is empty, so the backfill below costs nothing.
CREATE INDEX IF NOT EXISTS predictions_origin_null ON predictions (id) WHERE origin IS NULL;
-- Rows written before these columns existed: a row created on its own made_on (SGT) was the live run.
UPDATE predictions SET origin = CASE WHEN (created_at AT TIME ZONE 'Asia/Singapore')::date = made_on THEN 'live' ELSE 'replay' END
  WHERE origin IS NULL;

CREATE TABLE IF NOT EXISTS sync_runs (
  id          bigserial PRIMARY KEY,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  run_date    date NOT NULL,
  status      text NOT NULL DEFAULT 'running',
  message     text
);
ALTER TABLE sync_runs ADD COLUMN IF NOT EXISTS model_version text;

-- Model version history (added 2026-11-13). One row per MODEL_VERSION that ran a sync. backtest = the
-- automatic 365-day in-memory replay of that code (lib/predict/backtest.ts), scored vs the random walk;
-- comparison = against the previous version that has a backtest. Written once per version, never updated.
CREATE TABLE IF NOT EXISTS model_versions (
  version      text PRIMARY KEY,
  first_run    date NOT NULL,
  backtest_on  date,
  backtest     jsonb,
  previous     text,
  comparison   jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Audit log of the learner: a model or the bias correction switched on (promoted) or off (demoted) in a
-- horizon bucket, with the paired t-statistic that decided it. Append-only.
CREATE TABLE IF NOT EXISTS learning_log (
  currency      text NOT NULL,
  as_of         date NOT NULL,
  bucket        int  NOT NULL,
  item          text NOT NULL,
  change        text NOT NULL,
  t_stat        double precision,
  model_version text,
  PRIMARY KEY (currency, as_of, bucket, item)
);

CREATE TABLE IF NOT EXISTS sync_lock (
  id        int PRIMARY KEY,
  locked_at timestamptz NOT NULL
);
`;

export function ensureSchema(): Promise<void> {
  if (!globalForDb.__schemaReady) {
    globalForDb.__schemaReady = db()
      .unsafe(SCHEMA)
      .then(() => undefined)
      .catch((e) => {
        globalForDb.__schemaReady = undefined;
        throw e;
      });
  }
  return globalForDb.__schemaReady;
}

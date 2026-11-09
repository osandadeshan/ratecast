# RateCast

SGD → LKR / USD rate forecasts that learn from their own misses.

Shows today's **SGD → LKR** and **SGD → USD** rates from Wise and a full-month view: past days use the actual
Wise rate and future days are forecasts. The forecasts improve themselves by recording how far off each
prediction was. No login. Everything runs on free tiers.

## What it does

| Piece | Source / how |
|---|---|
| Today's rate + provider comparison | Wise `gateway/v4/comparisons` (cached 5 min) |
| Daily history (2 years on first run) | Wise `rates/history` → `rates_history` table |
| Same day last month | Looked up from history; also used as a forecasting model |
| Market context | ECB reference rates via Frankfurter (USD strength vs EUR/JPY/GBP/CNY), cross-checks from ExchangeRate-API and Currency-API |
| Forecasts (next 31 days) | 6 models blended → `predictions` table |
| Learning | Misses → `prediction_errors` (the delta table) → model weights + bias correction → `model_stats` |

### Models
- **Random walk**: tomorrow equals today. This is the baseline to beat.
- **30-day drift**: average recent daily move, damped over the horizon.
- **Holt trend**: damped trend; its parameters are refit by grid search on every run.
- **Last months' same-day path**: how the rate moved from this day-of-month in each of the last 3 months.
- **Mean reversion**: pulls back toward the 30-day average.
- **USD-strength**: this pair's sensitivity (beta) to the ECB USD basket × the basket's recent momentum.

### Auto-learn and correct
1. Every daily run stores each model's forecast for every one of the next 31 days.
2. When Wise publishes the real rate for a date, each forecast for that date gets a row in `prediction_errors`
   (`predicted`, `actual`, `delta = actual − predicted`, `pct_error`). Example: you predicted 262.5 and the
   actual was 262.0, so delta = −0.5 and pct_error = +0.19%.
3. The next run uses the last 60 days of deltas, per horizon bucket (1d, 2–3d, 4–7d, 8–14d, 15–31d), to
   - **re-weight models**: models that missed less get more weight;
   - **correct systematic bias**: if the blend kept running high or low, the forecast is shifted. This
     correction is only used where it has actually reduced errors, and only for horizons up to 7 days;
   - **size the 80% range** from the real spread of recent misses.
4. On the first run the app replays the past 90 days (using only data that was available on each day), so
   the learner starts with real statistics instead of zero.

Be realistic: exchange rates are close to a random walk. Expect forecasts that are roughly as good as "no
change" and sometimes a little better. The page shows the forecast's accuracy next to the random walk's, so
you can see the actual numbers.

## Deploy to Vercel (free)

1. Push this folder to a GitHub repo.
2. On vercel.com: **Add New → Project →** import the repo. The defaults are fine.
3. In the project: **Storage → Create Database → Neon (Postgres, Free)** and connect it to the project.
   This sets `DATABASE_URL` automatically.
4. **Settings → Environment Variables**: add `CRON_SECRET` with any long random string
   (`openssl rand -hex 32`).
5. Redeploy. Open the site: the first visit kicks off the initial sync (history download plus 90-day
   replay, about 10–20 s). Refresh after a minute.

After that, the Vercel Cron in `vercel.json` runs `/api/cron/sync` daily at 01:30 UTC (09:30 SGT). If a run is
ever missed, the next page visit triggers it in the background, and missed days are replayed.

Free-tier fit: Vercel Hobby (1 daily cron, functions ≤ 300 s), Neon Free (0.5 GB; this app keeps about a
year of predictions, well under 50 MB). All data APIs are free and need no keys.

## Run locally

```bash
docker run -d --name ratecast-pg -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=rates -p 54329:5432 postgres:16-alpine
echo 'DATABASE_URL=postgres://postgres:dev@localhost:54329/rates' > .env.local
npm install
npm run sync      # download history, replay, forecast
npm run dev       # http://localhost:3000
```

`GET /api/dashboard` returns everything on the page as JSON.

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

## Key decisions
| decision | why |
|---|---|
| Next.js 16 App Router on Vercel Hobby | free, cron included, the owner asked for Vercel |
| Neon Postgres (Vercel Marketplace, free) | free, auto-injects `DATABASE_URL`; postgres.js works locally too |
| One daily cron + `after()` self-heal | Hobby allows daily crons only; a missed run is caught by the next visit |
| Ensemble of simple models, weights learned from deltas | FX is near-random; transparent and cheap; learns which model works per horizon |
| Keep `naive` as a model and show it in the UI | the honest baseline; the learner can fall back to it |
| Gated bias correction (≤ 7 days, only if proven) | ungated, it doubled long-horizon error in backtests |
| 90-day no-lookahead replay on first run | the learner starts with real stats instead of an empty table |
| ECB basket as the "financial situation" signal | free, keyless, daily; LKR has no free macro feed |
| Wise endpoints called without `wiseFee`/`midMarketRate` params | optional; the response is the same |

## Backtest results
Replay of 90 days, scored on forecasts made in the last 60 days. Average |% miss|, `ensemble` vs `naive`.

| date | currency | 1 day | 2–7 days | 8–14 days | 15–31 days |
|---|---|---|---|---|---|
| 2026-11-09 | LKR | 0.126 / 0.126 | 0.224 / 0.221 | 0.275 / 0.274 | 0.396 / 0.399 |
| 2026-11-09 | USD | 0.095 / 0.093 | 0.190 / 0.185 | 0.270 / 0.241 | 0.380 / 0.315 |

What this means: next-day forecasts match the random walk, which is about as good as FX forecasting gets.
USD long horizons are currently worse than the random walk, because trend models were rewarded in an earlier
regime. The learner should shift weight to `naive`/`holt` over time. Watch this.

## Known limitations / risks
- **Wise may block Vercel IPs** (untested at the time of writing). The live quote and sync would fail; check
  with the `verify-deploy` skill.
- Wise endpoints are undocumented/public and could change shape without notice.
- Weekends: Wise history repeats Friday's value, which inflates "perfect" 1-day hits on weekends.
- "Today" uses Singapore time, while Wise daily points are UTC-midnight snapshots (08:00 SGT).
- Accuracy stats on the page include the replayed backtest period until real days replace them (~60 days).

## Ideas backlog (not started)
- Fallback live rate from cross-check sources when Wise fails.
- A USD/LKR-specific signal (CBSL publishes rates, but no free stable API was found).
- Weekday-aware evaluation that skips weekend duplicates.
- Email/notification when tomorrow's forecast moves > x% (would need a free mail provider).

## Environment
| var | where | purpose |
|---|---|---|
| `DATABASE_URL` | Vercel (auto from Neon), `.env.local` | Postgres connection |
| `CRON_SECRET` | Vercel env | protects `/api/cron/sync` |

Repo: https://github.com/osandadeshan/ratecast · Local DB container: `ratecast-pg` (port 54329).

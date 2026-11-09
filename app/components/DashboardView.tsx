"use client";

import { useState } from "react";
import type { CurrencyDashboard, Dashboard } from "@/lib/dashboard";
import { fmt, pct, shortDate, weekday } from "@/lib/format";
import { MODEL_LABELS } from "@/lib/predict/models";
import MonthChart from "./MonthChart";

export default function DashboardView({ data }: { data: Dashboard }) {
  const [tab, setTab] = useState(0);
  const choose = (i: number) => setTab(i);
  const c = data.currencies[tab];

  return (
    <main className="mx-auto w-full min-w-0 max-w-6xl px-4 sm:px-6 py-6 sm:py-10 space-y-6">
      <header className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight">RateCast</h1>
          <p className="text-sm text-ink-2 mt-1">
            Wise mid-market rates, with forecasts that learn from their own misses.
          </p>
        </div>
        <div role="tablist" aria-label="Target currency" className="inline-flex rounded-xl bg-surface-2 p-1 self-start">
          {data.currencies.map((cur, i) => (
            <button
              key={cur.target}
              role="tab"
              aria-selected={i === tab}
              onClick={() => choose(i)}
              className={`px-4 py-1.5 rounded-lg text-sm font-medium transition ${
                i === tab ? "bg-surface text-ink shadow-sm" : "text-ink-2 hover:text-ink"
              }`}
            >
              SGD → {cur.target}
            </button>
          ))}
        </div>
      </header>

      {!data.dbConfigured && (
        <Notice>
          No database is connected, so only today&apos;s live rate is shown. Add a free Neon Postgres database in Vercel
          (Storage → Neon) to turn on history, forecasts and learning.
        </Notice>
      )}
      {data.dbConfigured && !data.lastSync && (
        <Notice>
          First run: the app is downloading history and replaying the last 90 days to train itself. Refresh in about a
          minute.
        </Notice>
      )}

      <TodaySection c={c} />
      <ChartSection c={c} today={data.today} monthLabel={data.monthLabel} />
      <div className="grid lg:grid-cols-5 gap-6">
        <div className="lg:col-span-3 space-y-6 min-w-0">
          <MonthTable c={c} />
        </div>
        <div className="lg:col-span-2 space-y-6 min-w-0">
          <ProvidersCard c={c} />
          <MarketCard c={c} />
        </div>
      </div>
      <LearningSection c={c} />

      <footer className="text-xs text-ink-3 pb-6 space-y-1">
        <p>
          Rates: Wise (history and comparisons). Cross-checks: ExchangeRate-API, Currency-API. Market signal: ECB
          reference rates via Frankfurter. Times in Singapore (SGT).
          {data.lastSync && (
            <>
              {" "}
              Last model run {new Date(data.lastSync.at).toLocaleString("en-SG", { timeZone: "Asia/Singapore" })} (
              {data.lastSync.status}).
            </>
          )}
        </p>
        <p>Forecasts are statistical estimates, not financial advice. Exchange rates are close to unpredictable.</p>
      </footer>
    </main>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return <div className="card px-4 py-3 text-sm text-ink-2 border-l-4" style={{ borderLeftColor: "var(--accent)" }}>{children}</div>;
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: React.ReactNode; tone?: "lead" }) {
  return (
    <div className="card p-4 sm:p-5 min-w-0">
      <div className="text-xs text-ink-3 uppercase tracking-wide">{label}</div>
      <div className={`num mt-1.5 font-semibold tracking-tight ${tone === "lead" ? "text-3xl sm:text-4xl" : "text-xl sm:text-2xl"}`}>
        {value}
      </div>
      {sub && <div className="text-xs text-ink-2 mt-1.5">{sub}</div>}
    </div>
  );
}

function Change({ from, to }: { from: number | null | undefined; to: number | null | undefined }) {
  if (!from || !to) return null;
  const p = (to / from - 1) * 100;
  const up = p > 0;
  return (
    <span className="num font-medium" style={{ color: Math.abs(p) < 0.005 ? "var(--text-2)" : up ? "var(--good-text)" : "var(--critical)" }}>
      {Math.abs(p) < 0.005 ? "▬" : up ? "▲" : "▼"} {pct(p, 2)}
    </span>
  );
}

function TodaySection({ c }: { c: CurrencyDashboard }) {
  const d = c.decimals;
  const live = c.live?.midRate ?? null;
  return (
    <section className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4" aria-label="Today">
      <div className="col-span-2 lg:col-span-1">
        <Stat
          tone="lead"
          label={`Today · 1 SGD`}
          value={live ? `${fmt(live, d)}` : "—"}
          sub={
            live ? (
              <>
                {c.target} · Wise mid-market
                {c.live && (
                  <>
                    {" "}· {new Date(c.live.fetchedAt).toLocaleTimeString("en-SG", { timeZone: "Asia/Singapore", hour: "2-digit", minute: "2-digit" })}
                    {c.liveSource === "db" && " (cached)"}
                  </>
                )}
                {c.previousClose && (
                  <div className="mt-1">
                    <Change from={c.previousClose.rate} to={live} /> vs {shortDate(c.previousClose.date)}
                  </div>
                )}
              </>
            ) : (
              "Live rate unavailable"
            )
          }
        />
      </div>
      <Stat
        label="Same day last month"
        value={fmt(c.lastMonthSameDay?.rate, d)}
        sub={
          c.lastMonthSameDay ? (
            <>
              {shortDate(c.lastMonthSameDay.date)} · now <Change from={c.lastMonthSameDay.rate} to={live} />
            </>
          ) : (
            "No data yet"
          )
        }
      />
      <Stat
        label="Tomorrow (predicted)"
        value={fmt(c.tomorrow?.predicted, d)}
        sub={
          c.tomorrow?.lower80 != null ? (
            <>80% range {fmt(c.tomorrow.lower80, d)} – {fmt(c.tomorrow.upper80, d)}</>
          ) : (
            "Waiting for first model run"
          )
        }
      />
      <Stat
        label={c.monthEnd ? `Month end · ${shortDate(c.monthEnd.date)}` : "Month end"}
        value={fmt(c.monthEnd?.predicted, d)}
        sub={
          c.monthEnd?.predicted != null ? (
            <>
              <Change from={live} to={c.monthEnd.predicted} /> from today
            </>
          ) : (
            "Last day of the month"
          )
        }
      />
    </section>
  );
}

function ChartSection({ c, today, monthLabel }: { c: CurrencyDashboard; today: string; monthLabel: string }) {
  return (
    <section className="card p-4 sm:p-6 min-w-0">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-4">
        <h2 className="text-lg font-semibold">
          {monthLabel} · SGD → {c.target}
        </h2>
        <span className="text-xs text-ink-3">Past days: actual Wise rate · future days: forecast</span>
      </div>
      <MonthChart month={c.month} today={today} decimals={c.decimals} target={c.target} />
    </section>
  );
}

function MonthTable({ c }: { c: CurrencyDashboard }) {
  const d = c.decimals;
  return (
    <section className="card overflow-hidden">
      <div className="px-4 sm:px-6 pt-5 pb-3">
        <h2 className="text-lg font-semibold">Day by day</h2>
        <p className="text-xs text-ink-3 mt-0.5">
          &ldquo;Predicted&rdquo; for a past day is the latest forecast made before that day; &ldquo;Miss&rdquo; is actual − predicted.
        </p>
      </div>
      <div className="max-h-[560px] overflow-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-surface text-xs text-ink-3 text-left">
            <tr className="border-b border-line">
              <th className="font-medium px-4 sm:px-6 py-2">Date</th>
              <th className="font-medium px-2 py-2 text-right">Actual</th>
              <th className="font-medium px-2 py-2 text-right">Predicted</th>
              <th className="font-medium px-2 py-2 text-right hidden sm:table-cell">Miss</th>
              <th className="font-medium px-4 sm:px-6 py-2 text-right">Last month</th>
            </tr>
          </thead>
          <tbody>
            {c.month.map((m) => (
              <tr
                key={m.date}
                className="border-b border-line last:border-0"
                style={m.kind === "today" ? { background: "var(--surface-2)" } : undefined}
              >
                <td className="px-4 sm:px-6 py-2 whitespace-nowrap">
                  <span className="num">{shortDate(m.date)}</span>{" "}
                  <span className="text-ink-3 text-xs">{m.kind === "today" ? "Today" : weekday(m.date)}</span>
                </td>
                <td className="num px-2 py-2 text-right">
                  {m.actual !== null ? (
                    <>
                      {fmt(m.actual, d)}
                      {m.provisional && <span className="text-ink-3 text-xs" title="Live quote; replaced by Wise's daily rate tomorrow"> live</span>}
                    </>
                  ) : (
                    <span className="text-ink-3">—</span>
                  )}
                </td>
                <td className={`num px-2 py-2 text-right ${m.kind === "future" ? "font-medium" : "text-ink-2"}`}>
                  {fmt(m.predicted, d)}
                </td>
                <td className="num px-2 py-2 text-right hidden sm:table-cell">
                  {m.delta !== null ? (
                    <span title={`${pct(-m.pctError!, 3)} vs prediction`} className="text-ink-2">
                      {m.delta > 0 ? "+" : ""}
                      {fmt(m.delta, d)}
                    </span>
                  ) : (
                    <span className="text-ink-3">—</span>
                  )}
                </td>
                <td className="num px-4 sm:px-6 py-2 text-right text-ink-2">{fmt(m.lastMonth, d)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ProvidersCard({ c }: { c: CurrencyDashboard }) {
  const providers = c.live?.providers ?? [];
  const d = c.decimals;
  return (
    <section className="card p-4 sm:p-5 min-w-0">
      <h2 className="text-lg font-semibold">Send 1,000 SGD today</h2>
      <p className="text-xs text-ink-3 mt-0.5 mb-3">What the recipient gets, by provider (Wise comparison, bank transfer).</p>
      {providers.length === 0 ? (
        <p className="text-sm text-ink-3">Comparison unavailable right now.</p>
      ) : (
        <ul className="space-y-2.5">
          {providers.map((p, i) => (
            <li key={p.alias} className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-medium truncate">
                  {p.name}
                  {i === 0 && (
                    <span className="ml-2 text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-surface-2 text-ink-2">
                      best
                    </span>
                  )}
                </div>
                <div className="text-xs text-ink-3 num">
                  rate {fmt(p.rate, d)} · fee {fmt(p.fee, 2)} SGD
                </div>
              </div>
              <div className="num text-sm font-semibold whitespace-nowrap">
                {fmt(p.received, 2)} {c.target}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function MarketCard({ c }: { c: CurrencyDashboard }) {
  const m = c.market;
  const d = c.decimals;
  return (
    <section className="card p-4 sm:p-5">
      <h2 className="text-lg font-semibold">Market context</h2>
      <p className="text-xs text-ink-3 mt-0.5 mb-3">Signals the models use alongside the rate history.</p>
      <dl className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt className="text-xs text-ink-3">30-day trend</dt>
          <dd className="num font-medium">{pct(m.trend30dPct)}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-3">Daily volatility (30d)</dt>
          <dd className="num font-medium">{pct(m.vol30dPct, 3, false)}</dd>
        </div>
        <div className="col-span-2">
          <dt className="text-xs text-ink-3">US dollar strength vs EUR/JPY/GBP/CNY (30d, ECB)</dt>
          <dd className="num font-medium">
            {pct(m.usdBasket30dPct)}{" "}
            <span className="text-ink-3 font-normal text-xs">
              {m.usdBasket30dPct == null ? "" : m.usdBasket30dPct > 0 ? "USD strengthening" : "USD weakening"}
            </span>
          </dd>
        </div>
      </dl>
      {m.crossChecks.length > 0 && (
        <div className="mt-4">
          <div className="text-xs text-ink-3 mb-1.5">Cross-check vs other sources</div>
          <ul className="text-sm space-y-1">
            {m.crossChecks.map((x) => (
              <li key={x.source} className="flex justify-between gap-3">
                <span className="text-ink-2">{x.source}</span>
                <span className="num">
                  {fmt(x.rate, d)} <span className="text-ink-3 text-xs">({pct(x.diffPct, 2)} vs Wise)</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function LearningSection({ c }: { c: CurrencyDashboard }) {
  const d = c.decimals;
  const s = c.stats;
  const models = s ? Object.keys(s.buckets[0].weights) : [];
  return (
    <section className="card p-4 sm:p-6 space-y-6 min-w-0">
      <div>
        <h2 className="text-lg font-semibold">How the predictor learns</h2>
        <p className="text-sm text-ink-2 mt-1 max-w-3xl">
          Every forecast is stored. When Wise publishes the real rate for that day, the miss (delta) is written to a
          learning table. Each run, the last {s?.windowDays ?? 60} days of misses set how much each model is trusted at
          each forecast horizon. They also set a bias correction, which is switched on only when it has actually
          reduced errors.
        </p>
      </div>

      <div className="grid lg:grid-cols-2 gap-6 [&>*]:min-w-0">
        <div>
          <h3 className="text-sm font-semibold mb-2">Accuracy, last 60 days</h3>
          <div className="overflow-x-auto"><table className="w-full text-sm min-w-[340px]">
            <thead className="text-xs text-ink-3 text-left">
              <tr className="border-b border-line">
                <th className="font-medium py-1.5">Horizon</th>
                <th className="font-medium py-1.5 text-right">Avg miss</th>
                <th className="font-medium py-1.5 text-right" title="Random walk = 'tomorrow equals today'">
                  Random walk
                </th>
                <th className="font-medium py-1.5 text-right">Within 0.25%</th>
                <th className="font-medium py-1.5 text-right">n</th>
              </tr>
            </thead>
            <tbody>
              {c.accuracy.map((a) => (
                <tr key={a.bucket} className="border-b border-line last:border-0">
                  <td className="py-1.5">{a.label}</td>
                  <td className="num py-1.5 text-right font-medium">{pct(a.ensembleMae, 3, false)}</td>
                  <td className="num py-1.5 text-right text-ink-2">{pct(a.naiveMae, 3, false)}</td>
                  <td className="num py-1.5 text-right">{a.within == null ? "—" : `${a.within.toFixed(0)}%`}</td>
                  <td className="num py-1.5 text-right text-ink-3">{a.n}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </div>

        <div>
          <h3 className="text-sm font-semibold mb-2">Recent next-day forecasts vs actual</h3>
          <table className="w-full text-sm">
            <thead className="text-xs text-ink-3 text-left">
              <tr className="border-b border-line">
                <th className="font-medium py-1.5">Day</th>
                <th className="font-medium py-1.5 text-right">Predicted</th>
                <th className="font-medium py-1.5 text-right">Actual</th>
                <th className="font-medium py-1.5 text-right">Delta</th>
              </tr>
            </thead>
            <tbody>
              {c.recentDeltas.slice(0, 8).map((r) => (
                <tr key={r.targetDate} className="border-b border-line last:border-0">
                  <td className="num py-1.5">{shortDate(r.targetDate)}</td>
                  <td className="num py-1.5 text-right text-ink-2">{fmt(r.predicted, d)}</td>
                  <td className="num py-1.5 text-right">{fmt(r.actual, d)}</td>
                  <td className="num py-1.5 text-right">
                    {r.delta > 0 ? "+" : ""}
                    {fmt(r.delta, d)} <span className="text-ink-3 text-xs">{pct(-r.pctError, 2)}</span>
                  </td>
                </tr>
              ))}
              {c.recentDeltas.length === 0 && (
                <tr>
                  <td colSpan={4} className="py-3 text-ink-3">
                    No evaluated forecasts yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {s && (
        <div>
          <h3 className="text-sm font-semibold mb-2">Current model weights by horizon</h3>
          <div className="overflow-x-auto -mx-4 sm:mx-0 px-4 sm:px-0">
            <table className="w-full text-sm min-w-[560px]">
              <thead className="text-xs text-ink-3 text-left">
                <tr className="border-b border-line">
                  <th className="font-medium py-1.5">Model</th>
                  {s.buckets.map((b) => (
                    <th key={b.bucket} className="font-medium py-1.5 text-right">
                      ≤{b.bucket}d
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {models.map((m) => (
                  <tr key={m} className="border-b border-line">
                    <td className="py-1.5 text-ink-2">{MODEL_LABELS[m] ?? m}</td>
                    {s.buckets.map((b) => (
                      <td key={b.bucket} className="py-1.5 text-right">
                        <WeightCell w={b.weights[m]} mae={b.mae[m]} />
                      </td>
                    ))}
                  </tr>
                ))}
                <tr>
                  <td className="py-1.5 text-ink-2">Bias correction</td>
                  {s.buckets.map((b) => (
                    <td key={b.bucket} className="num py-1.5 text-right text-xs">
                      {b.biasOn ? (
                        <span style={{ color: "var(--good-text)" }}>✓ on {pct(-b.bias * 100, 3)}</span>
                      ) : (
                        <span className="text-ink-3">off</span>
                      )}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
          <p className="text-xs text-ink-3 mt-2">
            Bar = share of the final forecast; hover for the model&apos;s average miss. &ldquo;Last months&apos; same-day path&rdquo;
            replays how the rate moved from this date in each of the previous three months.
          </p>
        </div>
      )}
    </section>
  );
}

function WeightCell({ w, mae }: { w: number; mae: number | null }) {
  return (
    <span className="inline-flex items-center justify-end gap-2" title={mae == null ? "no data yet" : `avg miss ${mae.toFixed(3)}%`}>
      <span className="hidden sm:inline-block h-1.5 w-12 rounded-full bg-surface-2 overflow-hidden">
        <span className="block h-full rounded-full" style={{ width: `${Math.round(w * 100)}%`, background: "var(--series-1)" }} />
      </span>
      <span className="num text-xs w-8">{Math.round(w * 100)}%</span>
    </span>
  );
}

"use client";

import { useState } from "react";
import type { CurrencyDashboard, Dashboard } from "@/lib/dashboard";
import { fmt, pct, shortDate, weekday } from "@/lib/format";
import { EVENT_KINDS } from "@/lib/predict/events";
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
            Wise mid-market rates for SGD → LKR, SGD → USD and USD → LKR, with forecasts that learn from their own
            misses.
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
              {cur.label}
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
          First run: the app is downloading history and replaying the last year to train itself. Refresh in a minute or
          two.
        </Notice>
      )}

      <TodaySection c={c} />
      <ChartSection c={c} today={data.today} monthLabel={data.monthLabel} />
      <PerformanceCard c={c} hardest={data.hardest} codeVersion={data.modelVersion} />
      <div className="grid lg:grid-cols-5 gap-6">
        <div className="lg:col-span-3 space-y-6 min-w-0">
          <MonthTable c={c} />
        </div>
        <div className="lg:col-span-2 space-y-6 min-w-0">
          <ProvidersCard c={c} />
          <MarketCard c={c} macro={data.macro} health={data.events.health.filter((h) => MACRO_SOURCES.has(h.source))} />
          <EventsCard c={c} events={data.events} />
        </div>
      </div>
      <LearningSection c={c} />
      <VersionsCard data={data} />
      <SourcesCard data={data} />

      <footer className="text-xs text-ink-3 pb-6 space-y-1">
        <p>
          Rates: Wise (history and comparisons). Cross-checks: ExchangeRate-API, Currency-API, CBSL official rates.
          Market signals: ECB reference rates via Frankfurter, US Treasury yields, Brent oil (FRED), Central Bank of
          Sri Lanka data (policy rate, T-bill yields, remittances, tourism). Policy calendars: US Federal Reserve,
          Central Bank of Sri Lanka. Times in Singapore (SGT).
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
          label={`Today · 1 ${c.base}`}
          value={live ? `${fmt(live, d)}` : "—"}
          sub={
            live ? (
              <>
                {c.quote} · Wise mid-market
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
          {monthLabel} · {c.label}
        </h2>
        <span className="text-xs text-ink-3">Past days: actual Wise rate · future days: forecast</span>
      </div>
      <MonthChart month={c.month} today={today} decimals={c.decimals} target={c.quote} />
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
          &ldquo;Predicted&rdquo; for a past day is the latest forecast made before that day, as stored then; &ldquo;Miss&rdquo; is predicted − actual (+ = forecast too high).
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
                    <span title={`${pct(m.pctError!, 3)} · forecast too ${m.delta > 0 ? "high" : m.delta < 0 ? "low" : "exact"}`} className="text-ink-2">
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
      <h2 className="text-lg font-semibold">Send 1,000 {c.base} today</h2>
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
                  rate {fmt(p.rate, d)} · fee {fmt(p.fee, 2)} {c.base}
                </div>
              </div>
              <div className="num text-sm font-semibold whitespace-nowrap">
                {fmt(p.received, 2)} {c.quote}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function MarketCard({
  c,
  macro,
  health,
}: {
  c: CurrencyDashboard;
  macro: Dashboard["macro"];
  health: Dashboard["events"]["health"];
}) {
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
        {macro.filter((f) => !f.lanka || c.quote === "LKR").map((f) => (
          <div key={f.series}>
            <dt className="text-xs text-ink-3">
              {f.label} <span className="whitespace-nowrap">· {shortDate(f.date)}</span>
            </dt>
            <dd className="num font-medium">
              {f.format === "pct"
                ? `${f.value.toFixed(2)}%`
                : f.format === "usd"
                  ? `$${f.value.toFixed(2)}`
                  : f.format === "usdmn"
                    ? `$${f.value.toFixed(0)}m`
                    : f.format === "index"
                      ? f.value.toFixed(2)
                      : `${f.value.toFixed(2)} LKR`}{" "}
              <span className="text-ink-3 font-normal text-xs">
                {f.change30d == null
                  ? ""
                  : f.unit === "pp"
                    ? `${f.change30d >= 0 ? "+" : ""}${f.change30d.toFixed(2)} pp 30d`
                    : `${pct(f.change30d)}${f.label.includes("year earlier") ? "" : " 30d"}`}
              </span>
            </dd>
          </div>
        ))}
      </dl>
      {macro.length > 0 && (
        <p className="text-xs text-ink-3 mt-2">
          These feed the &ldquo;US yields + oil&rdquo;{c.quote === "LKR" ? <> and &ldquo;Sri Lanka data (CBSL)&rdquo;</> : null}{" "}
          models. Like every model, they only count once they beat the random walk by a clear margin.
        </p>
      )}
      {health
        .filter((h) => !h.ok)
        .map((h) => (
          <p key={h.source} className="text-xs mt-1" style={{ color: "var(--critical)" }}>
            {h.label}: not read since {h.lastOkAt ? shortDate(h.lastOkAt.slice(0, 10)) : "setup"}
            {h.error ? ` (${h.error.slice(0, 80)})` : ""}.
          </p>
        ))}
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

/** Health rows that belong to the Market context card rather than Policy events. */
const MACRO_SOURCES = new Set([
  "treasury",
  "fred-brent",
  "fred-usd-broad",
  "cbsl-fx",
  "cbsl-rates",
  "cbsl-external",
  "cbsl-prices",
  "wise-history:LKR",
  "wise-history:USD",
  "wise-history:USDLKR",
]);

const OUTCOME_LABEL: Record<string, string> = {
  cut: "cut",
  hold: "hold",
  hike: "hike",
  sla: "staff deal",
  board: "approved",
};

function EventsCard({ c, events }: { c: CurrencyDashboard; events: Dashboard["events"] }) {
  const stats = c.stats?.events ?? [];
  const effect = (kind: string) => {
    const s = stats.find((x) => x.kind === kind);
    const shown = !(EVENT_KINDS as Record<string, { widens: boolean }>)[kind]?.widens;
    if (shown && s && s.n >= 4 && s.ratio >= 1.05)
      return `past moves ≈ ${Math.sqrt(s.ratio).toFixed(1)}× a normal day (${s.n} past) · shown only: the range already covers these days`;
    if (shown) return "shown only · range unchanged";
    if (!s || s.n < 4) return "not enough past events yet · range unchanged";
    if (s.ratio < 1.05) return `no bigger moves than usual (${s.n} past) · range unchanged`;
    return `past moves ≈ ${Math.sqrt(s.ratio).toFixed(1)}× a normal day (${s.n} past) · range widened`;
  };
  const mine = events.health.filter((h) => !MACRO_SOURCES.has(h.source));
  const broken = mine.filter((h) => !h.ok);
  const notes = mine.filter((h) => h.ok && h.note);
  return (
    <section className="card p-4 sm:p-5 min-w-0">
      <h2 className="text-lg font-semibold">Policy events</h2>
      <p className="text-xs text-ink-3 mt-0.5 mb-3">
        Scheduled central-bank decisions, read automatically from the Fed and CBSL. They only widen the 80% range for
        {c.label}; the predicted number doesn&apos;t change, because nobody knows the decision in advance.
      </p>
      {events.upcoming.length === 0 ? (
        <p className="text-sm text-ink-3">No scheduled decisions in the next 75 days.</p>
      ) : (
        <ul className="space-y-2.5">
          {events.upcoming.slice(0, 5).map((e) => (
            <li key={`${e.kind}:${e.date}`} className="min-w-0">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-sm font-medium truncate">{e.label}</span>
                <span className="num text-sm whitespace-nowrap">
                  {shortDate(e.date)} <span className="text-ink-3 text-xs">{weekday(e.date)}</span>
                </span>
              </div>
              <div className="text-xs text-ink-3">{effect(e.kind)}</div>
            </li>
          ))}
        </ul>
      )}
      {events.recent.length > 0 && (
        <div className="mt-4">
          <div className="text-xs text-ink-3 mb-1.5">Recent</div>
          <ul className="text-sm space-y-1">
            {events.recent.slice(0, 4).map((e) => (
              <li key={`${e.kind}:${e.date}`} className="flex justify-between gap-3 min-w-0">
                {e.url ? (
                  <a href={e.url} target="_blank" rel="noopener noreferrer" className="text-ink-2 truncate hover:underline">
                    {e.kind === "imf" ? e.title : e.label}
                  </a>
                ) : (
                  <span className="text-ink-2 truncate">{e.kind === "imf" ? e.title : e.label}</span>
                )}
                <span className="num whitespace-nowrap">
                  {e.outcome && OUTCOME_LABEL[e.outcome] && (
                    <span className="mr-2 text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-surface-2 text-ink-2">
                      {OUTCOME_LABEL[e.outcome]}
                    </span>
                  )}
                  {shortDate(e.date)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="text-xs text-ink-3 mt-3">
        Decisions are read from each statement. The &ldquo;post-announcement drift&rdquo; model tests whether rates keep
        moving after a cut, hold or hike; it only counts once that clearly beats the random walk.
      </p>
      {(broken.length > 0 || notes.length > 0) && (
        <ul className="mt-4 text-xs space-y-1">
          {broken.map((h) => (
            <li key={h.source} style={{ color: "var(--critical)" }}>
              {h.label}: not read since {h.lastOkAt ? shortDate(h.lastOkAt.slice(0, 10)) : "setup"}
              {h.error ? ` (${h.error.slice(0, 80)})` : ""}. Its events may be missing.
            </li>
          ))}
          {notes.map((h) => (
            <li key={h.source} className="text-ink-3">
              {h.label}: {h.note}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const PAIR_ONLY: Record<string, readonly string[]> = { lanka: ["LKR", "USDLKR"], cbsl_gap: ["LKR", "USDLKR"], cross: ["LKR"] };

function LearningSection({ c }: { c: CurrencyDashboard }) {
  const d = c.decimals;
  const s = c.stats;
  // Pair-specific models equal the random walk on other pairs: don't list them there.
  const models = s ? Object.keys(s.buckets[0].weights).filter((m) => !PAIR_ONLY[m] || PAIR_ONLY[m].includes(c.target)) : [];
  return (
    <section className="card p-4 sm:p-6 space-y-6 min-w-0">
      <div>
        <h2 className="text-lg font-semibold">How the predictor learns</h2>
        <p className="text-sm text-ink-2 mt-1 max-w-3xl">
          Every forecast is stored. When Wise publishes the real rate for that day, the miss (delta) is written to a
          learning table. Each run, the last {s?.windowDays ?? 180} days of misses are used to test every model, and the
          bias correction, against the random walk (&ldquo;tomorrow = today&rdquo;) at each horizon. Only those that are
          significantly better get a share of the forecast; the rest are still scored daily and switch on by
          themselves once they earn it. If none qualifies, the forecast is the random walk, which is the honest
          answer for exchange rates most of the time.
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
                    {fmt(r.delta, d)} <span className="text-ink-3 text-xs">{pct(r.pctError, 2)}</span>
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
                        <WeightCell w={b.weights[m]} mae={b.mae[m]} unused={b.promoted?.[m] === false} />
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

function WeightCell({ w, mae, unused }: { w: number; mae: number | null; unused?: boolean }) {
  if (unused) {
    return (
      <span
        className="text-xs text-ink-3"
        title={`scored daily, not used until it is significantly better than the random walk${mae == null ? "" : ` · avg miss ${mae.toFixed(3)}%`}`}
      >
        not used
      </span>
    );
  }
  return (
    <span className="inline-flex items-center justify-end gap-2" title={mae == null ? "no data yet" : `avg miss ${mae.toFixed(3)}%`}>
      <span className="hidden sm:inline-block h-1.5 w-12 rounded-full bg-surface-2 overflow-hidden">
        <span className="block h-full rounded-full" style={{ width: `${Math.round(w * 100)}%`, background: "var(--series-1)" }} />
      </span>
      <span className="num text-xs w-8">{Math.round(w * 100)}%</span>
    </span>
  );
}

const signed = (n: number, d: number) => `${n > 0 ? "+" : ""}${fmt(n, d)}`;

/** Yesterday's forecast vs actual, today's forecast vs the live rate, and rolling accuracy for this pair. */
function PerformanceCard({
  c,
  hardest,
  codeVersion,
}: {
  c: CurrencyDashboard;
  hardest: Dashboard["hardest"];
  codeVersion: string;
}) {
  const d = c.decimals;
  const p = c.performance;
  const y = c.daily.yesterday;
  const t = c.daily.today;
  const yDelta = y ? y.predicted - y.actual : null;
  const tDelta = t && t.live != null ? t.predicted - t.live : null;
  const verdict = (x: number | null) => (x == null ? "" : x > 0 ? "too high" : x < 0 ? "too low" : "exact");
  const usesBaseline = c.model.active.length === 0 || (c.model.active.length === 1 && c.model.active[0] === "naive");
  return (
    <section className="card p-4 sm:p-6 min-w-0" aria-label="Daily performance">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold">{c.label} · daily performance</h2>
        <span className="text-xs text-ink-3">Delta = predicted − actual (+ = forecast too high)</span>
      </div>

      <div className="grid sm:grid-cols-2 gap-4 mt-4">
        <div className="rounded-xl bg-surface-2 p-3 min-w-0">
          <div className="text-xs text-ink-3 uppercase tracking-wide">
            Yesterday{y ? ` · ${shortDate(y.date)}` : ""}
          </div>
          {y ? (
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1 mt-2 text-sm">
              <dt className="text-ink-3">Predicted</dt>
              <dd className="num text-right">{fmt(y.predicted, d)}</dd>
              <dt className="text-ink-3">Actual (Wise)</dt>
              <dd className="num text-right">{fmt(y.actual, d)}</dd>
              <dt className="text-ink-3">Delta</dt>
              <dd className="num text-right font-medium">
                {signed(yDelta!, d)} <span className="text-ink-3 text-xs">{verdict(yDelta)}</span>
              </dd>
              <dt className="text-ink-3">Error</dt>
              <dd className="num text-right">{pct(Math.abs((yDelta! / y.actual) * 100), 3, false)}</dd>
              <dd className="col-span-2 text-xs text-ink-3">
                Forecast made {shortDate(y.madeOn)}
                {y.origin === "replay" ? " (rebuilt by the replay from data known that day)" : " (live)"}
              </dd>
            </dl>
          ) : (
            <p className="text-sm text-ink-3 mt-2">No scored next-day forecast yet.</p>
          )}
        </div>
        <div className="rounded-xl bg-surface-2 p-3 min-w-0">
          <div className="text-xs text-ink-3 uppercase tracking-wide">Today · {shortDate(c.month.find((m) => m.kind === "today")?.date ?? "")}</div>
          {t ? (
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1 mt-2 text-sm">
              <dt className="text-ink-3">Predicted</dt>
              <dd className="num text-right">{fmt(t.predicted, d)}</dd>
              <dt className="text-ink-3">Live (provisional)</dt>
              <dd className="num text-right">{fmt(t.live, d)}</dd>
              <dt className="text-ink-3">Delta so far</dt>
              <dd className="num text-right font-medium">
                {tDelta == null ? "—" : signed(tDelta, d)}{" "}
                <span className="text-ink-3 text-xs">{verdict(tDelta)}</span>
              </dd>
              <dd className="col-span-2 text-xs text-ink-3">
                Final once Wise publishes today&apos;s daily rate (tomorrow). Forecast made {shortDate(t.madeOn)}.
              </dd>
            </dl>
          ) : (
            <p className="text-sm text-ink-3 mt-2">No forecast was made for today.</p>
          )}
        </div>
      </div>

      {p && (
        <div className="grid lg:grid-cols-2 gap-6 mt-6 [&>*]:min-w-0">
          <div>
            <h3 className="text-sm font-semibold mb-2">Next-day forecasts, rolling</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[320px]">
                <thead className="text-xs text-ink-3 text-left">
                  <tr className="border-b border-line">
                    <th className="font-medium py-1.5">Window</th>
                    <th className="font-medium py-1.5 text-right" title="Mean absolute % error">MAPE</th>
                    <th className="font-medium py-1.5 text-right" title="Root mean squared % error">RMSE</th>
                    <th className="font-medium py-1.5 text-right" title="Mean absolute error in rate units">MAE</th>
                    <th className="font-medium py-1.5 text-right" title="'Tomorrow = today', same days">Random walk</th>
                    <th className="font-medium py-1.5 text-right">n</th>
                  </tr>
                </thead>
                <tbody>
                  {p.windows.map((w) => (
                    <tr key={w.days} className="border-b border-line last:border-0">
                      <td className="py-1.5">Last {w.days} days</td>
                      <td className="num py-1.5 text-right font-medium">{pct(w.mape, 3, false)}</td>
                      <td className="num py-1.5 text-right">{pct(w.rmse, 3, false)}</td>
                      <td className="num py-1.5 text-right">{fmt(w.mae, d)}</td>
                      <td className="num py-1.5 text-right text-ink-2">{pct(w.naiveMape, 3, false)}</td>
                      <td className="num py-1.5 text-right text-ink-3">{w.n}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div>
            <h3 className="text-sm font-semibold mb-2">By horizon, last 90 days</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[320px]">
                <thead className="text-xs text-ink-3 text-left">
                  <tr className="border-b border-line">
                    <th className="font-medium py-1.5">Ahead</th>
                    <th className="font-medium py-1.5 text-right">MAPE</th>
                    <th className="font-medium py-1.5 text-right">RMSE</th>
                    <th className="font-medium py-1.5 text-right">Random walk</th>
                    <th className="font-medium py-1.5 text-right" title="Share of actual rates inside the 80% range; ~80% is right">In 80% range</th>
                    <th className="font-medium py-1.5 text-right">n</th>
                  </tr>
                </thead>
                <tbody>
                  {p.horizons.map((h) => (
                    <tr key={h.horizon} className="border-b border-line last:border-0">
                      <td className="py-1.5">{h.horizon === 1 ? "1 day" : `${h.horizon} days`}</td>
                      <td className="num py-1.5 text-right font-medium">{pct(h.mape, 3, false)}</td>
                      <td className="num py-1.5 text-right">{pct(h.rmse, 3, false)}</td>
                      <td className="num py-1.5 text-right text-ink-2">{pct(h.naiveMape, 3, false)}</td>
                      <td className="num py-1.5 text-right">{h.coverage == null ? "—" : `${h.coverage.toFixed(0)}%`}</td>
                      <td className="num py-1.5 text-right text-ink-3">{h.n}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {p && (
        <dl className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4 mt-6 text-sm">
          <div>
            <dt className="text-xs text-ink-3">Systematic bias (next day, 90d)</dt>
            <dd className="font-medium">
              {p.bias.verdict === "none" ? "none detected" : p.bias.verdict === "not enough data" ? "not enough data" : `consistently ${p.bias.verdict}`}
            </dd>
            <dd className="text-xs text-ink-3 num">
              mean {pct(p.bias.meanPct, 3)}
              {p.bias.t != null ? ` · t = ${p.bias.t.toFixed(1)}` : ""}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-ink-3">Accuracy trend vs random walk</dt>
            <dd className="font-medium">{p.trend.verdict}</dd>
            <dd className="text-xs text-ink-3 num">
              last 30d {pct(p.trend.recent, 3)} · prior 30d {pct(p.trend.prior, 3)}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-ink-3">30-day outlook</dt>
            <dd className="font-medium">
              {c.outlook === "up" ? `${c.quote} weakening (rate up)` : c.outlook === "down" ? `${c.quote} strengthening (rate down)` : c.outlook ?? "—"}
            </dd>
            <dd className="text-xs text-ink-3">a direction only when today&apos;s rate is outside the forecast&apos;s 80% range</dd>
          </div>
          <div>
            <dt className="text-xs text-ink-3">Model status</dt>
            <dd className="font-medium">{usesBaseline ? "Random walk (no model validated yet)" : "Validated blend"}</dd>
            <dd className="text-xs text-ink-3">
              {usesBaseline
                ? "Candidates are scored daily; one switches on only after beating the random walk significantly."
                : `Using: ${c.model.active.map((m) => MODEL_LABELS[m] ?? m).join(", ")}`}
            </dd>
          </div>
        </dl>
      )}

      <p className="text-xs text-ink-3 mt-4">
        Model version {c.model.version ?? `${codeVersion} (today's forecast predates version tags)`} · trained {c.model.trainedOn ? shortDate(c.model.trainedOn) : "—"} · rate
        history since {c.model.historyFrom ? shortDate(c.model.historyFrom) : "—"} ({c.model.historyDays} days)
        {p && (
          <>
            {" "}· last 90 days scored: {p.origin.live} live forecasts, {p.origin.replay} rebuilt by the replay
          </>
        )}
        {hardest && (
          <>
            {" "}· hardest pair (30-day next-day error): <span className="text-ink-2">{hardest.label}</span>{" "}
            {pct(hardest.mape, 3, false)}
          </>
        )}
      </p>
    </section>
  );
}

/** Every stored series: what it feeds, history coverage, newest data, and what isn't integrated. */
function SourcesCard({ data }: { data: Dashboard }) {
  const broken = data.events.health.filter((h) => !h.ok);
  return (
    <section className="card p-4 sm:p-6 min-w-0" aria-label="Data sources">
      <h2 className="text-lg font-semibold">Data sources and freshness</h2>
      <p className="text-xs text-ink-3 mt-0.5 mb-3">
        What is actually integrated, how far back it goes and how recent it is. &ldquo;Late&rdquo; means older than that
        source normally is; forecasts then rely on older data for that input.
      </p>
      <div className="overflow-x-auto -mx-4 sm:mx-0 px-4 sm:px-0">
        <table className="w-full text-sm min-w-[560px]">
          <thead className="text-xs text-ink-3 text-left">
            <tr className="border-b border-line">
              <th className="font-medium py-1.5">Series</th>
              <th className="font-medium py-1.5">Feeds</th>
              <th className="font-medium py-1.5 text-right">History from</th>
              <th className="font-medium py-1.5 text-right">Latest data</th>
              <th className="font-medium py-1.5 text-right">Status</th>
            </tr>
          </thead>
          <tbody>
            {data.freshness.map((f) => (
              <tr key={f.series} className="border-b border-line last:border-0">
                <td className="py-1.5">{f.label}</td>
                <td className="py-1.5 text-ink-3 text-xs">{f.feeds}</td>
                <td className="num py-1.5 text-right text-ink-2">{f.first ? shortDate(f.first) + " " + f.first.slice(0, 4) : "—"}</td>
                <td className="num py-1.5 text-right">
                  {f.latest ? shortDate(f.latest) : "—"}
                  {f.ageDays != null && <span className="text-ink-3 text-xs"> · {f.ageDays}d</span>}
                </td>
                <td className="py-1.5 text-right text-xs">
                  {f.late ? <span style={{ color: "var(--critical)" }}>late</span> : <span style={{ color: "var(--good-text)" }}>ok</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="grid lg:grid-cols-2 gap-6 mt-4 [&>*]:min-w-0">
        <div>
          <h3 className="text-sm font-semibold mb-1">Scrapers and checks</h3>
          <ul className="text-xs space-y-1">
            {data.events.health.map((h) => (
              <li key={h.source} className="flex justify-between gap-3">
                <span className="text-ink-2 truncate">{h.label}</span>
                <span className="whitespace-nowrap" style={{ color: h.ok ? "var(--good-text)" : "var(--critical)" }}>
                  {h.ok ? "ok" : "failing"} · {h.lastOkAt ? shortDate(h.lastOkAt.slice(0, 10)) : "never"}
                </span>
              </li>
            ))}
          </ul>
          {broken.length > 0 && (
            <p className="text-xs mt-2" style={{ color: "var(--critical)" }}>
              {broken.length} source(s) failing. Forecasts carry on with the data already stored.
            </p>
          )}
        </div>
        <div>
          <h3 className="text-sm font-semibold mb-1">Not integrated (and why)</h3>
          <ul className="text-xs space-y-1.5">
            {data.notIntegrated.map((n) => (
              <li key={n.name}>
                <span className="text-ink-2">{n.name}</span> <span className="text-ink-3">· {n.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

const BUCKET_LABEL: Record<number, string> = { 1: "next day", 3: "2–3 days", 7: "4–7 days", 14: "8–14 days", 31: "15–31 days" };
const VERDICT_COLOR = { better: "var(--good-text)", worse: "var(--critical)", same: "var(--text-2)" } as const;

/** Model version history: each version's automatic one-year backtest and what the learner switched on or off. */
function VersionsCard({ data }: { data: Dashboard }) {
  const [latest, ...older] = data.versions;
  return (
    <section className="card p-4 sm:p-6 min-w-0" aria-label="Model versions">
      <h2 className="text-lg font-semibold">Model versions and learning log</h2>
      <p className="text-xs text-ink-3 mt-0.5 mb-3">
        When the forecasting code changes it gets a new version. Its first daily run replays the last year from the data
        known on each day, scores the last 300 days against the random walk, and compares the result with the previous
        version. Skill below 1.000 means smaller errors than &ldquo;no change&rdquo;.
      </p>
      {!latest ? (
        <p className="text-sm text-ink-2">No version has been backtested yet. It runs with the next daily update.</p>
      ) : (
        <>
          <p className="text-sm">
            Current version <span className="num font-medium">{latest.version}</span>
            <span className="text-ink-3 text-xs">
              {" "}
              · first run {shortDate(latest.firstRun)}
              {latest.backtestOn ? ` · backtested ${shortDate(latest.backtestOn)}` : " · backtest pending"}
            </span>
          </p>
          {latest.pairs.length > 0 && (
            <div className="overflow-x-auto -mx-4 sm:mx-0 px-4 sm:px-0 mt-2">
              <table className="w-full text-sm min-w-[520px]">
                <thead className="text-xs text-ink-3 text-left">
                  <tr className="border-b border-line">
                    <th className="font-medium py-1.5">Pair</th>
                    <th className="font-medium py-1.5 text-right">Error (all horizons)</th>
                    <th className="font-medium py-1.5 text-right">Random walk</th>
                    <th className="font-medium py-1.5 text-right">Skill</th>
                    <th className="font-medium py-1.5 text-right">In 80% range</th>
                    <th className="font-medium py-1.5 text-right">vs previous</th>
                  </tr>
                </thead>
                <tbody>
                  {latest.pairs.map((p) => {
                    const cmp = latest.comparison?.find((c) => c.pair === p.pair);
                    return (
                      <tr key={p.pair} className="border-b border-line last:border-0">
                        <td className="py-1.5">{p.label}</td>
                        <td className="num py-1.5 text-right">{pct(p.mae, 3, false)}</td>
                        <td className="num py-1.5 text-right text-ink-2">{pct(p.naiveMae, 3, false)}</td>
                        <td className="num py-1.5 text-right">{p.skill.toFixed(3)}</td>
                        <td className="num py-1.5 text-right text-ink-2">{p.coverage.toFixed(0)}%</td>
                        <td className="py-1.5 text-right text-xs">
                          {cmp ? (
                            <span style={{ color: VERDICT_COLOR[cmp.verdict] }}>
                              {cmp.verdict} ({cmp.prevSkill.toFixed(3)} → {cmp.skill.toFixed(3)})
                            </span>
                          ) : (
                            <span className="text-ink-3">first version</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {older.length > 0 && (
            <p className="text-xs text-ink-3 mt-2">
              Earlier: {older.map((v) => `${v.version} (from ${shortDate(v.firstRun)})`).join(" · ")}
            </p>
          )}
        </>
      )}
      <h3 className="text-sm font-semibold mt-4 mb-1">Learning log</h3>
      {data.learningLog.length === 0 ? (
        <p className="text-xs text-ink-3">
          No model or bias correction has been switched on or off since logging began. The forecast stays the random walk
          until a candidate beats it with a paired t-test (t &lt; −2.6) on at least 30 days.
        </p>
      ) : (
        <ul className="text-xs space-y-1">
          {data.learningLog.map((l) => (
            <li key={`${l.pair}-${l.date}-${l.bucket}-${l.item}`} className="flex justify-between gap-3">
              <span className="text-ink-2">
                {shortDate(l.date)} · {l.label} · {l.item === "bias_correction" ? "Bias correction" : (MODEL_LABELS[l.item] ?? l.item)},{" "}
                {BUCKET_LABEL[l.bucket] ?? `${l.bucket} days`}
              </span>
              <span className="whitespace-nowrap" style={{ color: l.change === "promoted" ? "var(--good-text)" : "var(--critical)" }}>
                {l.change === "promoted" ? "switched on" : "switched off"}
                {l.t != null && <span className="text-ink-3"> · t {l.t.toFixed(2)}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

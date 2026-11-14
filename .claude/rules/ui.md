---
paths:
  - "app/components/**"
  - "app/globals.css"
  - "app/layout.tsx"
---

# UI rules

- Colours only via CSS tokens in `app/globals.css` (`--surface`, `--text-2`, `--series-1..3`, `--band`, …).
  Light and dark are both defined (`prefers-color-scheme` + `data-theme`), so update both when adding a token.
- Chart: thin 2px lines, one y-axis only, legend always shown, custom tooltip on hover. Actual = solid
  `--series-1`, predicted = dashed `--series-2` + `--band` area, last month = `--series-3`. Don't add series
  beyond 3 colour slots without folding them. Policy-event markers are `ReferenceLine`s in `--text-3`, dotted
  (`1 3`), labelled at the bottom. They are not a series and don't use a 4th colour.
- Numbers use the `.num` class (tabular figures) and `fmt()`/`pct()` from `lib/format.ts`. Decimal places come
  from `DECIMALS` in `lib/config.ts`.
- Must work at **390px** wide with no horizontal page scroll. Grid/flex children holding tables get `min-w-0`,
  and wide tables sit in `overflow-x-auto`. Headless Chrome screenshots below ~500px are misleading; verify
  with Playwright device emulation (see the `run-locally` skill).
- Three tabs, one per pair (`TARGETS`). Labels come from the payload's `c.base`/`c.quote` (from `PAIRS` in
  `lib/config.ts`): never assume the base is SGD.
- Models that only exist for some pairs are filtered with `PAIR_ONLY` in `DashboardView.tsx` (`lanka`,
  `cbsl_gap`: LKR + USDLKR; `cross`: LKR). Add new pair-specific models there. Gated models show "not used".
- Sri Lanka series in Market context come from `SRI_LANKA_META` (`lib/config.ts`) via `lib/dashboard.ts`.
- Copy is plain and honest. Never imply guaranteed predictions. Keep the "not financial advice" footer.
- `PerformanceCard` (after the chart) reads `c.performance`, `c.daily`, `c.outlook`, `c.model` and `data.hardest`.
  `SourcesCard` (last, after `VersionsCard`) reads `data.freshness`, `data.notIntegrated` and `data.events.health`. Every error figure sits next
  to the random walk's on the same dates. Bias, trend and outlook show a verdict only when it passes the
  test in `lib/performance.ts`, otherwise "none detected"/"no clear change"/"no clear direction". Delta wording is
  predicted − actual ("too high" / "too low").
- `VersionsCard` (after Learning, before Data sources) reads `data.versions` (latest version's backtest per pair + comparison) and
  `data.learningLog`. Skill < 1 = better than the random walk; always show the random walk's error beside it.
- Policy events card: kinds with `widens: false` in `EVENT_KINDS` (US CPI, jobs report) say "shown only" and
  never "range widened". `lib/predict/events.ts` is pure, so the client component may import `EVENT_KINDS`.
- Health rows of `MACRO_SOURCES` (`DashboardView.tsx`: Treasury, FRED, CBSL data, Wise history) show in Market
  context; the other `source_health` rows show in the Policy events card.
- Market context formats: `FORMAT` in `lib/dashboard.ts` (`pct` default, `usd`, `lkr`, `usdmn`, `index` for the
  broad dollar index).

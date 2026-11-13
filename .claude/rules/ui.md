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
- Three tabs, one per pair (`TARGETS`): SGD → LKR, SGD → USD, LKR → USD. Labels come from the payload's
  `c.base`/`c.quote`/`c.label` and amounts from `c.per`: never assume the base is SGD or the amount is 1.
- `USDLKR` is shown inverted (`c.inverted`, LKR → USD per 1,000 LKR, 4 decimals). The dashboard payload is
  already converted, so components just print it. Exceptions: the provider card uses `c.providerPair`
  (USD → LKR), and the learned log bias flips sign. Pair checks use `c.target`, not `c.quote`.
- Models that only exist for some pairs are filtered with `PAIR_ONLY` in `DashboardView.tsx` (`lanka`,
  `cbsl_gap`: LKR + USDLKR; `cross`: LKR). Add new pair-specific models there. Gated models show "not used".
- Sri Lanka series in Market context come from `SRI_LANKA_META` (`lib/config.ts`) via `lib/dashboard.ts`.
- Copy is plain and honest. Never imply guaranteed predictions. Keep the "not financial advice" footer.

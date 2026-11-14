import { BASE, TARGETS, type Target } from "../config";
import { getJSON } from "./http";

/**
 * USD strength basket from the ECB reference rates (via Frankfurter, free, no key).
 * Value per day = mean of ln(EUR, JPY, GBP, CNY per USD) — rises when the USD strengthens.
 */
export const BASKET = ["EUR", "JPY", "GBP", "CNY"] as const;

export async function fetchUsdBasket(start: string, end: string): Promise<{ date: string; value: number }[]> {
  const url = `https://api.frankfurter.dev/v1/${start}..${end}?base=USD&symbols=${BASKET.join(",")}`;
  const data = await getJSON<{ rates: Record<string, Record<string, number>> }>(url);
  return Object.entries(data.rates ?? {})
    .map(([date, r]) => {
      const logs = BASKET.map((c) => Math.log(r[c])).filter(Number.isFinite);
      return { date, value: logs.length === BASKET.length ? logs.reduce((a, b) => a + b, 0) / logs.length : NaN };
    })
    .filter((x) => Number.isFinite(x.value))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export interface CrossCheck {
  source: string;
  rate: number;
  asOf: string | null;
}

/** Independent "today" rates from other free sources, to sanity-check Wise. */
export async function fetchCrossChecks(): Promise<Record<Target, CrossCheck[]>> {
  const out: Record<Target, CrossCheck[]> = { LKR: [], USD: [], USDLKR: [] };
  const sgdTargets = TARGETS.filter((t) => t !== "USDLKR");
  /** USD→LKR from the same source's SGD quotes: (SGD→LKR) / (SGD→USD). */
  const addUsdLkr = (source: string, lkr: number | undefined, usd: number | undefined, asOf: string | null) => {
    if (lkr && usd) out.USDLKR.push({ source, rate: lkr / usd, asOf });
  };
  const base = BASE.toLowerCase();

  const tasks: Promise<void>[] = [
    getJSON<{ rates: Record<string, number>; time_last_update_utc: string }>(
      `https://open.er-api.com/v6/latest/${BASE}`,
    ).then((d) => {
      for (const t of sgdTargets)
        if (d.rates?.[t]) out[t].push({ source: "ExchangeRate-API", rate: d.rates[t], asOf: d.time_last_update_utc });
      addUsdLkr("ExchangeRate-API", d.rates?.LKR, d.rates?.USD, d.time_last_update_utc);
    }),
    getJSON<Record<string, unknown>>(`https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/${base}.json`)
      .catch(() => getJSON<Record<string, unknown>>(`https://latest.currency-api.pages.dev/v1/currencies/${base}.json`))
      .then((d) => {
        const rates = d[base] as Record<string, number> | undefined;
        for (const t of sgdTargets) {
          const v = rates?.[t.toLowerCase()];
          if (v) out[t].push({ source: "Currency-API", rate: v, asOf: (d.date as string) ?? null });
        }
        addUsdLkr("Currency-API", rates?.lkr, rates?.usd, (d.date as string) ?? null);
      }),
  ];
  await Promise.allSettled(tasks);
  return out;
}

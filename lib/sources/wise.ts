import { PAIRS, type Target } from "../config";
import { toISO, todayISO } from "../dates";
import { getJSON } from "./http";

export interface DailyRate {
  date: string;
  rate: number;
}

interface WiseHistoryPoint {
  source: string;
  target: string;
  value: number;
  time: number;
}

/** Daily historical mid-market rates from Wise. */
export async function fetchWiseHistory(
  target: Target,
  length: number,
  unit: "day" | "month" | "year" = "month",
): Promise<DailyRate[]> {
  const { base, quote } = PAIRS[target];
  const url = `https://wise.com/rates/history?source=${base}&target=${quote}&length=${length}&unit=${unit}&resolution=daily`;
  const data = await getJSON<WiseHistoryPoint[]>(url);
  const byDate = new Map<string, number>();
  for (const p of data) {
    if (typeof p.value === "number" && p.value > 0) byDate.set(toISO(p.time), p.value);
  }
  return [...byDate.entries()]
    .map(([date, rate]) => ({ date, rate }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export interface ProviderQuote {
  name: string;
  alias: string;
  logo: string | null;
  rate: number;
  fee: number;
  received: number;
  markupPct: number;
  isMidMarket: boolean;
}

export interface LiveQuote {
  target: Target;
  date: string;
  fetchedAt: string;
  midRate: number;
  sendAmount: number;
  providers: ProviderQuote[];
}

export interface WiseComparison {
  providers: {
    name: string;
    alias: string;
    logos?: { normal?: { svgUrl?: string | null; pngUrl?: string | null } };
    quotes: {
      rate: number;
      fee: number;
      receivedAmount: number;
      markup: number;
      isConsideredMidMarketRate: boolean;
      dateCollected: string;
    }[];
  }[];
}

/** Today's rate plus a comparison against other providers (Wise comparisons API). */
export async function fetchWiseComparison(target: Target, sendAmount = 1000): Promise<LiveQuote> {
  const url =
    `https://wise.com/gateway/v4/comparisons?sendAmount=${sendAmount}&sourceCurrency=${PAIRS[target].base}` +
    `&targetCurrency=${PAIRS[target].quote}&filter=POPULAR&includeWise=true&numberOfProviders=3` +
    `&sourceCountry=SG&payInMethod=BANK_TRANSFER`;
  return parseWiseComparison(target, await getJSON<WiseComparison>(url), sendAmount);
}

/** Pure: providers sorted by amount received, and the mid rate (Wise's own quote first). */
export function parseWiseComparison(target: Target, data: WiseComparison, sendAmount = 1000): LiveQuote {
  const providers: ProviderQuote[] = [];
  // Wise's own quote is the reference. Another provider flagged "mid-market" (e.g. Remitly at 0.04% markup for
  // USD→LKR on 2026-11-14) is only a fallback if Wise is missing: provider order is not guaranteed.
  let wiseMid: { rate: number; at: string | null } | null = null;
  let otherMid: { rate: number; at: string | null } | null = null;
  for (const p of data.providers ?? []) {
    if (!p.quotes?.length) continue;
    const best = p.quotes.reduce((a, b) => (b.receivedAmount > a.receivedAmount ? b : a));
    providers.push({
      name: p.name,
      alias: p.alias,
      logo: p.logos?.normal?.svgUrl ?? p.logos?.normal?.pngUrl ?? null,
      rate: best.rate,
      fee: best.fee,
      received: best.receivedAmount,
      markupPct: best.markup ?? 0,
      isMidMarket: Boolean(best.isConsideredMidMarketRate),
    });
    if (p.alias === "wise") wiseMid ??= { rate: best.rate, at: best.dateCollected ?? null };
    else if (best.isConsideredMidMarketRate) otherMid ??= { rate: best.rate, at: best.dateCollected ?? null };
  }
  const mid = wiseMid ?? otherMid;
  const midRate = mid?.rate ?? null;
  const collected = mid?.at ?? null;
  if (midRate == null) throw new Error(`Wise comparison returned no mid-market rate for ${target}`);
  providers.sort((a, b) => b.received - a.received);

  const fetchedAt = collected ? new Date(collected) : new Date();
  return {
    target,
    date: todayISO(fetchedAt),
    fetchedAt: fetchedAt.toISOString(),
    midRate,
    sendAmount,
    providers,
  };
}

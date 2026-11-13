/**
 * Sanity checks on Wise data before it is stored. Wise is the reference, so a check never "corrects"
 * a value: a failing point is dropped (history) or not stored as today's provisional rate (live), and
 * the reason goes to source_health so it shows on the page.
 *
 * Thresholds come from the data: the largest daily move in 2 years of Wise history was 4.6% (SGD→LKR,
 * USD→LKR) and 1.0% (SGD→USD). A jump four times that is far more likely a bad response than a market move.
 */
export const MAX_DAILY_JUMP: Record<string, number> = { LKR: 0.2, USD: 0.05, USDLKR: 0.2 };
/** Live quote vs the latest official point (can be a few days old after an outage). */
export const MAX_LIVE_GAP: Record<string, number> = { LKR: 0.2, USD: 0.05, USDLKR: 0.2 };
/** Wise's SGD→LKR equals SGD→USD × USD→LKR to < 0.01%; more than this means one quote is stale or bad. */
export const MAX_CROSS_GAP = 0.005;

export interface Point {
  date: string;
  rate: number;
}

/** Keep only points that are positive, finite and within the jump limit of the previous kept point. */
export function validateHistory(
  pair: string,
  points: Point[],
  previous?: Point,
): { ok: Point[]; rejected: { date: string; rate: number; reason: string }[] } {
  const limit = MAX_DAILY_JUMP[pair] ?? 0.2;
  const ok: Point[] = [];
  const rejected: { date: string; rate: number; reason: string }[] = [];
  let prev = previous;
  for (const p of [...points].sort((a, b) => a.date.localeCompare(b.date))) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date)) {
      rejected.push({ ...p, reason: "bad date" });
      continue;
    }
    if (!Number.isFinite(p.rate) || p.rate <= 0) {
      rejected.push({ ...p, reason: "not a positive number" });
      continue;
    }
    if (prev && Math.abs(Math.log(p.rate / prev.rate)) > limit) {
      rejected.push({ ...p, reason: `jump of ${((p.rate / prev.rate - 1) * 100).toFixed(1)}% vs ${prev.date}` });
      continue;
    }
    ok.push(p);
    prev = p;
  }
  return { ok, rejected };
}

/** null = fine, otherwise the reason the live quote should not be stored as today's rate. */
export function validateLive(pair: string, rate: number, lastOfficial?: Point): string | null {
  if (!Number.isFinite(rate) || rate <= 0) return "live rate is not a positive number";
  const limit = MAX_LIVE_GAP[pair] ?? 0.2;
  if (lastOfficial && Math.abs(Math.log(rate / lastOfficial.rate)) > limit) {
    return `live rate ${rate} is ${((rate / lastOfficial.rate - 1) * 100).toFixed(1)}% from ${lastOfficial.date}`;
  }
  return null;
}

/** ln(SGD→LKR / (SGD→USD × USD→LKR)): ~0 when the three quotes are consistent. */
export function crossGap(sgdLkr: number, sgdUsd: number, usdLkr: number): number {
  return Math.log(sgdLkr / (sgdUsd * usdLkr));
}

import { addDays } from "../dates";

/** Contiguous daily log-rate series ending at `anchorDate` (gaps forward-filled). */
export interface Series {
  dates: string[];
  logs: number[];
}

export function buildSeries(rates: Map<string, number>, anchorDate: string, lookbackDays: number): Series {
  const dates: string[] = [];
  const logs: number[] = [];
  let last: number | undefined;
  // seed `last` with the most recent value before the window
  const start = addDays(anchorDate, -lookbackDays);
  for (let i = 1; i <= 10 && last === undefined; i++) {
    const v = rates.get(addDays(start, -i));
    if (v) last = Math.log(v);
  }
  for (let d = start; d <= anchorDate; d = addDays(d, 1)) {
    const v = rates.get(d);
    if (v) last = Math.log(v);
    if (last !== undefined) {
      dates.push(d);
      logs.push(last);
    }
  }
  return { dates, logs };
}

/** Forward-filled lookup of a value series at `date`. */
export function valueAt(map: Map<string, number>, date: string, maxBack = 7): number | undefined {
  for (let i = 0; i <= maxBack; i++) {
    const v = map.get(addDays(date, -i));
    if (v !== undefined) return v;
  }
  return undefined;
}

export const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

export function diffs(a: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < a.length; i++) out.push(a[i] - a[i - 1]);
  return out;
}

export function std(a: number[]): number {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}

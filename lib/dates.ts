import { APP_TZ } from "./config";

const DAY = 86_400_000;

/** YYYY-MM-DD for "now" in the app timezone. */
export function todayISO(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: APP_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** "HH:MM" (24 h) for "now" in the app timezone. */
export function timeHM(now = new Date()): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: APP_TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
}

/** True if `d` is a real calendar date in YYYY-MM-DD form (rejects 2026-11-31, 2026-13-01). */
export function isValidISO(d: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(d) && toISO(parseISO(d)) === d;
}

export function toISO(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function parseISO(d: string): number {
  return Date.parse(d + "T00:00:00Z");
}

export function addDays(d: string, n: number): string {
  return toISO(parseISO(d) + n * DAY);
}

export function diffDays(a: string, b: string): number {
  return Math.round((parseISO(a) - parseISO(b)) / DAY);
}

/** Same day-of-month `n` months earlier (clamped to month length). */
export function addMonths(d: string, n: number): string {
  const [y, m, day] = d.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(day, last));
  return first.toISOString().slice(0, 10);
}

export function monthBounds(d: string): { start: string; end: string } {
  const [y, m] = d.split("-").map(Number);
  const start = toISO(Date.UTC(y, m - 1, 1));
  const end = toISO(Date.UTC(y, m, 0));
  return { start, end };
}

export function dateRange(start: string, end: string): string[] {
  const out: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

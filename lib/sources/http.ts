import { USER_AGENT } from "../config";

/** Per-request overrides. Most callers need none. */
export interface RequestOptions {
  timeoutMs?: number;
  /** Replaces the default User-Agent (some servers throttle specific strings). Keep it generic and honest. */
  userAgent?: string;
  /** Replaces the default Accept header for this helper. */
  accept?: string;
}

/** Callers may pass just a timeout (ms), as before, or an options object. */
type Opts = number | RequestOptions | undefined;

function resolve(opts: Opts, defaultTimeout: number, defaultAccept: string) {
  const o: RequestOptions = typeof opts === "number" ? { timeoutMs: opts } : (opts ?? {});
  return {
    timeoutMs: o.timeoutMs ?? defaultTimeout,
    userAgent: o.userAgent ?? USER_AGENT,
    accept: o.accept ?? defaultAccept,
  };
}

async function get(url: string, opts: Opts, defaultTimeout: number, defaultAccept: string): Promise<Response> {
  const { timeoutMs, userAgent, accept } = resolve(opts, defaultTimeout, defaultAccept);
  const res = await fetch(url, {
    headers: { "User-Agent": userAgent, Accept: accept },
    signal: AbortSignal.timeout(timeoutMs),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res;
}

export async function getJSON<T>(url: string, opts?: number | RequestOptions): Promise<T> {
  return (await (await get(url, opts, 12_000, "application/json")).json()) as T;
}

/** HTML / XML / RSS / CSV as text. */
export async function getText(url: string, opts?: number | RequestOptions): Promise<string> {
  return (await get(url, opts, 15_000, "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")).text();
}

/** Binary body (PDFs). */
export async function getBytes(url: string, opts?: number | RequestOptions): Promise<Buffer> {
  return Buffer.from(await (await get(url, opts, 20_000, "application/pdf,*/*;q=0.8")).arrayBuffer());
}

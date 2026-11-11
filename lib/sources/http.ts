import { USER_AGENT } from "../config";

async function get(url: string, accept: string, timeoutMs: number): Promise<Response> {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: accept },
    signal: AbortSignal.timeout(timeoutMs),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res;
}

export async function getJSON<T>(url: string, timeoutMs = 12_000): Promise<T> {
  return (await (await get(url, "application/json", timeoutMs)).json()) as T;
}

/** HTML / XML / RSS as text. */
export async function getText(url: string, timeoutMs = 15_000): Promise<string> {
  return (await get(url, "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", timeoutMs)).text();
}

/** Binary body (PDFs). */
export async function getBytes(url: string, timeoutMs = 20_000): Promise<Buffer> {
  return Buffer.from(await (await get(url, "application/pdf,*/*;q=0.8", timeoutMs)).arrayBuffer());
}

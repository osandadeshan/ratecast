import { connection } from "next/server";
import { runSync } from "@/lib/sync";

export const maxDuration = 300;

/**
 * Daily job (see vercel.json). Vercel Cron sends `Authorization: Bearer $CRON_SECRET`.
 * Fetches rates, scores yesterday's predictions, re-learns and forecasts.
 */
export async function GET(request: Request) {
  await connection(); // never prerender: this route has side effects
  const secret = process.env.CRON_SECRET;
  if (secret && request.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const result = await runSync();
  return Response.json(result, { status: result.status === "error" ? 500 : 200 });
}

import { connection } from "next/server";
import { CRON_BACKTEST_BUDGET_MS } from "@/lib/config";
import { runSync } from "@/lib/sync";

export const maxDuration = 300;

/** True on any Vercel deployment (production or preview) and on any production build (`next start`). Only `next dev` is not. */
const deployed = () => Boolean(process.env.VERCEL || process.env.VERCEL_ENV) || process.env.NODE_ENV === "production";

/**
 * Daily job (see vercel.json). Vercel Cron sends `Authorization: Bearer $CRON_SECRET`.
 * Fetches rates, scores yesterday's predictions, re-learns and forecasts.
 *
 * Fails closed: on a deployment without CRON_SECRET nobody can trigger a sync (500 with a setup
 * hint), and with a secret only the exact bearer token can (401 otherwise). Only local
 * development (no VERCEL env, NODE_ENV !== "production") may run without a secret.
 */
export async function GET(request: Request) {
  await connection(); // never prerender: this route has side effects
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    if (deployed()) {
      return Response.json(
        {
          error: "CRON_SECRET is not set",
          fix: "Add a CRON_SECRET environment variable in Vercel (Settings → Environment Variables), then redeploy.",
        },
        { status: 500 },
      );
    }
  } else if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const result = await runSync({ backtestBudgetMs: CRON_BACKTEST_BUDGET_MS });
  return Response.json(result, { status: result.status === "error" ? 500 : 200 });
}

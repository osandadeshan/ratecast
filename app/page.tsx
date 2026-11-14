import { Suspense } from "react";
import { revalidateTag } from "next/cache";
import { after, connection } from "next/server";
import DashboardView from "./components/DashboardView";
import { DASHBOARD_TAG, getDashboard } from "@/lib/dashboard";
import { hasDb } from "@/lib/db";
import { needsSync, runSync } from "@/lib/sync";

export const maxDuration = 60;

export default function Page() {
  return (
    <Suspense fallback={<Loading />}>
      <Data />
    </Suspense>
  );
}

async function Data() {
  await connection();
  const data = await getDashboard();

  // Self-healing: if today's cron run is missing or failed (first deploy, cron outage), run it after
  // the response is sent. needsSync() waits for the cron's slot and has a cooldown (lib/sync.ts).
  if (hasDb()) {
    after(async () => {
      try {
        if (await needsSync()) {
          const r = await runSync({ page: true });
          // The page data is cached for 5 min; drop it so the next visit shows the new run. revalidateTag
          // is documented for Route Handlers and Server Functions; if it isn't allowed here, the 5-min
          // cache life still picks the run up.
          if (r.status !== "skipped") {
            try {
              revalidateTag(DASHBOARD_TAG, { expire: 0 });
            } catch (e) {
              console.warn("dashboard cache not revalidated", e);
            }
          }
        }
      } catch (e) {
        console.error("background sync failed", e);
      }
    });
  }
  return <DashboardView data={data} />;
}

function Loading() {
  return (
    <main className="mx-auto w-full max-w-6xl px-4 sm:px-6 py-10 space-y-6 animate-pulse">
      <div className="h-8 w-64 rounded bg-surface-2" />
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="card h-28" />
        ))}
      </div>
      <div className="card h-96" />
    </main>
  );
}

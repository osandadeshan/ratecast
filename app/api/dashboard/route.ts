import { connection } from "next/server";
import { getDashboard } from "@/lib/dashboard";

/** Read-only JSON of everything the page shows. */
export async function GET() {
  await connection();
  const data = await getDashboard();
  return Response.json(data, { headers: { "Cache-Control": "public, s-maxage=120, stale-while-revalidate=600" } });
}

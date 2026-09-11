import { listEvents, refreshPolyStatuses, type Sport } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  await refreshPolyStatuses();
  const sport = new URL(req.url).searchParams.get("sport");
  const rows = listEvents(
    sport === "soccer" || sport === "football" || sport === "mlb" || sport === "weather"
      ? (sport as Sport)
      : undefined
  );
  return Response.json({ events: rows });
}

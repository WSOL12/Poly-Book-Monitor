import { listEvents, refreshPolyStatuses, type Sport } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Don't block the match list on Gamma — refresh in the background at most once per interval. */
const REFRESH_MIN_MS = 30_000;
let lastRefreshAt = 0;
let refreshInFlight: Promise<void> | null = null;

function schedulePolyRefresh() {
  const now = Date.now();
  if (refreshInFlight) return;
  if (now - lastRefreshAt < REFRESH_MIN_MS) return;
  refreshInFlight = refreshPolyStatuses()
    .catch((err) => {
      console.error("[events] poly status refresh failed", err);
    })
    .finally(() => {
      lastRefreshAt = Date.now();
      refreshInFlight = null;
    });
}

export async function GET(req: Request) {
  schedulePolyRefresh();
  const sport = new URL(req.url).searchParams.get("sport");
  const rows = listEvents(
    sport === "soccer" ||
      sport === "football" ||
      sport === "mlb" ||
      sport === "weather" ||
      sport === "tennis"
      ? (sport as Sport)
      : undefined
  );
  return Response.json({ events: rows });
}

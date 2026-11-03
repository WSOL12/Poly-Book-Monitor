import { listEvents, refreshPolyStatuses, withTwinFlags, type Sport } from "@/lib/db";

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
  const url = new URL(req.url);
  const sport = url.searchParams.get("sport");
  const wantTwins = url.searchParams.get("twins") !== "0";
  const rows = listEvents(
    sport === "soccer" ||
      sport === "football" ||
      sport === "mlb" ||
      sport === "weather" ||
      sport === "tennis" ||
      sport === "predictfun"
      ? (sport as Sport)
      : undefined
  );
  // Predict.fun is a venue shard, not a sport — never mix into the All-matches list.
  const filtered =
    sport === "predictfun" ? rows : rows.filter((e) => e.sport !== "predictfun");
  // Twin flags are cached/indexed; still optional so clients can skip on cold path.
  const events = wantTwins ? withTwinFlags(filtered) : filtered.map((e) => ({ ...e, hasTwin: false }));
  return Response.json({ events });
}

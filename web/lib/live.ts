import type { EventRow } from "@/lib/db";

/** Finished when Polymarket reports ended/closed, or period is final. */
export function isEventFinished(event: {
  ended?: boolean;
  closed?: boolean;
  gameStatus?: string | null;
}) {
  if (event.ended || event.closed) return true;
  const p = event.gameStatus?.trim().toUpperCase() ?? "";
  return p === "VFT" || p === "FT" || p === "FINAL" || p === "F";
}

export function isEventLive(event: { ended?: boolean; closed?: boolean }) {
  return !isEventFinished(event);
}

export function splitEvents(events: EventRow[]) {
  const live: EventRow[] = [];
  const finished: EventRow[] = [];
  for (const event of events) {
    if (isEventLive(event)) live.push(event);
    else finished.push(event);
  }
  const byRecent = (a: EventRow, b: EventRow) => (b.lastSnapshotAt ?? 0) - (a.lastSnapshotAt ?? 0);
  live.sort(byRecent);
  finished.sort(byRecent);
  return { live, finished };
}

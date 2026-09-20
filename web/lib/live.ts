import type { EventRow } from "@/lib/db";

/** Finished when Polymarket reports ended/closed, or period is final. */
export function isEventFinished(event: {
  ended?: boolean;
  closed?: boolean;
  gameStatus?: string | null;
  sport?: string | null;
}) {
  if (event.ended || event.closed) return true;
  const p = event.gameStatus?.trim().toUpperCase() ?? "";
  if (p === "VFT" || p === "FT" || p === "FINAL" || p === "F") return true;
  // Tennis open-watch terminal labels written by the monitor.
  if (p === "STARTED" || p === "CANCELED" || p === "CANCELLED" || p === "RETIRED") return true;
  return false;
}

/** Still actively recording / worth polling (not terminal). */
export function isEventLive(event: {
  ended?: boolean;
  closed?: boolean;
  gameStatus?: string | null;
  sport?: string | null;
}) {
  return !isEventFinished(event);
}

export type MatchPhase = "open" | "live" | "voided" | "finished";

function isTennisVoidStatus(gameStatus?: string | null) {
  const gs = gameStatus?.trim().toLowerCase() ?? "";
  return gs === "canceled" || gs === "cancelled" || gs === "retired";
}

/**
 * Tennis: Open = prematch, Live = started, Void = canceled/retired, Done = other settled.
 * Other sports: Open unused (weather uses Open), Live = in catalog, Finished = ended.
 */
export function matchPhase(event: {
  sport?: string | null;
  ended?: boolean;
  closed?: boolean;
  polyLive?: boolean;
  gameStatus?: string | null;
}): MatchPhase {
  const gs = event.gameStatus?.trim().toLowerCase() ?? "";

  if (event.sport === "tennis") {
    if (isTennisVoidStatus(event.gameStatus)) return "voided";
    if (gs === "started" || event.polyLive) return "live";
    if (event.ended || event.closed) return "finished";
    return "open";
  }

  if (event.sport === "weather") {
    if (isEventFinished(event)) return "finished";
    return "open";
  }

  if (isEventFinished(event)) return "finished";
  return "live";
}

export function matchPhaseLabel(
  phase: MatchPhase,
  sport?: string | null,
  gameStatus?: string | null
) {
  if (phase === "open") return "Open";
  if (phase === "live") return "Live";
  if (phase === "voided") {
    const gs = gameStatus?.trim().toLowerCase() ?? "";
    if (gs === "retired") return "Retired";
    if (gs === "canceled" || gs === "cancelled") return "Canceled";
    return "Void";
  }
  return "Finished";
}

export function splitEvents(events: EventRow[]) {
  const open: EventRow[] = [];
  const live: EventRow[] = [];
  const voided: EventRow[] = [];
  const finished: EventRow[] = [];
  for (const event of events) {
    const phase = matchPhase(event);
    if (phase === "open") open.push(event);
    else if (phase === "live") live.push(event);
    else if (phase === "voided") voided.push(event);
    else finished.push(event);
  }
  const byRecent = (a: EventRow, b: EventRow) => (b.lastSnapshotAt ?? 0) - (a.lastSnapshotAt ?? 0);
  open.sort(byRecent);
  live.sort(byRecent);
  voided.sort(byRecent);
  finished.sort(byRecent);
  return { open, live, voided, finished };
}

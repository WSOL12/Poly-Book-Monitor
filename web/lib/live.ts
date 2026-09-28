import type { EventRow } from "@/lib/db";
import { tennisRetiredSetNumber } from "@/lib/score";

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

/** Tennis voids are split: retired vs canceled (not one mixed "void" bucket). */
export type MatchPhase = "open" | "live" | "retired" | "canceled" | "finished";

export function isTennisRetired(gameStatus?: string | null) {
  return gameStatus?.trim().toLowerCase() === "retired";
}

export function isTennisCanceled(gameStatus?: string | null) {
  const gs = gameStatus?.trim().toLowerCase() ?? "";
  return gs === "canceled" || gs === "cancelled";
}

/**
 * Tennis: Open = prematch, Live = started, Retired / Canceled split, Done = normal finish.
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
    if (isTennisRetired(event.gameStatus)) return "retired";
    if (isTennisCanceled(event.gameStatus)) return "canceled";
    // "started" is the stop-reason for a normal finish when we never saw live=true.
    if ((event.ended || event.closed) && gs === "started") return "finished";
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
  gameStatus?: string | null,
  score?: string | null,
  period?: string | null
) {
  if (phase === "open") return "Open";
  if (phase === "live") return "Live";
  if (phase === "retired") {
    const setN = tennisRetiredSetNumber(score, period);
    return setN != null ? `Retired S${setN}` : "Retired";
  }
  if (phase === "canceled") return "Canceled";
  return "Finished";
}

export function splitEvents(events: EventRow[]) {
  const open: EventRow[] = [];
  const live: EventRow[] = [];
  const retired: EventRow[] = [];
  const canceled: EventRow[] = [];
  const finished: EventRow[] = [];
  for (const event of events) {
    const phase = matchPhase(event);
    if (phase === "open") open.push(event);
    else if (phase === "live") live.push(event);
    else if (phase === "retired") retired.push(event);
    else if (phase === "canceled") canceled.push(event);
    else finished.push(event);
  }
  const byRecent = (a: EventRow, b: EventRow) => (b.lastSnapshotAt ?? 0) - (a.lastSnapshotAt ?? 0);
  open.sort(byRecent);
  live.sort(byRecent);
  retired.sort(byRecent);
  canceled.sort(byRecent);
  finished.sort(byRecent);
  return { open, live, retired, canceled, finished };
}

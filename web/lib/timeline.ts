import type { SnapshotRow } from "@/lib/db";

export type HistoryTimeline = {
  id: number[];
  at: number[];
  bestBid: Array<number | null>;
  bestAsk: Array<number | null>;
  /** Per-row shard (YYYY-MM), required for monthly DB lookup. */
  day?: string[];
};

export function expandTimeline(timeline: HistoryTimeline | undefined | null): SnapshotRow[] {
  if (!timeline?.id?.length) return [];
  const out: SnapshotRow[] = new Array(timeline.id.length);
  for (let i = 0; i < timeline.id.length; i++) {
    out[i] = {
      id: timeline.id[i]!,
      capturedAt: timeline.at[i]!,
      bestBid: timeline.bestBid[i] ?? null,
      bestAsk: timeline.bestAsk[i] ?? null,
      bidDepth: 0,
      askDepth: 0,
      bids: [],
      asks: [],
      day: timeline.day?.[i],
    };
  }
  return out;
}

function lowerBoundAt(snapshots: SnapshotRow[], targetAt: number) {
  let lo = 0;
  let hi = snapshots.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (snapshots[mid]!.capturedAt < targetAt) lo = mid + 1;
    else hi = mid;
  }
  return Math.min(lo, Math.max(0, snapshots.length - 1));
}

function upperBoundAt(snapshots: SnapshotRow[], targetAt: number) {
  let lo = 0;
  let hi = snapshots.length - 1;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (snapshots[mid]!.capturedAt <= targetAt) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

/**
 * Clip scrubber frames to the match window so hours of post-settle flatline
 * don't stretch the timeline to ~17h after a 2h game.
 */
export function cropScrubWindow(
  snapshots: SnapshotRow[],
  matchStart?: string | null,
  matchEnd?: number | null
): SnapshotRow[] {
  if (snapshots.length < 2) return snapshots;

  const window = matchScrubWindow(matchStart, matchEnd, snapshots);
  if (!window) return snapshots;

  const lo = lowerBoundAt(snapshots, window.t0);
  const hi = upperBoundAt(snapshots, window.t1);
  if (hi <= lo) return snapshots;
  const cropped = snapshots.slice(lo, hi + 1);
  return cropped.length >= 2 ? cropped : snapshots;
}

/**
 * Shared scrub bounds for every market on a match.
 * Kickoff→finish (with pads) — not per-token recording edges.
 * Prematch (tennis open): samples sit before kickoff — use the recorded span.
 */
export function matchScrubWindow(
  matchStart?: string | null,
  matchEnd?: number | null,
  sample?: SnapshotRow[]
): { t0: number; t1: number } | null {
  const kickoff = matchStart ? Date.parse(matchStart) : NaN;
  const finish = matchEnd != null && Number.isFinite(matchEnd) ? Number(matchEnd) : NaN;
  const sampleLo = sample?.[0]?.capturedAt;
  const sampleHi = sample && sample.length ? sample[sample.length - 1]!.capturedAt : undefined;

  // Open/prematch books land entirely before scheduled start — don't invent a kickoff window.
  if (
    Number.isFinite(kickoff) &&
    sampleLo != null &&
    sampleHi != null &&
    sampleHi > sampleLo &&
    sampleHi < kickoff
  ) {
    return { t0: sampleLo, t1: sampleHi };
  }

  if (Number.isFinite(kickoff) && Number.isFinite(finish) && finish > kickoff) {
    // Settlement-only capture: first snap at/after FT — don't invent a 2h kickoff→FT bar.
    if (
      sampleLo != null &&
      sampleHi != null &&
      sampleHi > sampleLo &&
      sampleLo >= finish - 3 * 60_000
    ) {
      return { t0: sampleLo, t1: sampleHi };
    }
    // Late join: scrub the real recorded span (still in-play), not a fake pre-kickoff pad.
    if (sampleLo != null && sampleHi != null && sampleLo > kickoff + 5 * 60_000) {
      return { t0: sampleLo, t1: Math.max(sampleHi, finish) };
    }
    const t1 = sampleHi != null ? Math.max(sampleHi, finish) : finish + 5 * 60_000;
    const t0 =
      sampleLo != null && sampleLo < kickoff - 5 * 60_000
        ? sampleLo
        : kickoff - 5 * 60_000;
    return { t0, t1: Math.max(t1, kickoff + 60_000) };
  }

  if (Number.isFinite(kickoff) && sampleHi != null && sampleHi > kickoff) {
    const t0 =
      sampleLo != null && sampleLo < kickoff - 5 * 60_000
        ? sampleLo
        : kickoff - 5 * 60_000;
    return { t0, t1: sampleHi };
  }

  if (sampleLo != null && sampleHi != null && sampleHi > sampleLo) {
    // No match clock — fall back to this token's span (live / weather).
    let hiAt = sampleHi;
    let lastMove = 0;
    for (let i = 1; i < (sample?.length ?? 0); i++) {
      const a = sample![i - 1]!;
      const b = sample![i]!;
      const dBid = Math.abs((b.bestBid ?? NaN) - (a.bestBid ?? NaN));
      const dAsk = Math.abs((b.bestAsk ?? NaN) - (a.bestAsk ?? NaN));
      if (
        (Number.isFinite(dBid) && dBid >= 0.05) ||
        (Number.isFinite(dAsk) && dAsk >= 0.05)
      ) {
        lastMove = i;
      }
    }
    const moveAt = sample![lastMove]!.capturedAt;
    if (sampleHi - moveAt > 30 * 60_000) {
      hiAt = Math.min(sampleHi, moveAt + 10 * 60_000);
    }
    return { t0: sampleLo, t1: hiAt };
  }

  return null;
}

function sportMatchBounds(sport?: string | null) {
  // typical = expected length; max = hard scrub cap (late VFT polls must not stretch to 5h)
  if (sport === "football" || sport === "mlb") {
    return { typicalMs: 3.5 * 60 * 60_000, maxMs: 5 * 60 * 60_000 };
  }
  if (sport === "tennis") {
    // Best-of-3 / best-of-5 — never use soccer's 105m cap for open books.
    return { typicalMs: 2.5 * 60 * 60_000, maxMs: 6 * 60 * 60_000 };
  }
  // Soccer: 90 + HT + stoppage; allow ET/extra without opening a multi-hour SUS gap
  return { typicalMs: 105 * 60_000, maxMs: 150 * 60_000 };
}

/**
 * True match end for the scrubber.
 * - While still live (no finishedAt): ALWAYS follow lastSnapshotAt — never invent
 *   kickoff+typical (that froze Man City at 07:45 during 1H while books kept moving).
 * - After finish: pad with score/typical only when finishedAt is missing or early.
 */
export function resolveMatchEnd(opts: {
  sport?: string | null;
  matchStart?: string | null;
  finishedAt?: number | null;
  lastScoreAt?: number | null;
  lastSnapshotAt?: number | null;
}): number | null {
  const kickoff = opts.matchStart ? Date.parse(opts.matchStart) : NaN;
  const finish =
    opts.finishedAt != null && Number.isFinite(opts.finishedAt) ? Number(opts.finishedAt) : NaN;
  const lastScore =
    opts.lastScoreAt != null && Number.isFinite(opts.lastScoreAt) ? Number(opts.lastScoreAt) : NaN;
  const lastSnap =
    opts.lastSnapshotAt != null && Number.isFinite(opts.lastSnapshotAt)
      ? Number(opts.lastSnapshotAt)
      : NaN;

  // Still recording — scrub tip = latest book (tennis open + in-play soccer/MLB/NFL).
  if (!Number.isFinite(finish)) {
    if (Number.isFinite(lastSnap) && Number.isFinite(lastScore)) {
      return Math.max(lastSnap, lastScore);
    }
    if (Number.isFinite(lastSnap)) return lastSnap;
    if (Number.isFinite(lastScore)) return lastScore;
    return null;
  }

  // Canceled/retired tennis before start — prematch data only.
  if (
    opts.sport === "tennis" &&
    Number.isFinite(lastSnap) &&
    Number.isFinite(kickoff) &&
    lastSnap < kickoff
  ) {
    return lastSnap;
  }

  let end = finish;

  if (Number.isFinite(kickoff) && opts.sport !== "weather") {
    const { typicalMs, maxMs } = sportMatchBounds(opts.sport);
    const scoreUsable =
      Number.isFinite(lastScore) &&
      lastScore >= kickoff - 5 * 60_000 &&
      lastScore - kickoff <= maxMs;

    if (scoreUsable) {
      end = Math.max(end, lastScore);
    }

    // finishedAt stamped mid-game — extend toward a plausible FT, but never past last book.
    if (end - kickoff < typicalMs * 0.55) {
      end = Math.max(end, kickoff + typicalMs);
      if (scoreUsable) end = Math.max(end, lastScore);
    }

    end = Math.min(end, kickoff + maxMs);
    if (Number.isFinite(lastSnap)) end = Math.max(end, lastSnap);
  } else if (Number.isFinite(lastScore)) {
    end = Math.max(end, lastScore);
  }

  return Number.isFinite(end) && end > 0 ? end : null;
}

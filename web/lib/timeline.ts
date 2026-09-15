import type { SnapshotRow } from "@/lib/db";

export type HistoryTimeline = {
  id: number[];
  at: number[];
  bestBid: Array<number | null>;
  bestAsk: Array<number | null>;
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

  if (Number.isFinite(kickoff) && Number.isFinite(finish) && finish > kickoff) {
    let t1 = finish + 5 * 60_000;
    // Don't extend past recorded book data when available.
    if (sampleHi != null) t1 = Math.min(t1, sampleHi);
    return { t0: kickoff - 5 * 60_000, t1: Math.max(t1, kickoff + 60_000) };
  }

  if (Number.isFinite(kickoff) && sampleHi != null && sampleHi > kickoff) {
    return { t0: kickoff - 5 * 60_000, t1: sampleHi };
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
  // Soccer: 90 + HT + stoppage; allow ET/extra without opening a multi-hour SUS gap
  return { typicalMs: 105 * 60_000, maxMs: 150 * 60_000 };
}

/**
 * True match end for the scrubber.
 * - `finished_at` is sometimes stamped early (mid-game SUS)
 * - `lastScoreAt` can be hours late (next poll after VFT), so only trust it
 *   inside a plausible post-kickoff window — never stretch the bar to ~5h
 */
export function resolveMatchEnd(opts: {
  sport?: string | null;
  matchStart?: string | null;
  finishedAt?: number | null;
  lastScoreAt?: number | null;
}): number | null {
  const kickoff = opts.matchStart ? Date.parse(opts.matchStart) : NaN;
  const finish =
    opts.finishedAt != null && Number.isFinite(opts.finishedAt) ? Number(opts.finishedAt) : NaN;
  const lastScore =
    opts.lastScoreAt != null && Number.isFinite(opts.lastScoreAt) ? Number(opts.lastScoreAt) : NaN;

  let end = Number.isFinite(finish) ? finish : NaN;

  if (Number.isFinite(kickoff) && opts.sport !== "weather") {
    const { typicalMs, maxMs } = sportMatchBounds(opts.sport);
    const scoreUsable =
      Number.isFinite(lastScore) &&
      lastScore >= kickoff - 5 * 60_000 &&
      lastScore - kickoff <= maxMs;

    if (scoreUsable) {
      end = Number.isFinite(end) ? Math.max(end, lastScore) : lastScore;
    }

    if (!Number.isFinite(end) || end - kickoff < typicalMs * 0.55) {
      end = Math.max(Number.isFinite(end) ? end : 0, kickoff + typicalMs);
      if (scoreUsable) end = Math.max(end, lastScore);
    }

    end = Math.min(end, kickoff + maxMs);
  } else if (Number.isFinite(lastScore)) {
    end = Number.isFinite(end) ? Math.max(end, lastScore) : lastScore;
  }

  return Number.isFinite(end) && end > 0 ? end : null;
}

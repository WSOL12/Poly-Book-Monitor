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

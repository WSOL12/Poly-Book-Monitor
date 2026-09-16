export type QuoteSnapshot = {
  capturedAt: number;
  bestAsk: number | null;
  bestBid: number | null;
};

export type FrameQuote = {
  tokenId: string;
  bestAsk: number | null;
  bestBid: number | null;
};

export function quotesEqual(a: FrameQuote[], b: FrameQuote[]) {
  if (a.length !== b.length) return false;
  return a.every(
    (q, i) =>
      q.tokenId === b[i].tokenId && q.bestAsk === b[i].bestAsk && q.bestBid === b[i].bestBid
  );
}

export function quoteAtTime(snapshots: QuoteSnapshot[], atMs: number) {
  if (!snapshots.length) return { bestAsk: null as number | null, bestBid: null as number | null };
  let lo = 0;
  let hi = snapshots.length - 1;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (snapshots[mid]!.capturedAt <= atMs) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  const hit = snapshots[best]!;
  return { bestAsk: hit.bestAsk, bestBid: hit.bestBid };
}

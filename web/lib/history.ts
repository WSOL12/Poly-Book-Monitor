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
  let row: QuoteSnapshot | null = null;
  for (const snap of snapshots) {
    if (snap.capturedAt <= atMs) row = snap;
    else break;
  }
  const hit = row ?? snapshots[0];
  return { bestAsk: hit.bestAsk, bestBid: hit.bestBid };
}

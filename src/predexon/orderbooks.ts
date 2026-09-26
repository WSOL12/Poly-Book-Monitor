/**
 * Predexon Polymarket orderbook history (free & unlimited).
 * Docs: https://docs.predexon.com/api-reference/markets/orderbooks
 * Timestamps are milliseconds. History from 2026-01-01.
 */
import type { BookLevel } from "../types/monitoring.ts";
import { asNumber, asRecord, predexonGet, type PredexonClientOptions } from "./client.ts";

export type OrderbookSnap = {
  ts: number;
  bids: BookLevel[];
  asks: BookLevel[];
};

function parseLevels(value: unknown): BookLevel[] {
  if (!Array.isArray(value)) return [];
  const out: BookLevel[] = [];
  for (const item of value) {
    const row = asRecord(item);
    const price = asNumber(row?.price);
    const size = asNumber(row?.size);
    if (price == null || size == null || size <= 0) continue;
    out.push({ price, size });
  }
  return out;
}

/** Paginated download of L2 snapshots for one token over [startMs, endMs]. */
export async function fetchPolyOrderbooks(
  client: PredexonClientOptions,
  tokenId: string,
  startMs: number,
  endMs: number,
): Promise<OrderbookSnap[]> {
  if (endMs <= startMs) return [];
  const rows: OrderbookSnap[] = [];
  let paginationKey: string | null = null;
  for (;;) {
    const q = new URLSearchParams({
      token_id: tokenId,
      start_time: String(startMs),
      end_time: String(endMs),
      limit: "200",
    });
    if (paginationKey) q.set("pagination_key", paginationKey);
    const body = asRecord(
      await predexonGet(client, `/v2/polymarket/orderbooks?${q}`, "orderbooks"),
    );
    const snapshots = Array.isArray(body?.snapshots) ? body.snapshots : [];
    for (const item of snapshots) {
      const snap = asRecord(item);
      if (!snap) continue;
      const ts = asNumber(snap.timestamp);
      if (ts == null) continue;
      rows.push({
        ts,
        bids: parseLevels(snap.bids),
        asks: parseLevels(snap.asks),
      });
    }
    const pagination = asRecord(body?.pagination);
    if (pagination?.has_more !== true) break;
    paginationKey = typeof pagination.pagination_key === "string" ? pagination.pagination_key : null;
    if (!paginationKey) break;
  }
  rows.sort((a, b) => a.ts - b.ts);
  return rows;
}

/**
 * Probe Predexon Predict.Fun markets shape (no secrets printed).
 *   npx tsx scripts/probe-predictfun.ts
 */
import "../src/config/env.ts";
import { parseApiKeysFromEnv, predexonGet, asRecord, asNumber } from "../src/predexon/client.ts";

async function main() {
  const client = { apiKeys: parseApiKeysFromEnv(), requestDelayMs: 50 };
  const qSports = new URLSearchParams({
    limit: "10",
    search: "Bublik",
    status: "closed",
  });
  const body = asRecord(
    await predexonGet(client, `/v2/predictfun/markets?${qSports}`, "pf-probe"),
  );
  const markets = Array.isArray(body?.markets) ? body.markets : Array.isArray(body?.data) ? body.data : [];
  console.log("keys", Object.keys(body ?? {}));
  console.log("count", markets.length);
  const first = asRecord(markets[0]);
  if (first) {
    console.log("sample keys", Object.keys(first));
    console.log(
      JSON.stringify(
        {
          id: first.id ?? first.market_id,
          title: first.title ?? first.question ?? first.name,
          event: first.event_title ?? first.event_name ?? first.event,
          status: first.status,
          category: first.category ?? first.sport ?? first.tags,
          start: first.start_time ?? first.startTime ?? first.starts_at,
          end: first.end_time ?? first.endTime ?? first.ends_at,
          volume: first.volume ?? first.volume_usd,
        },
        null,
        2,
      ),
    );
    console.log("raw sample truncated", JSON.stringify(first).slice(0, 1500));
  }
  const mid = asNumber(first?.id ?? first?.market_id);
  if (mid != null) {
    const end = Date.now();
    const start = end - 3 * 24 * 60 * 60_000;
    const q = new URLSearchParams({
      market_id: String(mid),
      start_time: String(start),
      end_time: String(end),
      limit: "5",
    });
    const books = asRecord(await predexonGet(client, `/v2/predictfun/orderbooks?${q}`, "pf-books"));
    const snaps = Array.isArray(books?.snapshots) ? books.snapshots : [];
    console.log("orderbook snaps", snaps.length, "first", snaps[0] ? JSON.stringify(snaps[0]).slice(0, 400) : null);
  }
}

main().catch((e) => {
  console.error(String(e));
  process.exit(1);
});

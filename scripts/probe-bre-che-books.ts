import "../src/config/env.ts";
import { parseApiKeysFromEnv } from "../src/predexon/client.ts";
import { listPredictMarkets, fetchPredictOrderbooks } from "../src/predexon/predictfun.ts";

const client = { apiKeys: parseApiKeysFromEnv(), requestDelayMs: 40 };
const slug = "epl-bre-che-2026-09-18";

for (const status of ["closed", "open"] as const) {
  const markets = await listPredictMarkets(client, { eventSlug: slug, status, maxPages: 5 });
  console.log(status, "markets", markets.length);
  for (const m of markets) {
    console.log(`  id=${m.marketId} [${m.marketVariant}] ${m.title} created=${m.createdTime}`);
    const day = Date.parse("2026-09-18T12:00:00Z");
    const snaps = await fetchPredictOrderbooks(client, m.marketId, day - 7 * 86400000, day + 2 * 86400000);
    console.log(`    snaps=${snaps.length}`, snaps[0] ? { ts: snaps[0].ts, bb: snaps[0].bestBid, ba: snaps[0].bestAsk } : "");
    if (snaps.length) break; // enough proof
  }
}

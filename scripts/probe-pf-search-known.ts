import "../src/config/env.ts";
import { parseApiKeysFromEnv } from "../src/predexon/client.ts";
import { listPredictMarkets, groupPredictEvents } from "../src/predexon/predictfun.ts";
import { titleSimilarity } from "../web/lib/matchTitles.ts";

const client = { apiKeys: parseApiKeysFromEnv(), requestDelayMs: 40 };

const queries = [
  "Mayot",
  "Khachanov",
  "Blockx",
  "Cerundolo",
  "Cilic",
  "Kostyuk",
  "US Open",
  "China Open",
  "Harold",
  "Cassone",
  "Rennes",
];

for (const q of queries) {
  const markets = [];
  for (const status of ["closed", "open"] as const) {
    markets.push(
      ...(await listPredictMarkets(client, {
        status,
        search: q,
        marketVariant: "SPORTS_MATCH",
        limit: 30,
        maxPages: 3,
      })),
    );
  }
  const groups = groupPredictEvents(markets);
  console.log(`\n=== search "${q}" markets=${markets.length} events=${groups.length} ===`);
  for (const g of groups.slice(0, 12)) {
    console.log(`  [${g.status}] ${g.title.slice(0, 70)} | ${g.eventSlug}`);
  }
}

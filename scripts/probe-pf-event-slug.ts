import "../src/config/env.ts";
import { parseApiKeysFromEnv } from "../src/predexon/client.ts";
import { listPredictMarkets, groupPredictEvents, pickPredictEventTitle } from "../src/predexon/predictfun.ts";

const client = { apiKeys: parseApiKeysFromEnv(), requestDelayMs: 40 };
const slug = "epl-bou-liv-2026-09-20";

const markets = await listPredictMarkets(client, {
  eventSlug: slug,
  status: "closed",
  maxPages: 5,
});
console.log("markets", markets.length);
for (const m of markets.slice(0, 10)) {
  console.log(`  [${m.marketVariant}] ${m.title} | outcomes=${m.outcomes.map((o) => o.label).join(",")}`);
}
const g = groupPredictEvents(markets);
console.log("grouped", g.map((x) => x.title));
console.log("pick", pickPredictEventTitle(markets, slug));

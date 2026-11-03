import "../src/config/env.ts";
import { parseApiKeysFromEnv } from "../src/predexon/client.ts";
import { listPredictMarkets } from "../src/predexon/predictfun.ts";

const client = { apiKeys: parseApiKeysFromEnv(), requestDelayMs: 40 };
const base = "epl-bri-ars-2026-09-19";

const more = await listPredictMarkets(client, {
  eventSlug: `${base}-more-markets`,
  status: "closed",
  maxPages: 20,
});
console.log("more-markets count", more.length);
const variants = new Map<string, number>();
for (const m of more) {
  variants.set(m.marketVariant, (variants.get(m.marketVariant) ?? 0) + 1);
  console.log(`  [${m.marketVariant}] ${m.title}`);
}
console.log("variants", [...variants.entries()]);

// Try other suffixes
for (const suf of [
  "-halves",
  "-half",
  "-btts",
  "-both-teams",
  "-first-goal",
  "-first-team",
  "-spreads",
  "-totals",
  "-game-lines",
]) {
  const page = await listPredictMarkets(client, {
    eventSlug: `${base}${suf}`,
    status: "closed",
    maxPages: 2,
  });
  if (page.length) console.log(`FOUND ${suf}: ${page.length}`, page[0]?.title);
}

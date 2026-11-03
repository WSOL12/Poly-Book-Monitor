import "../src/config/env.ts";
import { parseApiKeysFromEnv } from "../src/predexon/client.ts";
import { listPredictMarkets, groupPredictEvents } from "../src/predexon/predictfun.ts";

const client = { apiKeys: parseApiKeysFromEnv(), requestDelayMs: 40 };

async function probe(label: string, opts: Parameters<typeof listPredictMarkets>[1]) {
  const markets = await listPredictMarkets(client, { maxPages: 5, limit: 100, ...opts });
  const groups = groupPredictEvents(markets);
  console.log(`\n=== ${label} === markets=${markets.length} groups=${groups.length}`);
  for (const g of groups.slice(0, 12)) {
    console.log(`  [${g.status}] ${g.eventSlug?.slice(0, 50) ?? "-"} | ${g.title.slice(0, 70)}`);
  }
  return groups;
}

// Broad feed (no search) — sample what SPORTS_TEAM_MATCH looks like recently
await probe("SPORTS_TEAM_MATCH closed (no search)", {
  status: "closed",
  marketVariant: "SPORTS_TEAM_MATCH",
  sort: "created",
  maxPages: 3,
});

await probe("search Liverpool closed TEAM_MATCH", {
  status: "closed",
  search: "Liverpool",
  marketVariant: "SPORTS_TEAM_MATCH",
});

await probe("search epl- closed (slug)", {
  status: "closed",
  search: "epl-",
});

await probe("search ucl- closed", {
  status: "closed",
  search: "ucl-",
});

await probe("search fl1- closed", {
  status: "closed",
  search: "fl1-",
});

await probe("search bundesliga closed", {
  status: "closed",
  search: "Bundesliga",
});

await probe("search Champions League closed", {
  status: "closed",
  search: "Champions League",
});

await probe("search Real Madrid (no variant)", {
  status: "closed",
  search: "Real Madrid",
});

await probe("SPORTS_MATCH closed Spain", {
  status: "closed",
  marketVariant: "SPORTS_MATCH",
  search: "Spain",
});

await probe("open SPORTS_TEAM_MATCH search Celta", {
  status: "open",
  marketVariant: "SPORTS_TEAM_MATCH",
  search: "Celta",
});

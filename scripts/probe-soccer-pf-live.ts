import "../src/config/env.ts";
import { parseApiKeysFromEnv } from "../src/predexon/client.ts";
import { listPredictMarkets, groupPredictEvents } from "../src/predexon/predictfun.ts";
import { listEvents } from "../web/lib/db.ts";
import { titleSimilarity } from "../web/lib/matchTitles.ts";

const client = { apiKeys: parseApiKeysFromEnv(), requestDelayMs: 40 };
const soccer = listEvents("soccer").slice(0, 30);

const searches = [
  "Premier League",
  "EPL",
  "Champions League",
  "La Liga",
  "Serie A",
  "Bundesliga",
  "MLS",
  "Liverpool",
  "Arsenal",
  "Real Madrid",
  "Barcelona",
];

const allMarkets = [];
for (const search of searches) {
  for (const status of ["closed", "open"] as const) {
    const page = await listPredictMarkets(client, {
      status,
      search,
      marketVariant: "SPORTS_TEAM_MATCH",
      maxPages: 3,
      limit: 30,
    });
    allMarkets.push(...page);
  }
}

const groups = groupPredictEvents(allMarkets);
const unique = new Map<string, (typeof groups)[number]>();
for (const g of groups) unique.set(g.eventId, g);

console.log("PF soccer search groups", unique.size);
for (const g of [...unique.values()].slice(0, 25)) {
  console.log(`  [${g.status}] ${g.title}`);
}

console.log("\nPoly soccer sample titles:");
for (const s of soccer.slice(0, 10)) console.log(" ", s.title);

console.log("\nBest live PF match per poly soccer sample:");
for (const s of soccer.slice(0, 15)) {
  let best: { score: number; title: string } | null = null;
  for (const g of unique.values()) {
    const score = titleSimilarity(s.title, g.title);
    if (!best || score > best.score) best = { score, title: g.title };
  }
  console.log(
    best && best.score >= 0.4
      ? `  ${best.score.toFixed(2)} ${s.title.slice(0, 50)} <=> ${best.title.slice(0, 50)}`
      : `  MISS ${s.title.slice(0, 60)}`,
  );
}

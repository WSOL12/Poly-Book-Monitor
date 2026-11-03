/**
 * Catalog-only: pull major tennis PF events into local DB (titles for twinning).
 * Books can be filled later via download:predictfun / backfill.
 *
 *   npx tsx scripts/backfill-pf-tennis-catalog.ts
 */
import "../src/config/env.ts";
import { ensureDataDirs } from "../src/config/env.ts";
import { MonitorHub } from "../src/db/store.ts";
import { parseApiKeysFromEnv } from "../src/predexon/client.ts";
import {
  groupPredictEvents,
  listPredictMarkets,
} from "../src/predexon/predictfun.ts";
import type { MarketType, MonitoredEvent, MonitoredMarket, MonitoredToken } from "../src/types/monitoring.ts";

const SPORT = "predictfun" as const;
const SEARCHES = [
  "US Open ATP",
  "US Open WTA",
  "US Open",
  "China Open",
  "Laver Cup",
  "Guadalajara",
  "Singapore Open",
  "Davis Cup",
  "Wimbledon",
  "Cincinnati",
];

function guessMarketType(title: string): MarketType {
  if (/set handicap|sets? handicap/i.test(title)) return "set_handicap";
  if (/game (spread|handicap)|spread/i.test(title)) return "game_handicap";
  if (/set \d|set winner/i.test(title)) return "set_winner";
  if (/o\/u|over\/under|total/i.test(title)) return "total";
  return "moneyline";
}

function toMonitoredEvent(group: ReturnType<typeof groupPredictEvents>[number]): MonitoredEvent {
  const markets: MonitoredMarket[] = [];
  for (const m of group.markets) {
    const marketType = guessMarketType(m.title);
    const marketId = `pf:${m.marketId}`;
    const tokens: MonitoredToken[] = m.outcomes.map((o, i) => ({
      tokenId: o.tokenId || `${marketId}:${i === 0 ? "home" : i === 1 ? "away" : `out${i}`}`,
      marketId,
      eventId: group.eventId,
      sport: SPORT,
      marketType,
      side: i === 0 ? "home" : i === 1 ? "away" : `out${i}`,
      label: o.label,
      line: null,
    }));
    if (!tokens.length) {
      tokens.push({
        tokenId: `${marketId}:yes`,
        marketId,
        eventId: group.eventId,
        sport: SPORT,
        marketType,
        side: "yes",
        label: "Yes",
        line: null,
      });
    }
    markets.push({
      marketId,
      eventId: group.eventId,
      sport: SPORT,
      marketType,
      question: m.title,
      line: null,
      tokens,
    });
  }
  const createdMs = group.createdTime ? Date.parse(group.createdTime) : NaN;
  return {
    eventId: group.eventId,
    sport: SPORT,
    title: group.title,
    slug: group.eventSlug ?? group.eventId,
    startTime: group.createdTime,
    eventDate: Number.isFinite(createdMs) ? new Date(createdMs).toISOString().slice(0, 10) : null,
    ended: group.status === "closed",
    polyLive: false,
    closed: group.status === "closed",
    gameStatus: group.status === "closed" ? "closed" : "open",
    finishedAt: group.status === "closed" && Number.isFinite(createdMs) ? createdMs : null,
    markets,
  };
}

async function main() {
  ensureDataDirs();
  const fromMs = Date.now() - 60 * 86_400_000;
  const toMs = Date.now();
  const client = { apiKeys: parseApiKeysFromEnv(), requestDelayMs: 30 };
  const all: Awaited<ReturnType<typeof listPredictMarkets>> = [];
  for (const search of SEARCHES) {
    for (const status of ["closed", "open"] as const) {
      process.stdout.write(`search "${search}" ${status}… `);
      const page = await listPredictMarkets(client, {
        status,
        search,
        sort: "created",
        maxPages: 25,
        createdAfterMs: fromMs - 21 * 86_400_000,
        createdBeforeMs: toMs,
      });
      console.log(page.length);
      all.push(...page);
    }
  }
  const dedup = new Map<number, (typeof all)[number]>();
  for (const m of all) dedup.set(m.marketId, m);
  const groups = groupPredictEvents([...dedup.values()]).filter((g) => /\bvs\.?\b/i.test(g.title));
  console.log(`cataloging ${groups.length} events…`);
  const hub = new MonitorHub();
  hub.syncCatalog(groups.map(toMonitoredEvent));
  hub.close();
  console.log("done");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

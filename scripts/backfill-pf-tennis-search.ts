/**
 * Pull all closed/open "US Open" / major tennis PF events in window and save.
 * Then voids that exist on PF will twin.
 *
 *   npx tsx scripts/backfill-pf-tennis-search.ts
 */
import "../src/config/env.ts";
import { ensureDataDirs } from "../src/config/env.ts";
import {
  bestOf,
  depthSum,
  MonitorHub,
  normalizeBookSide,
} from "../src/db/store.ts";
import { parseApiKeysFromEnv } from "../src/predexon/client.ts";
import {
  fetchPredictOrderbooks,
  groupPredictEvents,
  listPredictMarkets,
} from "../src/predexon/predictfun.ts";
import type { BookSnapshot, MarketType, MonitoredEvent, MonitoredMarket, MonitoredToken } from "../src/types/monitoring.ts";

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
  const days = 45;
  const fromMs = Date.now() - days * 86_400_000;
  const toMs = Date.now();
  const client = { apiKeys: parseApiKeysFromEnv(), requestDelayMs: 35 };

  const byId = new Map<number, (typeof import("../src/predexon/predictfun.ts"))["PredictMarket"]>();
  // simpler: use any
  const all: Awaited<ReturnType<typeof listPredictMarkets>> = [];
  for (const search of SEARCHES) {
    for (const status of ["closed", "open"] as const) {
      console.log(`search "${search}" ${status}…`);
      const page = await listPredictMarkets(client, {
        status,
        search,
        sort: "created",
        maxPages: 20,
        createdAfterMs: fromMs - 14 * 86_400_000,
        createdBeforeMs: toMs,
      });
      console.log(`  ${page.length}`);
      all.push(...page);
    }
  }
  const dedup = new Map<number, (typeof all)[number]>();
  for (const m of all) dedup.set(m.marketId, m);
  const groups = groupPredictEvents([...dedup.values()]).filter((g) =>
    /\bvs\.?\b/i.test(g.title),
  );
  console.log(`events with vs: ${groups.length}`);

  const hub = new MonitorHub();
  let downloaded = 0;
  let skipped = 0;
  for (const group of groups) {
    const event = toMonitoredEvent(group);
    hub.syncCatalog([event]);
    if (hub.isDownloadComplete(event.eventId)) {
      skipped++;
      continue;
    }
    hub.markDownloadIncomplete(event.eventId, {
      tokens: event.markets.reduce((n, m) => n + m.tokens.length, 0),
      fromMs,
      toMs,
    });
    let snaps = 0;
    let lastTs: number | null = null;
    for (const market of group.markets) {
      const tokenId = market.outcomes[0]?.tokenId || `pf:${market.marketId}:yes`;
      try {
        const rows = await fetchPredictOrderbooks(client, market.marketId, fromMs, toMs);
        for (const snap of rows) {
          const bids = normalizeBookSide(snap.bids, "bid");
          const asks = normalizeBookSide(snap.asks, "ask");
          const row: BookSnapshot = {
            tokenId,
            eventId: event.eventId,
            sport: SPORT,
            capturedAt: snap.ts,
            bestBid: snap.bestBid ?? bestOf(bids, "bid"),
            bestAsk: snap.bestAsk ?? bestOf(asks, "ask"),
            bidDepth: depthSum(bids),
            askDepth: depthSum(asks),
            bids,
            asks,
            source: "rest",
          };
          hub.recordSnapshot(row);
          snaps++;
          if (lastTs == null || snap.ts > lastTs) lastTs = snap.ts;
        }
      } catch (e) {
        console.warn(`book fail ${market.marketId}`, e instanceof Error ? e.message : e);
      }
    }
    if (event.ended || event.closed) {
      hub.markDownloadComplete(event.eventId, {
        tokens: event.markets.reduce((n, m) => n + m.tokens.length, 0),
        snapshots: snaps,
        lastTs,
        fromMs,
        toMs,
      });
    }
    downloaded++;
    if (downloaded % 10 === 0) console.log(`  … saved ${downloaded} skipped=${skipped}`);
  }
  hub.close();
  console.log(`done downloaded=${downloaded} skipped=${skipped} total_groups=${groups.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

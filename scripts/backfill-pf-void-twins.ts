/**
 * Backfill Predict.fun events that twin with Poly tennis voids (retired/canceled)
 * and other unmatched tennis — Predexon has them but the shallow catalog miss them.
 *
 *   npx tsx scripts/backfill-pf-void-twins.ts
 *   npx tsx scripts/backfill-pf-void-twins.ts --days 40 --limit 80
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
  type PredictMarket,
} from "../src/predexon/predictfun.ts";
import type { BookSnapshot, MarketType, MonitoredEvent, MonitoredMarket, MonitoredToken } from "../src/types/monitoring.ts";
import { listEvents, findPredictTwins } from "../web/lib/db.ts";
import { titleSimilarity } from "../web/lib/matchTitles.ts";

const SPORT = "predictfun" as const;

function phase(gs: string | null | undefined) {
  const g = gs?.trim().toLowerCase() ?? "";
  if (g === "retired") return "retired";
  if (g === "canceled" || g === "cancelled") return "canceled";
  return "other";
}

function surnameQueries(title: string): string[] {
  const body = title.replace(/^[^:]+:\s*/, "");
  const sides = body.split(/\s+vs\.?\s+/i);
  const out: string[] = [];
  for (const side of sides.slice(0, 2)) {
    const parts = side
      .replace(/\(.*?\)/g, " ")
      .replace(/[^a-zA-Z\s\-']/g, " ")
      .trim()
      .split(/\s+/)
      .filter((p) => p.length >= 4 && !/^(vs|and)$/i.test(p));
    if (parts.length) out.push(parts[parts.length - 1]!);
  }
  return [...new Set(out)];
}

function guessMarketType(title: string): MarketType {
  if (/set handicap|sets? handicap/i.test(title)) return "set_handicap";
  if (/game (spread|handicap)|spread/i.test(title)) return "game_handicap";
  if (/set \d|set winner/i.test(title)) return "set_winner";
  if (/o\/u|over\/under|total/i.test(title)) return "total";
  if (/completed match|match completed/i.test(title)) return "completed_match";
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
  const argv = process.argv.slice(2);
  const days = Number(argv.includes("--days") ? argv[argv.indexOf("--days") + 1] : 40);
  const limit = Number(argv.includes("--limit") ? argv[argv.indexOf("--limit") + 1] : 120);
  const fromMs = Date.now() - days * 86_400_000;
  const toMs = Date.now();
  const client = { apiKeys: parseApiKeysFromEnv(), requestDelayMs: 40 };

  const tennis = listEvents("tennis").filter((e) => {
    const d = e.eventDate ? Date.parse(e.eventDate) : e.finishedAt ?? 0;
    return d >= fromMs - 86_400_000;
  });
  const voids = tennis.filter((e) => phase(e.gameStatus) !== "other");
  const need = [...voids];
  // Also pull finished/open without a twin yet
  for (const e of tennis) {
    if (need.length >= limit) break;
    if (need.some((x) => x.eventId === e.eventId)) continue;
    const twin = findPredictTwins(e.title, 1, {
      anchorMs: e.eventDate ? Date.parse(e.eventDate) : null,
    })[0];
    if (!twin || twin.score < 0.55) need.push(e);
  }
  const targets = need.slice(0, limit);
  console.log(
    `backfill PF twins  voids=${voids.length} targets=${targets.length} days=${days} ` +
      `(retired/canceled first)`,
  );

  const found = new Map<string, PredictMarket[]>();
  for (const ev of targets) {
    const queries = surnameQueries(ev.title);
    if (!queries.length) continue;
    const bag: PredictMarket[] = [];
    for (const q of queries.slice(0, 2)) {
      for (const status of ["closed", "open"] as const) {
        try {
          const page = await listPredictMarkets(client, {
            status,
            search: q,
            maxPages: 2,
            limit: 40,
          });
          bag.push(...page);
        } catch (e) {
          console.warn(`  search fail ${q}/${status}:`, e instanceof Error ? e.message : e);
        }
      }
    }
    const groups = groupPredictEvents(bag);
    let best: ReturnType<typeof groupPredictEvents>[number] | null = null;
    let bestScore = 0;
    for (const g of groups) {
      const score = titleSimilarity(ev.title, g.title);
      if (score > bestScore) {
        bestScore = score;
        best = g;
      }
    }
    if (best && bestScore >= 0.55) {
      found.set(best.eventId, best.markets);
      console.log(
        `  HIT ${bestScore.toFixed(2)} [${ev.gameStatus ?? "?"}] ${ev.title.slice(0, 50)} <=> ${best.title.slice(0, 50)}`,
      );
    } else {
      console.log(`  miss [${ev.gameStatus ?? "?"}] ${ev.title.slice(0, 60)}`);
    }
  }

  console.log(`\ndownloading ${found.size} PF events…`);
  const hub = new MonitorHub();
  let downloaded = 0;
  let skipped = 0;
  for (const [, markets] of found) {
    const groups = groupPredictEvents(markets);
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
        const tokenId =
          market.outcomes[0]?.tokenId || `pf:${market.marketId}:yes`;
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
          console.warn(`  book fail ${market.marketId}:`, e instanceof Error ? e.message : e);
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
      console.log(`  saved ${event.title.slice(0, 55)} snaps=${snaps}`);
    }
  }
  hub.close();
  console.log(`done downloaded=${downloaded} skipped=${skipped}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

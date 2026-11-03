/**
 * Download Predict.fun weather orderbooks for the last N days of local Poly weather.
 * Does NOT touch Polymarket books.
 *
 *   npx tsx scripts/download-pf-weather.ts
 *   npx tsx scripts/download-pf-weather.ts --days 5
 *   npx tsx scripts/download-pf-weather.ts --from 2026-09-20 --to 2026-09-25
 */
import "../src/config/env.ts";
import { ensureDataDirs } from "../src/config/env.ts";
import {
  bestOf,
  depthSum,
  MonitorHub,
  normalizeBookSide,
} from "../src/db/store.ts";
import { maskApiKey, parseApiKeysFromEnv } from "../src/predexon/client.ts";
import {
  fetchPredictOrderbooks,
  groupPredictEvents,
  listPredictMarkets,
  type PredictMarket,
} from "../src/predexon/predictfun.ts";
import {
  extractPfLine,
  guessPfMarketType,
  weatherBucketLabel,
} from "../src/predexon/pfFootball.ts";
import type {
  BookSnapshot,
  MonitoredEvent,
  MonitoredMarket,
  MonitoredToken,
} from "../src/types/monitoring.ts";
import { listEvents } from "../web/lib/db.ts";
import Database from "better-sqlite3";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const SPORT = "predictfun" as const;

function readArg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function dayMs(isoDay: string, end: boolean): number {
  return Date.parse(`${isoDay}T${end ? "23:59:59" : "00:00:00"}Z`);
}

function polyWeatherWindow(days: number): { fromDay: string; toDay: string; fromMs: number; toMs: number } {
  const weather = listEvents("weather");
  const dates = weather
    .map((e) => e.eventDate)
    .filter((d): d is string => Boolean(d) && /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
  if (!dates.length) throw new Error("No Polymarket weather events with eventDate in local DB");
  const toDay = dates[dates.length - 1]!;
  const to = new Date(`${toDay}T12:00:00Z`);
  const from = new Date(to.getTime() - (days - 1) * 86_400_000);
  const fromDay = from.toISOString().slice(0, 10);
  return {
    fromDay,
    toDay,
    fromMs: dayMs(fromDay, false),
    toMs: dayMs(toDay, true),
  };
}

function sideForOutcome(label: string, index: number): string {
  const l = label.trim().toLowerCase();
  if (l === "yes" || l === "over") return l;
  if (l === "no" || l === "under") return l;
  if (index === 0) return "home";
  if (index === 1) return "away";
  return `out${index}`;
}

function isWeatherMarket(m: PredictMarket): boolean {
  return (
    /highest\s+temp/i.test(m.title) ||
    /temperature\s+in\s+/i.test(m.title) ||
    /\d+\s*°\s*[CF]\b/i.test(m.title)
  );
}

function toEvent(group: ReturnType<typeof groupPredictEvents>[number]): MonitoredEvent {
  const markets: MonitoredMarket[] = [];
  for (const m of group.markets) {
    const marketType = guessPfMarketType(m.title, m.marketVariant);
    const line = extractPfLine(m.title, marketType);
    const marketId = `pf:${m.marketId}`;
    const tokens: MonitoredToken[] = m.outcomes.map((o, i) => {
      const side = sideForOutcome(o.label, i);
      return {
        tokenId: o.tokenId || `${marketId}:${side}`,
        marketId,
        eventId: group.eventId,
        sport: SPORT,
        marketType,
        side,
        label: marketType === "weather" ? weatherBucketLabel(m.title) : o.label,
        line,
      };
    });
    markets.push({
      marketId,
      eventId: group.eventId,
      sport: SPORT,
      marketType,
      question: m.title,
      line,
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

const WEATHER_SEARCHES = [
  "Highest temperature",
  "Tokyo",
  "Buenos Aires",
  "Seoul",
  "London",
  "Paris",
  "NYC",
  "New York",
  "Chicago",
  "Miami",
  "Houston",
  "Seattle",
  "Shanghai",
  "Hong Kong",
  "Taipei",
  "Shenzhen",
  "Singapore",
  "Madrid",
  "Berlin",
  "Toronto",
  "Mexico City",
  "Sao Paulo",
  "Sydney",
  "Dubai",
  "Los Angeles",
  "Atlanta",
  "Dallas",
  "Phoenix",
  "Denver",
  "Boston",
  "Washington",
  "San Francisco",
];

async function main() {
  ensureDataDirs();
  const argv = process.argv.slice(2);
  const days = Math.max(1, Number(readArg(argv, "--days") ?? "5"));
  const fromArg = readArg(argv, "--from");
  const toArg = readArg(argv, "--to");

  let fromDay: string;
  let toDay: string;
  let fromMs: number;
  let toMs: number;
  if (fromArg && toArg) {
    fromDay = fromArg.slice(0, 10);
    toDay = toArg.slice(0, 10);
    fromMs = dayMs(fromDay, false);
    toMs = dayMs(toDay, true);
  } else {
    const w = polyWeatherWindow(days);
    fromDay = w.fromDay;
    toDay = w.toDay;
    fromMs = w.fromMs;
    toMs = w.toMs;
  }

  // Book history window: a few days before event day through end of last day
  const bookFromMs = fromMs - 3 * 86_400_000;
  const bookToMs = toMs + 86_400_000;

  const client = {
    apiKeys: parseApiKeysFromEnv(),
    requestDelayMs: Number(process.env.PREDEXON_REQUEST_DELAY_MS ?? "40"),
  };

  console.log(
    `PF weather books  poly-window=${fromDay}→${toDay} (${days}d)  keys=${client.apiKeys.map(maskApiKey).join(",")}`,
  );

  const byId = new Map<number, PredictMarket>();
  for (const status of ["closed", "open"] as const) {
    for (const search of WEATHER_SEARCHES) {
      process.stdout.write(`  catalog ${status} "${search}"… `);
      try {
        const page = await listPredictMarkets(client, {
          status,
          search,
          sort: "created",
          maxPages: 6,
          createdAfterMs: bookFromMs,
          createdBeforeMs: bookToMs,
        });
        let n = 0;
        for (const m of page) {
          if (!isWeatherMarket(m)) continue;
          byId.set(m.marketId, m);
          n++;
        }
        console.log(`${page.length} hits → ${n} weather`);
      } catch (e) {
        console.log(`FAIL ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  const markets = [...byId.values()];
  const groups = groupPredictEvents(markets).filter((g) =>
    g.markets.some(isWeatherMarket) || /highest\s+temp|temperature\s+in/i.test(g.title),
  );
  console.log(`  events=${groups.length} markets=${markets.length}`);

  const hub = new MonitorHub();
  let ok = 0;
  let snapsTotal = 0;
  let errors = 0;
  let empty = 0;

  for (const group of groups) {
    try {
      const weatherMarkets = group.markets.filter(isWeatherMarket);
      if (!weatherMarkets.length) continue;
      const event = toEvent({ ...group, markets: weatherMarkets });
      // Prefer eventDate from title "on October 2" / "on Sep 25" when possible
      const onDate =
        /on\s+([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?/i.exec(event.title) ??
        /on\s+(\d{4}-\d{2}-\d{2})/i.exec(event.title);
      if (onDate) {
        if (onDate[0].includes("-")) {
          event.eventDate = onDate[1]!;
        } else {
          const year = onDate[3] ? Number(onDate[3]) : Number(toDay.slice(0, 4));
          const parsed = Date.parse(`${onDate[1]} ${onDate[2]}, ${year} UTC`);
          if (Number.isFinite(parsed)) {
            event.eventDate = new Date(parsed).toISOString().slice(0, 10);
          }
        }
      }
      // Skip events outside the poly 5-day window when we know the date
      if (event.eventDate && (event.eventDate < fromDay || event.eventDate > toDay)) {
        continue;
      }

      hub.resetDownload(event.eventId);
      hub.syncCatalog([event]);

      let snaps = 0;
      let lastTs: number | null = null;
      for (const market of weatherMarkets) {
        const tokenId = market.outcomes[0]?.tokenId || `pf:${market.marketId}:yes`;
        const rows = await fetchPredictOrderbooks(client, market.marketId, bookFromMs, bookToMs);
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
      }

      if (snaps > 0) {
        hub.markDownloadComplete(event.eventId, {
          tokens: event.markets.reduce((n, m) => n + m.tokens.length, 0),
          snapshots: snaps,
          lastTs,
          fromMs: bookFromMs,
          toMs: bookToMs,
        });
        ok++;
        snapsTotal += snaps;
        console.log(
          `  ok ${event.eventId} mk=${weatherMarkets.length} snaps=${snaps} ${event.title.slice(0, 60)}`,
        );
      } else {
        hub.markDownloadIncomplete(event.eventId, {
          tokens: event.markets.reduce((n, m) => n + m.tokens.length, 0),
          fromMs: bookFromMs,
          toMs: bookToMs,
          note: "pf weather: 0 snaps",
        });
        empty++;
        console.log(`  empty ${event.eventId} ${event.title.slice(0, 60)}`);
      }
    } catch (e) {
      errors++;
      console.error(`  error ${group.eventId}:`, e instanceof Error ? e.message : e);
    }
  }

  hub.close();

  // Summary twin-able weather in PF shards
  let pfWeather = 0;
  for (const f of readdirSync("data/predictfun").filter((x) => /^\d{4}-\d{2}\.db$/.test(x))) {
    const db = new Database(join("data/predictfun", f), { readonly: true });
    const n = (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM ev WHERE lower(t) LIKE '%temperature%' OR lower(t) LIKE '%highest temp%'`,
        )
        .get() as { c: number }
    ).c;
    pfWeather += n;
    db.close();
  }

  console.log(
    `done ok=${ok} empty=${empty} snaps=${snapsTotal} errors=${errors} pfWeatherEvents≈${pfWeather}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

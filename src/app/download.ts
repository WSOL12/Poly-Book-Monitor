/**
 * Download recorded Polymarket orderbooks from Predexon into data/{sport}/{YYYY-MM}.db.
 *
 *   npm run download
 *   npm run download -- --sports soccer,mlb --days 2
 *   npm run download -- --status closed --from 2026-09-20 --to 2026-09-25
 *   npm run download -- --force   # ignore dl.complete and re-fetch
 *
 * Re-download protect (same idea as compare-poly-predict markets.complete):
 *   dl.complete=1 → skip event on re-run unless --force
 *
 * Free orderbook history: https://docs.predexon.com/api-reference/markets/orderbooks
 */
import { SPORTS, type EnvSport } from "../config/env.ts";
import { allTokens, parseHistorySportEvents } from "../catalog/parsers.ts";
import {
  bestOf,
  depthSum,
  monthForEvent,
  MonitorHub,
  normalizeBookSide,
} from "../db/store.ts";
import {
  hydrateEventMarkets,
  listSportEvents,
  SPORT_TAGS,
} from "../predexon/catalog.ts";
import { maskApiKey, parseApiKeysFromEnv, type PredexonClientOptions } from "../predexon/client.ts";
import { fetchPolyOrderbooks } from "../predexon/orderbooks.ts";
import type { BookSnapshot, MonitoredEvent, MonitorSport } from "../types/monitoring.ts";

type Options = {
  client: PredexonClientOptions;
  sports: MonitorSport[];
  status: "open" | "closed" | "both";
  fromMs: number;
  toMs: number;
  concurrency: number;
  eventLimit: number | null;
  force: boolean;
};

function envValue(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

function readArg(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  return argv[index + 1];
}

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(name);
}

function parseUnixOrDate(raw: string, endOfDay: boolean): number {
  if (/^\d{10}$/.test(raw)) return Number(raw) * 1000;
  if (/^\d{13}$/.test(raw)) return Number(raw);
  const d = new Date(raw.includes("T") ? raw : `${raw}T${endOfDay ? "23:59:59" : "00:00:00"}Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`Bad date/unix: ${raw}`);
  return d.getTime();
}

function parseSports(raw: string): MonitorSport[] {
  const parts = [
    ...new Set(
      raw
        .split(",")
        .map((p) => p.trim().toLowerCase())
        .filter(Boolean)
        .map((p) => (p === "nfl" ? "football" : p)),
    ),
  ];
  if (parts.length === 0) throw new Error("Pass at least one sport");
  for (const p of parts) {
    if (!(SPORTS as readonly string[]).includes(p)) {
      throw new Error(`Unknown sport "${p}". Use: ${SPORTS.join(", ")}`);
    }
  }
  return parts as MonitorSport[];
}

function parseOptions(argv: string[]): Options {
  const apiKeys = parseApiKeysFromEnv();
  const sports = parseSports(readArg(argv, "--sports") ?? envValue("DOWNLOAD_SPORTS", SPORTS.join(",")));
  const statusRaw = (readArg(argv, "--status") ?? envValue("DOWNLOAD_STATUS", "both")).toLowerCase();
  if (statusRaw !== "open" && statusRaw !== "closed" && statusRaw !== "both") {
    throw new Error(`Bad --status / DOWNLOAD_STATUS: ${statusRaw}`);
  }

  const now = Date.now();
  const fromRaw = readArg(argv, "--from") ?? envValue("DOWNLOAD_FROM");
  const toRaw = readArg(argv, "--to") ?? envValue("DOWNLOAD_TO");
  const daysRaw = readArg(argv, "--days") ?? envValue("DOWNLOAD_DAYS", "1");
  let fromMs: number;
  let toMs: number;
  if (fromRaw && toRaw) {
    fromMs = parseUnixOrDate(fromRaw, false);
    toMs = parseUnixOrDate(toRaw, true);
  } else if (fromRaw) {
    fromMs = parseUnixOrDate(fromRaw, false);
    toMs = toRaw ? parseUnixOrDate(toRaw, true) : now;
  } else {
    const days = Math.max(0.01, Number(daysRaw));
    if (!Number.isFinite(days)) throw new Error(`Bad DOWNLOAD_DAYS / --days: ${daysRaw}`);
    toMs = toRaw ? parseUnixOrDate(toRaw, true) : now;
    fromMs = toMs - Math.floor(days * 86_400_000);
  }
  if (toMs <= fromMs) throw new Error(`to must be after from`);

  const delayRaw =
    readArg(argv, "--delay-ms") ??
    (envValue("PREDEXON_REQUEST_DELAY_MS") || envValue("HISTORY_REQUEST_DELAY_MS") || "12");
  const delay = Number(delayRaw);
  const concRaw =
    readArg(argv, "--concurrency") ??
    envValue("DOWNLOAD_CONCURRENCY", String(Math.max(8, apiKeys.length * 8)));
  const concurrency = Math.max(1, Math.floor(Number(concRaw) || 8));
  const limitRaw = readArg(argv, "--limit") ?? envValue("DOWNLOAD_LIMIT");
  const eventLimit = limitRaw ? Math.max(1, Number(limitRaw)) : null;

  return {
    client: {
      apiKeys,
      requestDelayMs: Number.isFinite(delay) && delay >= 0 ? delay : 12,
    },
    sports,
    status: statusRaw,
    fromMs,
    toMs,
    concurrency,
    eventLimit: eventLimit != null && Number.isFinite(eventLimit) ? eventLimit : null,
    force: hasFlag(argv, "--force"),
  };
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const n = Math.min(Math.max(1, concurrency), Math.max(1, items.length));
  await Promise.all(
    Array.from({ length: n }, async () => {
      for (;;) {
        const index = next++;
        if (index >= items.length) return;
        results[index] = await worker(items[index]!, index);
      }
    }),
  );
  return results;
}

function eventTimeRangeMs(event: MonitoredEvent, fallbackFrom: number, fallbackTo: number): {
  startMs: number;
  endMs: number;
} {
  const startCandidates = [event.startTime, event.eventDate]
    .map((v) => (v ? Date.parse(v.length === 10 ? `${v}T00:00:00Z` : v) : NaN))
    .filter((n) => Number.isFinite(n));
  const endCandidates = [event.finishedAt ?? NaN]
    .concat(event.startTime ? Date.parse(event.startTime) + 6 * 3600_000 : NaN)
    .filter((n) => Number.isFinite(n));

  let startMs = startCandidates.length ? Math.min(...startCandidates) : fallbackFrom;
  let endMs = endCandidates.length ? Math.max(...endCandidates) : fallbackTo;
  const floor = Date.parse("2026-01-01T00:00:00Z");
  startMs = Math.max(startMs, floor, fallbackFrom);
  endMs = Math.min(Math.max(endMs, startMs + 60_000), fallbackTo);
  if (!event.ended && !event.closed) endMs = Math.min(Date.now(), fallbackTo);
  return { startMs, endMs };
}

function writeSnapshots(
  hub: MonitorHub,
  sport: MonitorSport,
  eventId: string,
  tokenId: string,
  snaps: Array<{ ts: number; bids: { price: number; size: number }[]; asks: { price: number; size: number }[] }>,
) {
  for (const snap of snaps) {
    const bids = normalizeBookSide(snap.bids, "bid");
    const asks = normalizeBookSide(snap.asks, "ask");
    const row: BookSnapshot = {
      tokenId,
      eventId,
      sport,
      capturedAt: snap.ts,
      bestBid: bestOf(bids, "bid"),
      bestAsk: bestOf(asks, "ask"),
      bidDepth: depthSum(bids),
      askDepth: depthSum(asks),
      bids,
      asks,
      source: "rest",
    };
    hub.recordSnapshot(row);
  }
}

async function downloadEvent(
  opts: Options,
  hub: MonitorHub,
  sport: MonitorSport,
  event: MonitoredEvent,
): Promise<"downloaded" | "skipped" | "error"> {
  hub.syncCatalog([event]);
  const tokens = allTokens([event]);
  if (!tokens.length) return "skipped";

  // Same protect as compare-poly-predict: complete=1 → skip unless --force
  if (!opts.force && hub.isDownloadComplete(event.eventId)) {
    return "skipped";
  }

  const range = eventTimeRangeMs(event, opts.fromMs, opts.toMs);

  if (opts.force) {
    hub.resetDownload(event.eventId);
  }

  hub.markDownloadIncomplete(event.eventId, {
    tokens: tokens.length,
    fromMs: range.startMs,
    toMs: range.endMs,
  });

  try {
    let totalSnaps = 0;
    let lastTs: number | null = null;

    for (const tok of tokens) {
      let startMs = range.startMs;
      if (!opts.force) {
        const last = hub.lastTokenSnapshotTs(tok.tokenId, event.eventId);
        if (last != null) startMs = Math.max(startMs, last + 1);
      }
      if (startMs >= range.endMs) continue;

      const snaps = await fetchPolyOrderbooks(opts.client, tok.tokenId, startMs, range.endMs);
      if (snaps.length) {
        writeSnapshots(hub, sport, event.eventId, tok.tokenId, snaps);
        totalSnaps += snaps.length;
        const tip = snaps[snaps.length - 1]!.ts;
        if (lastTs == null || tip > lastTs) lastTs = tip;
      }
    }

    // Closed/ended events freeze as complete=1 (skip on next run).
    // Open events stay incomplete so a later run can append new books.
    const settled = event.ended || event.closed;
    if (settled) {
      hub.markDownloadComplete(event.eventId, {
        tokens: tokens.length,
        snapshots: totalSnaps,
        lastTs,
        fromMs: range.startMs,
        toMs: range.endMs,
      });
    } else {
      hub.markDownloadIncomplete(event.eventId, {
        tokens: tokens.length,
        fromMs: range.startMs,
        toMs: range.endMs,
        note: `open; snaps=${totalSnaps}`,
      });
    }

    return "downloaded";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    hub.markDownloadIncomplete(event.eventId, {
      tokens: tokens.length,
      fromMs: range.startMs,
      toMs: range.endMs,
      note: message,
    });
    throw error;
  }
}

async function runSport(opts: Options, hub: MonitorHub, sport: MonitorSport) {
  console.log(`\n=== ${sport} (tags: ${SPORT_TAGS[sport].join(", ")}) ===`);
  const gammaEvents = await listSportEvents(opts.client, {
    sport,
    status: opts.status,
    fromMs: opts.fromMs,
    toMs: opts.toMs,
    limit: opts.eventLimit,
  });
  console.log(`  catalog: ${gammaEvents.length} raw events from Predexon`);

  const hydrated = await mapPool(gammaEvents, Math.min(4, opts.concurrency), async (ev) => {
    if ((ev.markets?.length ?? 0) >= 45 || ((ev.markets?.length ?? 0) === 0 && ev.slug)) {
      return hydrateEventMarkets(opts.client, ev);
    }
    return ev;
  });

  const parsed = parseHistorySportEvents(sport, hydrated);
  console.log(`  parsed: ${parsed.length} events with tradeable markets`);

  let downloaded = 0;
  let skipped = 0;
  let errors = 0;

  await mapPool(parsed, opts.concurrency, async (event) => {
    const month = monthForEvent(event);
    try {
      const result = await downloadEvent(opts, hub, sport, event);
      if (result === "skipped") {
        skipped++;
        console.log(`  · skip ${month} ${event.title.slice(0, 60)}`);
      } else {
        downloaded++;
        console.log(`  ✓ ${month} ${event.title.slice(0, 60)}`);
      }
    } catch (error) {
      errors++;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`  ✗ ${month} ${event.title.slice(0, 50)}: ${message}`);
    }
  });

  console.log(`  done ${sport}: downloaded=${downloaded} skipped=${skipped} errors=${errors}`);
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseOptions(argv);
  console.log(
    `Predexon download  sports=${opts.sports.join(",")}  status=${opts.status}  ` +
      `from=${new Date(opts.fromMs).toISOString()}  to=${new Date(opts.toMs).toISOString()}  ` +
      `keys=${opts.client.apiKeys.length} [${opts.client.apiKeys.map(maskApiKey).join(", ")}]  ` +
      `delayMs=${opts.client.requestDelayMs}  concurrency=${opts.concurrency}  force=${opts.force}`,
  );

  const hub = new MonitorHub();
  try {
    for (const sport of opts.sports) {
      await runSport(opts, hub, sport as EnvSport);
    }
    hub.checkpointAll("TRUNCATE");
    const stats = hub.stats();
    console.log(
      `\nAll done. DB totals: events=${stats.events} tokens=${stats.tokens} snapshots=${stats.snapshots}`,
    );
    console.log(`Shards: data/{sport}/{YYYY-MM}.db  (dl.complete=1 skips re-download)`);
  } finally {
    hub.close();
  }
}

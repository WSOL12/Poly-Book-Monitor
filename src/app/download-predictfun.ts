/**
 * Download Predict.Fun sports markets + YES-side orderbooks from Predexon.
 *
 *   npm run download:predictfun
 *   npm run download:predictfun -- --status both --days 7 --limit 20
 *   npm run download:predictfun -- --force
 *
 * Stores under data/predictfun/{YYYY-MM}.db (same schema as Poly sports).
 * Books are YES-side only (Predexon PF orderbooks).
 */
import "../config/env.ts";
import { ensureDataDirs } from "../config/env.ts";
import {
  bestOf,
  depthSum,
  MonitorHub,
  normalizeBookSide,
} from "../db/store.ts";
import { maskApiKey, parseApiKeysFromEnv, type PredexonClientOptions } from "../predexon/client.ts";
import {
  fetchPredictOrderbooks,
  groupPredictEvents,
  listPredictMarkets,
  type PredictMarket,
} from "../predexon/predictfun.ts";
import {
  extractPfLine,
  guessPfMarketType,
  isPfFootballSlug,
  listFootballFixtureMarkets,
  pfFootballBaseSlug,
  pfFootballParentEventId,
  weatherBucketLabel,
} from "../predexon/pfFootball.ts";
import type {
  BookSnapshot,
  MarketType,
  MonitoredEvent,
  MonitoredMarket,
  MonitoredToken,
} from "../types/monitoring.ts";

const SPORT = "predictfun" as const;

type Options = {
  client: PredexonClientOptions;
  status: "open" | "closed" | "both";
  fromMs: number;
  toMs: number;
  concurrency: number;
  eventLimit: number | null;
  force: boolean;
  variants: Array<"SPORTS_TEAM_MATCH" | "SPORTS_MATCH" | "DEFAULT">;
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

function parseOptions(argv: string[]): Options {
  const apiKeys = parseApiKeysFromEnv();
  const statusRaw = (readArg(argv, "--status") ?? envValue("PF_DOWNLOAD_STATUS", "both")).toLowerCase();
  if (statusRaw !== "open" && statusRaw !== "closed" && statusRaw !== "both") {
    throw new Error(`Bad --status: ${statusRaw}`);
  }
  const now = Date.now();
  const fromRaw = readArg(argv, "--from") ?? envValue("PF_DOWNLOAD_FROM");
  const toRaw = readArg(argv, "--to") ?? envValue("PF_DOWNLOAD_TO");
  const daysRaw = readArg(argv, "--days") ?? envValue("PF_DOWNLOAD_DAYS", envValue("DOWNLOAD_DAYS", "30"));
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
    if (!Number.isFinite(days)) throw new Error(`Bad --days: ${daysRaw}`);
    fromMs = now - days * 24 * 60 * 60_000;
    toMs = now;
  }

  const concurrency = Math.max(
    1,
    Number(readArg(argv, "--concurrency") ?? envValue("DOWNLOAD_CONCURRENCY", String(apiKeys.length * 4))),
  );
  const limitRaw = readArg(argv, "--limit") ?? envValue("PF_DOWNLOAD_LIMIT");
  const eventLimit = limitRaw ? Math.max(1, Number(limitRaw)) : null;
  if (eventLimit != null && !Number.isFinite(eventLimit)) throw new Error(`Bad --limit: ${limitRaw}`);

  return {
    client: {
      apiKeys,
      requestDelayMs: Math.max(
        0,
        Number(readArg(argv, "--delay-ms") ?? envValue("PREDEXON_REQUEST_DELAY_MS", "50")),
      ),
    },
    status: statusRaw,
    fromMs,
    toMs,
    concurrency,
    eventLimit,
    force: hasFlag(argv, "--force"),
    variants: ["SPORTS_TEAM_MATCH", "SPORTS_MATCH", "DEFAULT"],
  };
}

function guessMarketType(title: string, variant?: string): MarketType {
  return guessPfMarketType(title, variant);
}

function sideForOutcome(label: string, index: number): string {
  const l = label.trim().toLowerCase();
  if (l === "yes" || l === "over") return l;
  if (l === "no" || l === "under") return l;
  if (index === 0) return "home";
  if (index === 1) return "away";
  return `out${index}`;
}

/** "US Open ATP: Jaime Faria vs Carlos Alcaraz" → ["Faria","Alcaraz"] for Yes/No books. */
function playersFromMatchTitle(title: string): [string, string] | null {
  const raw = title.replace(/^[^:]+:\s*/, " ").trim();
  const parts = raw.split(/\s+vs\.?\s+|\s+versus\s+/i);
  if (parts.length !== 2) return null;
  const name = (s: string) => {
    const words = s.replace(/[^a-zA-Z0-9\s]/g, " ").replace(/\s+/g, " ").trim().split(" ");
    const last = words[words.length - 1] ?? s;
    return last ? last.charAt(0).toUpperCase() + last.slice(1) : s;
  };
  const a = name(parts[0]!);
  const b = name(parts[1]!);
  if (!a || !b) return null;
  return [a, b];
}

function outcomeLabel(raw: string, side: string, marketTitle: string, index: number): string {
  const generic = /^(yes|no|over|under)$/i.test(raw.trim());
  if (!generic) return raw;
  const players = playersFromMatchTitle(marketTitle);
  if (players && (side === "yes" || side === "no" || side === "home" || side === "away")) {
    return side === "no" || side === "away" ? players[1] : players[0];
  }
  // Soccer SPORTS_TEAM_MATCH: market title is the team / outcome name
  if (side === "yes" || index === 0) return marketTitle;
  if (side === "no") return `No ${marketTitle}`;
  return raw;
}

/** YES books attach to first outcome; other outcomes keep catalog only. */
function toMonitoredEvent(
  group: ReturnType<typeof groupPredictEvents>[number],
  opts?: { eventId?: string; title?: string; slug?: string },
): MonitoredEvent {
  const eventId = opts?.eventId ?? group.eventId;
  const markets: MonitoredMarket[] = [];
  for (const m of group.markets) {
    const marketType = guessMarketType(m.title, m.marketVariant);
    const line = extractPfLine(m.title, marketType);
    const marketId = `pf:${m.marketId}`;
    const tokens: MonitoredToken[] = m.outcomes.map((o, i) => {
      const side = sideForOutcome(o.label, i);
      const label =
        marketType === "weather"
          ? weatherBucketLabel(m.title)
          : outcomeLabel(o.label, side, m.title, i);
      return {
        tokenId: o.tokenId || `${marketId}:${side}`,
        marketId,
        eventId,
        sport: SPORT,
        marketType,
        side,
        label,
        line,
      };
    });
    if (!tokens.length) {
      tokens.push({
        tokenId: `${marketId}:yes`,
        marketId,
        eventId,
        sport: SPORT,
        marketType,
        side: "yes",
        label: "Yes",
        line,
      });
    }
    markets.push({
      marketId,
      eventId,
      sport: SPORT,
      marketType,
      question: m.title,
      line,
      tokens,
    });
  }

  const createdMs = group.createdTime ? Date.parse(group.createdTime) : NaN;
  const eventDate = Number.isFinite(createdMs) ? new Date(createdMs).toISOString().slice(0, 10) : null;
  const slug = opts?.slug ?? group.eventSlug ?? group.eventId;

  return {
    eventId,
    sport: SPORT,
    title: opts?.title ?? group.title,
    slug,
    startTime: group.createdTime,
    eventDate,
    ended: group.status === "closed",
    polyLive: false,
    closed: group.status === "closed",
    gameStatus: group.status === "closed" ? "closed" : "open",
    finishedAt: group.status === "closed" && Number.isFinite(createdMs) ? createdMs : null,
    markets,
  };
}

/** Book token for a PF market = first outcome (YES side). */
function yesTokenId(market: PredictMarket, eventId: string): string {
  const first = market.outcomes[0];
  if (first?.tokenId) return first.tokenId;
  return `pf:${market.marketId}:yes`;
}

function writeSnapshots(
  hub: MonitorHub,
  eventId: string,
  tokenId: string,
  snaps: Array<{ ts: number; bids: { price: number; size: number }[]; asks: { price: number; size: number }[]; bestBid: number | null; bestAsk: number | null }>,
) {
  for (const snap of snaps) {
    const bids = normalizeBookSide(snap.bids, "bid");
    const asks = normalizeBookSide(snap.asks, "ask");
    const row: BookSnapshot = {
      tokenId,
      eventId,
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
  }
}

async function downloadGroup(opts: Options, hub: MonitorHub, group: ReturnType<typeof groupPredictEvents>[number]) {
  let working = group;
  const slug = group.eventSlug ?? "";
  // Football props live on sibling slugs — merge into the parent fixture event.
  if (slug && isPfFootballSlug(slug)) {
    const base = pfFootballBaseSlug(slug);
    const statuses: Array<"open" | "closed"> =
      opts.status === "both" ? ["open", "closed"] : [opts.status];
    const allMarkets = await listFootballFixtureMarkets(opts.client, base, {
      statuses,
      maxPages: 15,
    });
    if (allMarkets.length) {
      const merged = groupPredictEvents(allMarkets);
      const flat = merged.flatMap((g) => g.markets);
      const byId = new Map(flat.map((m) => [m.marketId, m]));
      const money = merged.find((g) => g.eventSlug === base) ?? merged[0]!;
      working = {
        ...money,
        eventId: pfFootballParentEventId(base),
        eventSlug: base,
        title: money.title,
        markets: [...byId.values()],
      };
    }
  }

  const event = toMonitoredEvent(working, {
    eventId: isPfFootballSlug(working.eventSlug ?? "")
      ? pfFootballParentEventId(working.eventSlug!)
      : working.eventId,
    slug: working.eventSlug
      ? isPfFootballSlug(working.eventSlug)
        ? pfFootballBaseSlug(working.eventSlug)
        : working.eventSlug
      : working.eventId,
  });
  hub.syncCatalog([event]);

  if (!opts.force && hub.isDownloadComplete(event.eventId)) return "skipped" as const;

  // Orderbooks live from market creation → kickoff+buffer, NOT the catalog paging window.
  const createdMs = working.createdTime ? Date.parse(working.createdTime) : NaN;
  const slugDate = /-(\d{4}-\d{2}-\d{2})$/.exec(pfFootballBaseSlug(working.eventSlug ?? ""))?.[1];
  const matchEndMs = slugDate ? Date.parse(`${slugDate}T23:59:59Z`) : NaN;
  let startMs = opts.fromMs;
  let endMs = opts.toMs;
  if (Number.isFinite(createdMs)) startMs = Math.min(startMs, createdMs);
  if (Number.isFinite(matchEndMs)) {
    startMs = Math.min(startMs, matchEndMs - 14 * 86_400_000);
    endMs = Math.max(endMs, matchEndMs + 2 * 86_400_000);
  }
  if (endMs <= startMs) {
    endMs = startMs + 7 * 86_400_000;
  }

  if (opts.force) hub.resetDownload(event.eventId);
  hub.markDownloadIncomplete(event.eventId, {
    tokens: event.markets.reduce((n, m) => n + m.tokens.length, 0),
    fromMs: startMs,
    toMs: endMs,
  });

  let totalSnaps = 0;
  let lastTs: number | null = null;
  for (const market of working.markets) {
    const tokenId = yesTokenId(market, event.eventId);
    let from = startMs;
    if (!opts.force) {
      const last = hub.lastTokenSnapshotTs(tokenId, event.eventId);
      if (last != null) from = Math.max(from, last + 1);
    }
    if (from >= endMs) continue;
    const snaps = await fetchPredictOrderbooks(opts.client, market.marketId, from, endMs);
    if (snaps.length) {
      writeSnapshots(hub, event.eventId, tokenId, snaps);
      totalSnaps += snaps.length;
      const tip = snaps[snaps.length - 1]!.ts;
      if (lastTs == null || tip > lastTs) lastTs = tip;
    }
  }

  const settled = event.ended || event.closed;
  if (settled && totalSnaps > 0) {
    hub.markDownloadComplete(event.eventId, {
      tokens: event.markets.reduce((n, m) => n + m.tokens.length, 0),
      snapshots: totalSnaps,
      lastTs,
      fromMs: startMs,
      toMs: endMs,
    });
  } else {
    hub.markDownloadIncomplete(event.eventId, {
      tokens: event.markets.reduce((n, m) => n + m.tokens.length, 0),
      fromMs: startMs,
      toMs: endMs,
      note: settled ? `closed but snaps=${totalSnaps}` : `open; snaps=${totalSnaps}`,
    });
  }
  return "downloaded" as const;
}

async function mapPool<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return out;
}

export async function main(argv = process.argv.slice(2)) {
  ensureDataDirs();
  const opts = parseOptions(argv);
  console.log(
    `Predict.Fun download  status=${opts.status}  variants=${opts.variants.join(",")}  ` +
      `from=${new Date(opts.fromMs).toISOString()}  to=${new Date(opts.toMs).toISOString()}  ` +
      `keys=${opts.client.apiKeys.length} (${opts.client.apiKeys.map(maskApiKey).join(", ")})  ` +
      `delay=${opts.client.requestDelayMs}ms  concurrency=${opts.concurrency}` +
      (opts.eventLimit != null ? `  limit=${opts.eventLimit}` : "") +
      (opts.force ? "  FORCE" : ""),
  );

  const hub = new MonitorHub();
  const statuses: Array<"open" | "closed"> =
    opts.status === "both" ? ["open", "closed"] : [opts.status];

  const markets: PredictMarket[] = [];
  for (const status of statuses) {
    for (const marketVariant of opts.variants) {
      console.log(`  catalog ${status} ${marketVariant}…`);
      // Page until created_time falls before the window — 80 pages was truncating
      // older closed tennis (US Open voids etc.) under newer soccer/NFL noise.
      const page = await listPredictMarkets(opts.client, {
        status,
        marketVariant,
        sort: "created",
        maxPages: 400,
        createdAfterMs: opts.fromMs,
        createdBeforeMs: opts.toMs,
        limit: opts.eventLimit ?? undefined,
      });
      console.log(`    → ${page.length} markets in window`);
      markets.push(...page);
    }
  }

  // Targeted tennis searches — closed US Open / China Open etc. sit far down the
  // global created feed and were previously skipped, so retired/canceled Poly
  // twins never appeared.
  const tennisSearches = [
    "US Open",
    "China Open",
    "Laver Cup",
    "Wimbledon",
    "Cincinnati",
    "Singapore Open",
    "Korea Open",
    "Davis Cup",
    "ATP",
    "WTA",
  ];
  for (const search of tennisSearches) {
    for (const status of statuses) {
      console.log(`  catalog search "${search}" ${status}…`);
      const page = await listPredictMarkets(opts.client, {
        status,
        search,
        sort: "created",
        maxPages: 15,
        createdAfterMs: opts.fromMs - 7 * 86_400_000, // allow create-before-start
        createdBeforeMs: opts.toMs,
      });
      console.log(`    → ${page.length} markets`);
      markets.push(...page);
    }
  }

  // Weather (DEFAULT variant) — "Highest temperature in Tokyo…" etc.
  // DEFAULT feed is huge; search by city / phrase so we actually get weather.
  const weatherSearches = [
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
  ];
  for (const search of weatherSearches) {
    for (const status of statuses) {
      console.log(`  catalog weather "${search}" ${status}…`);
      const page = await listPredictMarkets(opts.client, {
        status,
        search,
        sort: "created",
        maxPages: 8,
        createdAfterMs: opts.fromMs - 3 * 86_400_000,
        createdBeforeMs: opts.toMs,
      });
      const weatherOnly = page.filter(
        (m) =>
          /highest\s+temp/i.test(m.title) ||
          /temperature\s+in\s+/i.test(m.title) ||
          /\d+\s*°\s*[CF]\b/i.test(m.title),
      );
      console.log(`    → ${page.length} hits, ${weatherOnly.length} weather`);
      markets.push(...weatherOnly);
    }
  }

  // Dedupe by market_id
  const byId = new Map<number, PredictMarket>();
  for (const m of markets) byId.set(m.marketId, m);
  const unique = [...byId.values()];
  const rawGroups = groupPredictEvents(unique);
  // Football prop slugs collapse to one parent fixture (downloadGroup expands props).
  const seenFootball = new Set<string>();
  const groups = rawGroups.filter((g) => {
    const slug = g.eventSlug ?? "";
    if (!slug || !isPfFootballSlug(slug)) return true;
    const base = pfFootballBaseSlug(slug);
    if (seenFootball.has(base)) return false;
    seenFootball.add(base);
    return true;
  });
  const capped = opts.eventLimit != null ? groups.slice(0, opts.eventLimit) : groups;
  console.log(`  events=${capped.length} markets=${unique.length} (football fixtures=${seenFootball.size})`);

  let downloaded = 0;
  let skipped = 0;
  let errors = 0;
  await mapPool(capped, opts.concurrency, async (group) => {
    try {
      const result = await downloadGroup(opts, hub, group);
      if (result === "skipped") skipped++;
      else downloaded++;
      if ((downloaded + skipped) % 10 === 0) {
        console.log(`  … progress downloaded=${downloaded} skipped=${skipped} errors=${errors}`);
      }
    } catch (e) {
      errors++;
      console.error(`  error ${group.eventId}: ${e instanceof Error ? e.message : e}`);
    }
  });

  hub.close();
  console.log(`  done predictfun: downloaded=${downloaded} skipped=${skipped} errors=${errors}`);
  console.log(`Shards: data/predictfun/{YYYY-MM}.db`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


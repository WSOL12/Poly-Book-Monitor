/**
 * Predexon Predict.Fun markets + orderbook history.
 * Docs:
 *   https://docs.predexon.com/api-reference/predictfun/markets
 *   https://docs.predexon.com/api-reference/predictfun/orderbooks
 *
 * Orderbooks are YES-side only. Data from 2026-03-11. Free & unlimited.
 */
import { asNumber, asRecord, asString, predexonGet, type PredexonClientOptions } from "./client.ts";
import type { BookLevel } from "../types/monitoring.ts";

export type PredictOutcome = {
  label: string;
  tokenId: string;
  bestBid: number | null;
  bestAsk: number | null;
};

export type PredictMarket = {
  marketId: number;
  conditionId: string;
  title: string;
  description: string;
  status: string;
  marketVariant: string;
  eventSlug: string | null;
  outcomes: PredictOutcome[];
  bestBid: number | null;
  bestAsk: number | null;
  bidDepth: number;
  askDepth: number;
  createdTime: string | null;
  updatedTime: string | null;
};

export type PredictOrderbookSnap = {
  ts: number;
  bids: BookLevel[];
  asks: BookLevel[];
  bestBid: number | null;
  bestAsk: number | null;
};

function parseLevels(value: unknown): BookLevel[] {
  if (!Array.isArray(value)) return [];
  const out: BookLevel[] = [];
  for (const item of value) {
    const row = asRecord(item);
    const price = asNumber(row?.price);
    const size = asNumber(row?.size);
    if (price == null || size == null || size <= 0) continue;
    out.push({ price, size });
  }
  return out;
}

function parseMarket(raw: unknown): PredictMarket | null {
  const row = asRecord(raw);
  if (!row) return null;
  const marketId = asNumber(row.market_id);
  const title = asString(row.title);
  if (marketId == null || !title) return null;
  const outcomesRaw = Array.isArray(row.outcomes) ? row.outcomes : [];
  const outcomes: PredictOutcome[] = [];
  for (const o of outcomesRaw) {
    const oc = asRecord(o);
    if (!oc) continue;
    const label = asString(oc.label);
    if (!label) continue;
    outcomes.push({
      label,
      tokenId: asString(oc.token_id) ?? "",
      bestBid: asNumber(oc.best_bid),
      bestAsk: asNumber(oc.best_ask),
    });
  }
  return {
    marketId,
    conditionId: asString(row.condition_id) ?? "",
    title,
    description: asString(row.description) ?? "",
    status: asString(row.status) ?? "open",
    marketVariant: asString(row.market_variant) ?? "",
    eventSlug: asString(row.event_slug),
    outcomes,
    bestBid: asNumber(row.best_bid),
    bestAsk: asNumber(row.best_ask),
    bidDepth: asNumber(row.bid_depth) ?? 0,
    askDepth: asNumber(row.ask_depth) ?? 0,
    createdTime: asString(row.created_time),
    updatedTime: asString(row.updated_time),
  };
}

export type ListPredictMarketsOpts = {
  status?: "open" | "closed";
  marketVariant?: "DEFAULT" | "CRYPTO_UP_DOWN" | "SPORTS_TEAM_MATCH" | "SPORTS_MATCH" | "TWEET_COUNT";
  search?: string;
  eventSlug?: string;
  sort?: "created" | "created_asc" | "price_desc" | "price_asc" | "bid_depth";
  limit?: number;
  maxPages?: number;
  /** When sort=created (newest first), drop older rows and stop paging past this time. */
  createdAfterMs?: number;
  createdBeforeMs?: number;
};

/** Paginated list of Predict.Fun markets. */
export async function listPredictMarkets(
  client: PredexonClientOptions,
  opts: ListPredictMarketsOpts = {},
): Promise<PredictMarket[]> {
  const out: PredictMarket[] = [];
  let paginationKey: string | null = null;
  const maxPages = opts.maxPages ?? 50;
  for (let page = 0; page < maxPages; page++) {
    const q = new URLSearchParams({
      limit: String(Math.min(100, opts.limit ?? 100)),
      sort: opts.sort ?? "created",
    });
    if (opts.status) q.set("status", opts.status);
    if (opts.marketVariant) q.set("market_variant", opts.marketVariant);
    if (opts.search) q.set("search", opts.search);
    if (opts.eventSlug) q.set("event_slug", opts.eventSlug);
    if (paginationKey) q.set("pagination_key", paginationKey);

    const body = asRecord(await predexonGet(client, `/v2/predictfun/markets?${q}`, "pf-markets"));
    const markets = Array.isArray(body?.markets) ? body.markets : [];
    const parsedPage: PredictMarket[] = [];
    for (const m of markets) {
      const parsed = parseMarket(m);
      if (parsed) parsedPage.push(parsed);
    }

    const sort = opts.sort ?? "created";
    if (sort === "created" && opts.createdAfterMs != null && parsedPage.length) {
      const newestOnPage = Math.max(
        ...parsedPage.map((m) => (m.createdTime ? Date.parse(m.createdTime) : 0)),
      );
      // Entire page older than the window — further pages are older still.
      if (Number.isFinite(newestOnPage) && newestOnPage > 0 && newestOnPage < opts.createdAfterMs) {
        break;
      }
    }

    for (const parsed of parsedPage) {
      const created = parsed.createdTime ? Date.parse(parsed.createdTime) : NaN;
      if (Number.isFinite(created)) {
        if (opts.createdAfterMs != null && created < opts.createdAfterMs) continue;
        if (opts.createdBeforeMs != null && created > opts.createdBeforeMs) continue;
      }
      out.push(parsed);
    }

    const pagination = asRecord(body?.pagination);
    if (pagination?.has_more !== true) break;
    paginationKey = typeof pagination.pagination_key === "string" ? pagination.pagination_key : null;
    if (!paginationKey) break;
    if (opts.limit != null && out.length >= opts.limit) break;
  }
  return opts.limit != null ? out.slice(0, opts.limit) : out;
}

/** YES-side L2 history for one Predict.Fun market_id. */
export async function fetchPredictOrderbooks(
  client: PredexonClientOptions,
  marketId: number,
  startMs: number,
  endMs: number,
): Promise<PredictOrderbookSnap[]> {
  if (endMs <= startMs) return [];
  const rows: PredictOrderbookSnap[] = [];
  let paginationKey: string | null = null;
  for (;;) {
    const q = new URLSearchParams({
      market_id: String(marketId),
      start_time: String(startMs),
      end_time: String(endMs),
      limit: "200",
    });
    if (paginationKey) q.set("pagination_key", paginationKey);
    const body = asRecord(
      await predexonGet(client, `/v2/predictfun/orderbooks?${q}`, "pf-orderbooks"),
    );
    const snapshots = Array.isArray(body?.snapshots) ? body.snapshots : [];
    for (const item of snapshots) {
      const snap = asRecord(item);
      if (!snap) continue;
      const ts = asNumber(snap.timestamp);
      if (ts == null) continue;
      rows.push({
        ts,
        bids: parseLevels(snap.bids),
        asks: parseLevels(snap.asks),
        bestBid: asNumber(snap.best_bid),
        bestAsk: asNumber(snap.best_ask),
      });
    }
    const pagination = asRecord(body?.pagination);
    if (pagination?.has_more !== true) break;
    paginationKey = typeof pagination.pagination_key === "string" ? pagination.pagination_key : null;
    if (!paginationKey) break;
  }
  rows.sort((a, b) => a.ts - b.ts);
  return rows;
}

/** Humanize predict.fun event_slug → display title when market titles are prop-only. */
export function titleFromEventSlug(slug: string | null | undefined): string | null {
  if (!slug?.trim()) return null;
  const s = slug.trim();
  // e.g. china-open-alexander-bublik-vs-jakub-mensik
  const vs = s.split(/-vs-/i);
  if (vs.length === 2) {
    const left = vs[0]!.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim();
    const right = vs[1]!.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim();
    // Try to peel tournament prefix before last two name tokens — keep full left as-is if unsure
    return `${left} vs ${right}`;
  }
  return s.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim() || null;
}

function isPropOnlyTitle(title: string): boolean {
  const t = title.trim();
  if (!t) return true;
  if (/^(map|game|set)\s*\d+/i.test(t)) return true;
  if (/^(map|game|set)\s+\d+\s+winner$/i.test(t)) return true;
  if (/^(map|game)\s+handicap\b/i.test(t)) return true;
  if (/^(total|spread|handicap|o\/u|over\/under)/i.test(t)) return true;
  // Generic outcome labels used as event titles
  if (/^(match winner|moneyline|draw|winner|yes|no)$/i.test(t)) return true;
  // Country/league codes mistakenly used as titles
  if (/^[A-Z]{2,4}$/.test(t)) return true;
  return false;
}

function isMatchLikeTitle(title: string): boolean {
  return /\bvs\.?\b/i.test(title) && !isPropOnlyTitle(title);
}

function isWeatherTitle(title: string): boolean {
  return /highest\s+temp/i.test(title) || /temperature\s+in\s+/i.test(title);
}

function scoreMatchTitle(title: string): number {
  let s = 0;
  if (/^[^:]+:\s*.+\s+vs\.?\s+/i.test(title)) s += 40; // "China Open: A vs B"
  if (/\bvs\.?\b/i.test(title) && !/handicap|spread|o\/u|total|map\s|game\s+\d/i.test(title)) s += 30;
  if (/moneyline|match winner/i.test(title) && /\bvs\.?\b/i.test(title)) s += 20;
  if (/handicap|spread|map handicap|game handicap/i.test(title)) s -= 25;
  if (title.length > 24) s += 5;
  return s;
}

/** Pick best display title for a group of markets under one event_slug. */
export function pickPredictEventTitle(
  markets: Array<{ title: string }>,
  eventSlug: string | null,
): string {
  // Weather parent: "Highest temperature in Tokyo on October 2?" (no ° bucket in title)
  const weatherNoBucket = markets.filter(
    (m) => isWeatherTitle(m.title) && !/\b\d+\s*°/i.test(m.title),
  );
  if (weatherNoBucket.length) {
    weatherNoBucket.sort((a, b) => b.title.length - a.title.length);
    return weatherNoBucket[0]!.title;
  }
  const weatherAny = markets.filter((m) => isWeatherTitle(m.title));
  if (weatherAny.length) {
    const t = weatherAny[0]!.title;
    const stripped = t.replace(/\s+be\s+.+$/i, "?").replace(/\?\?+/, "?");
    if (/highest\s+temp/i.test(stripped) && stripped.length > 20) return stripped;
    return t;
  }

  const withVs = markets.filter((m) => isMatchLikeTitle(m.title));
  if (withVs.length) {
    withVs.sort((a, b) => scoreMatchTitle(b.title) - scoreMatchTitle(a.title));
    return withVs[0]!.title;
  }
  const fromSlug = titleFromEventSlug(eventSlug);
  if (fromSlug && /\bvs\b/i.test(fromSlug)) return fromSlug;
  const nonProp = markets
    .filter((m) => !isPropOnlyTitle(m.title))
    .sort((a, b) => b.title.length - a.title.length);
  if (nonProp[0]) return nonProp[0].title;
  return fromSlug ?? markets[0]?.title ?? "Predict.fun event";
}

/** Group markets that share an event_slug (one match / event). */
export function groupPredictEvents(markets: PredictMarket[]): Array<{
  eventId: string;
  eventSlug: string | null;
  title: string;
  status: string;
  variant: string;
  markets: PredictMarket[];
  createdTime: string | null;
}> {
  const bySlug = new Map<string, PredictMarket[]>();
  for (const m of markets) {
    const key = m.eventSlug?.trim() || `solo:${m.marketId}`;
    const list = bySlug.get(key) ?? [];
    list.push(m);
    bySlug.set(key, list);
  }
  const out: Array<{
    eventId: string;
    eventSlug: string | null;
    title: string;
    status: string;
    variant: string;
    markets: PredictMarket[];
    createdTime: string | null;
  }> = [];
  for (const [key, list] of bySlug) {
    const eventSlug = key.startsWith("solo:") ? null : key;
    const primary =
      list.find((m) => isMatchLikeTitle(m.title)) ??
      list.find((m) => isWeatherTitle(m.title)) ??
      list.slice().sort((a, b) => a.marketId - b.marketId)[0]!;
    const title = pickPredictEventTitle(list, eventSlug);
    // Skip garbage solo props that can never twin with Polymarket matches
    if (!eventSlug && !isMatchLikeTitle(title) && !isWeatherTitle(title)) continue;
    out.push({
      eventId: eventSlug ? `pf:${eventSlug}` : `pf:m:${primary.marketId}`,
      eventSlug,
      title,
      status: list.every((m) => m.status === "closed") ? "closed" : "open",
      variant: primary.marketVariant,
      markets: list,
      createdTime: primary.createdTime,
    });
  }
  return out;
}

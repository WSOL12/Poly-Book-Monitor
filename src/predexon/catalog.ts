/**
 * Predexon Polymarket event / market catalog.
 * Docs: https://docs.predexon.com/api-reference/markets/events
 *       https://docs.predexon.com/api-reference/markets/list-markets
 */
import type { GammaEvent, GammaMarket } from "../catalog/gamma.ts";
import type { MonitorSport } from "../types/monitoring.ts";
import {
  asNumber,
  asRecord,
  asString,
  predexonGet,
  type PredexonClientOptions,
} from "./client.ts";

/** Tags used to find events (same sport coverage as the old Gamma monitor). */
export const SPORT_TAGS: Record<MonitorSport, string[]> = {
  soccer: ["soccer"],
  football: ["nfl"],
  mlb: ["mlb"],
  weather: ["highest-temperature"],
  tennis: ["tennis"],
};

export type ListEventsOpts = {
  sport: MonitorSport;
  /** open | closed | both */
  status: "open" | "closed" | "both";
  /** Soft time filter on event end/start (ISO ms window). */
  fromMs: number;
  toMs: number;
  limit?: number | null;
};

function appendArrayParam(q: URLSearchParams, key: string, values: string[]) {
  for (const v of values) q.append(key, v);
}

function paginationHasMore(body: Record<string, unknown> | null): string | null {
  const pagination = asRecord(body?.pagination);
  if (pagination?.has_more !== true) return null;
  return typeof pagination.pagination_key === "string" ? pagination.pagination_key : null;
}

function outcomeToGamma(outcome: Record<string, unknown>): { label: string; tokenId: string; price: number | null } {
  return {
    label: asString(outcome.label) ?? "",
    tokenId: asString(outcome.token_id) ?? "",
    price: asNumber(outcome.price),
  };
}

function marketToGamma(row: Record<string, unknown>): GammaMarket {
  const outcomes = Array.isArray(row.outcomes)
    ? row.outcomes.map((o) => asRecord(o)).filter((o): o is Record<string, unknown> => o != null).map(outcomeToGamma)
    : [];
  const names = outcomes.map((o) => o.label);
  const tokenIds = outcomes.map((o) => o.tokenId);
  const prices = outcomes.map((o) => (o.price != null ? String(o.price) : "0"));
  const status = (asString(row.status) ?? "").toLowerCase();
  return {
    id: asString(row.market_id) ?? asString(row.condition_id) ?? undefined,
    question: asString(row.title) ?? "",
    slug: asString(row.market_slug) ?? undefined,
    outcomes: JSON.stringify(names),
    clobTokenIds: JSON.stringify(tokenIds),
    outcomePrices: JSON.stringify(prices),
    closed: status === "closed" || status === "resolved",
    active: status === "open" || status === "active",
    closedTime: asString(row.close_time) ?? asString(row.end_time) ?? undefined,
  };
}

function eventToGamma(row: Record<string, unknown>): GammaEvent {
  const status = (asString(row.status) ?? "").toLowerCase();
  const closed = status === "closed" || status === "resolved";
  const tagsRaw = Array.isArray(row.tags) ? row.tags : [];
  const tags = tagsRaw
    .map((t) => {
      if (typeof t === "string") return { slug: t, label: t };
      const rec = asRecord(t);
      if (!rec) return null;
      return {
        slug: asString(rec.slug) ?? asString(rec.label) ?? "",
        label: asString(rec.label) ?? asString(rec.slug) ?? "",
      };
    })
    .filter((t): t is { slug: string; label: string } => t != null && Boolean(t.slug || t.label));

  const seriesRaw = Array.isArray(row.series) ? row.series : [];
  const series = seriesRaw
    .map((s) => asRecord(s))
    .filter((s): s is Record<string, unknown> => s != null)
    .map((s) => ({
      title: asString(s.title),
      slug: asString(s.slug),
    }));

  const marketsNested = Array.isArray(row.markets)
    ? row.markets.map((m) => asRecord(m)).filter((m): m is Record<string, unknown> => m != null).map(marketToGamma)
    : [];

  const start = asString(row.start_date);
  const end = asString(row.end_date);
  const closedTime = asString(row.closed_time);

  return {
    id: asString(row.id) ?? "",
    title: asString(row.title) ?? "",
    slug: asString(row.slug) ?? "",
    closed,
    active: !closed,
    live: !closed,
    ended: closed,
    startTime: start ?? undefined,
    endDate: end ?? undefined,
    eventDate: start ? start.slice(0, 10) : end ? end.slice(0, 10) : undefined,
    finishedTimestamp: closedTime,
    seriesSlug: series[0]?.slug ?? null,
    series,
    tags,
    markets: marketsNested,
  };
}

function eventInWindow(event: GammaEvent, fromMs: number, toMs: number): boolean {
  const candidates = [event.startTime, event.endDate, event.finishedTimestamp, event.eventDate]
    .map((v) => (v ? Date.parse(v.length === 10 ? `${v}T12:00:00Z` : v) : NaN))
    .filter((n) => Number.isFinite(n));
  if (!candidates.length) return true;
  const t = Math.min(...candidates);
  return t >= fromMs && t <= toMs;
}

/** List events for a sport via Predexon keyset pagination. */
export async function listSportEvents(
  client: PredexonClientOptions,
  opts: ListEventsOpts,
): Promise<GammaEvent[]> {
  const tags = SPORT_TAGS[opts.sport];
  const statuses: Array<"open" | "closed"> =
    opts.status === "both" ? ["closed", "open"] : [opts.status];

  const out: GammaEvent[] = [];
  const seen = new Set<string>();

  for (const status of statuses) {
    let paginationKey: string | null = null;
    for (;;) {
      const q = new URLSearchParams({
        status,
        sort: status === "closed" ? "end_date_desc" : "start_date",
        limit: "100",
        include_markets: "true",
        markets_per_event: "50",
      });
      appendArrayParam(q, "tag", tags);
      if (paginationKey) q.set("pagination_key", paginationKey);

      const body = asRecord(await predexonGet(client, `/v2/polymarket/events/keyset?${q}`, "events"));
      const events = Array.isArray(body?.events) ? body.events : [];
      let added = 0;
      for (const item of events) {
        const row = asRecord(item);
        if (!row) continue;
        const event = eventToGamma(row);
        if (!event.id || seen.has(event.id)) continue;
        if (!eventInWindow(event, opts.fromMs, opts.toMs)) continue;
        seen.add(event.id);
        out.push(event);
        added++;
        if (opts.limit != null && out.length >= opts.limit) return out;
      }

      paginationKey = paginationHasMore(body);
      if (!paginationKey || events.length === 0) break;
      // Closed+end_date_desc: stop when page falls entirely before fromMs
      if (status === "closed" && events.length > 0 && added === 0) {
        const oldest = events
          .map((e) => asRecord(e))
          .map((e) => Date.parse(asString(e?.end_date) ?? asString(e?.start_date) ?? ""))
          .filter((n) => Number.isFinite(n));
        if (oldest.length && Math.max(...oldest) < opts.fromMs) break;
      }
    }
  }

  return out;
}

/** Deep-fetch all markets for an event (when nested markets_per_event was truncated). */
export async function listMarketsForEventSlug(
  client: PredexonClientOptions,
  eventSlug: string,
): Promise<GammaMarket[]> {
  const out: GammaMarket[] = [];
  let paginationKey: string | null = null;
  for (;;) {
    const q = new URLSearchParams({
      event_slug: eventSlug,
      limit: "100",
      sort: "volume_all_time",
    });
    if (paginationKey) q.set("pagination_key", paginationKey);
    const body = asRecord(await predexonGet(client, `/v2/polymarket/markets/keyset?${q}`, "markets"));
    const markets = Array.isArray(body?.markets) ? body.markets : [];
    for (const item of markets) {
      const row = asRecord(item);
      if (!row) continue;
      out.push(marketToGamma(row));
    }
    paginationKey = paginationHasMore(body);
    if (!paginationKey || markets.length === 0) break;
  }
  return out;
}

/** Ensure event.markets is complete (refetch when market_count > nested length). */
export async function hydrateEventMarkets(
  client: PredexonClientOptions,
  event: GammaEvent,
  marketCountHint?: number,
): Promise<GammaEvent> {
  const nested = event.markets?.length ?? 0;
  const hint = marketCountHint ?? nested;
  if (!event.slug) return event;
  if (hint <= nested && nested > 0) return event;
  const markets = await listMarketsForEventSlug(client, event.slug);
  if (!markets.length) return event;
  return { ...event, markets };
}

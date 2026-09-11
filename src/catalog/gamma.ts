import { polyFetch } from "../utils/polyNet.ts";
import type { MonitorSport } from "../types/monitoring.ts";

const GAMMA = "https://gamma-api.polymarket.com";

export type GammaMarket = {
  id?: string;
  question?: string;
  slug?: string;
  outcomes?: string;
  clobTokenIds?: string;
  outcomePrices?: string;
  closed?: boolean;
  active?: boolean;
  sportsMarketType?: string;
  closedTime?: string;
  umaEndDate?: string;
};

export type GammaEvent = {
  id: string;
  title: string;
  slug: string;
  closed?: boolean;
  active?: boolean;
  live?: boolean;
  ended?: boolean;
  gameStatus?: string | null;
  endDate?: string;
  updatedAt?: string;
  startTime?: string;
  eventDate?: string;
  score?: string | null;
  period?: string | null;
  elapsed?: string | null;
  finishedTimestamp?: string | null;
  markets?: GammaMarket[];
};

export function isLiveEvent(event: GammaEvent) {
  if (event.closed) return false;
  if (event.ended === true) return false;
  if (event.live === false) return false;
  if (isFinalPeriod(event.period)) return false;
  return true;
}

export function isFinalPeriod(period?: string | null) {
  const p = period?.trim().toUpperCase() ?? "";
  return p === "VFT" || p === "FT" || p === "FINAL" || p === "F";
}

export function isFinishedGammaEvent(
  event: Pick<GammaEvent, "ended" | "closed" | "live" | "period">,
  opts?: { sport?: string }
) {
  if (event.ended === true || event.closed === true) return true;
  if (isFinalPeriod(event.period)) return true;
  // Weather stays open for the day; Gamma often has live=false the whole time.
  if (opts?.sport === "weather") return false;
  if (event.live === false) return true;
  return false;
}

export function polyStatusFromEvent(event: GammaEvent) {
  const finished = isFinishedGammaEvent(event);
  return {
    ended: event.ended === true || isFinalPeriod(event.period) || event.live === false,
    polyLive: event.live === true && !finished,
    closed: event.closed === true,
    gameStatus: event.gameStatus?.trim() || event.period?.trim() || null,
    finishedAt: finished ? finishedAtFromGamma(event) : null,
  };
}

function parseGammaTime(raw?: string | null) {
  if (!raw) return null;
  const normalized = raw.includes("T") ? raw : raw.replace(" ", "T").replace(/\+00$/, "Z");
  const t = Date.parse(normalized);
  return Number.isFinite(t) ? t : null;
}

/** Stable end time from Polymarket — prefer finishedTimestamp over market endDate. */
export function finishedAtFromGamma(
  event: Pick<
    GammaEvent,
    "ended" | "closed" | "live" | "period" | "updatedAt" | "endDate" | "finishedTimestamp" | "markets"
  >
) {
  if (!isFinishedGammaEvent(event)) return null;
  const finishedTs = parseGammaTime(event.finishedTimestamp);
  if (finishedTs != null) return finishedTs;
  const times: number[] = [];
  const push = (raw?: string | null) => {
    const t = parseGammaTime(raw);
    if (t != null) times.push(t);
  };
  push(event.updatedAt);
  for (const market of event.markets ?? []) {
    push(market.closedTime);
  }
  // endDate / umaEndDate are often settlement windows, not whistle time
  if (!times.length) {
    push(event.endDate);
    for (const market of event.markets ?? []) push(market.umaEndDate);
  }
  return times.length ? Math.min(...times) : Date.now();
}

/** Gamma silently truncates large `id=` batches; keep chunks small and retry misses. */
const EVENTS_BY_ID_CHUNK = 20;

async function fetchEventsByIdChunk(chunk: string[]): Promise<GammaEvent[]> {
  if (!chunk.length) return [];
  const qs = chunk.map((id) => `id=${encodeURIComponent(id)}`).join("&");
  const url = `${GAMMA}/events?${qs}`;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await polyFetch(url);
      if (!res.ok) throw new Error(`Gamma HTTP ${res.status}`);
      return (await res.json()) as GammaEvent[];
    } catch (err) {
      lastErr = err;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 2_000 * (attempt + 1)));
    }
  }
  throw lastErr;
}

export async function fetchEventsByIds(ids: string[]): Promise<GammaEvent[]> {
  const unique = [...new Set(ids.filter(Boolean).map(String))];
  if (!unique.length) return [];
  const out = new Map<string, GammaEvent>();
  for (let i = 0; i < unique.length; i += EVENTS_BY_ID_CHUNK) {
    const chunk = unique.slice(i, i + EVENTS_BY_ID_CHUNK);
    const page = await fetchEventsByIdChunk(chunk);
    for (const event of page) out.set(String(event.id), event);
  }
  const missing = unique.filter((id) => !out.has(id));
  for (const id of missing) {
    const page = await fetchEventsByIdChunk([id]);
    for (const event of page) out.set(String(event.id), event);
  }
  return [...out.values()];
}

export function parseJsonField<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value !== "string") return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function eventSchedule(event: GammaEvent) {
  const startTime = event.startTime?.trim() || null;
  const fromField = event.eventDate?.trim() || null;
  const fromSlug = /(\d{4}-\d{2}-\d{2})(?:$|[^0-9])/.exec(event.slug ?? "")?.[1] ?? null;
  const eventDate = fromField || (startTime ? startTime.slice(0, 10) : null) || fromSlug;
  return { startTime, eventDate };
}

async function fetchTagPages(
  tag: string,
  opts: { liveOnly: boolean; maxOffset: number }
): Promise<GammaEvent[]> {
  const out: GammaEvent[] = [];
  for (let offset = 0; ; offset += 50) {
    const liveQ = opts.liveOnly ? "&live=true" : "";
    const url = `${GAMMA}/events?closed=false&active=true${liveQ}&limit=50&offset=${offset}&tag_slug=${encodeURIComponent(tag)}&order=endDate&ascending=true`;
    let page: GammaEvent[] | null = null;
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await polyFetch(url, 20_000);
        if (!res.ok) throw new Error(`Gamma HTTP ${res.status}`);
        page = (await res.json()) as GammaEvent[];
        break;
      } catch (err) {
        lastErr = err;
        if (attempt < 1) await new Promise((r) => setTimeout(r, 1_000));
      }
    }
    if (!page) throw lastErr;
    out.push(...page);
    if (page.length < 50) break;
    if (offset >= opts.maxOffset) break;
  }
  return out;
}

export async function fetchEventsByTags(tags: string[]): Promise<GammaEvent[]> {
  const byId = new Map<string, GammaEvent>();
  const results = await Promise.allSettled(
    tags.map((tag) => fetchTagPages(tag, { liveOnly: true, maxOffset: 200 }))
  );
  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    for (const event of result.value) {
      if (isLiveEvent(event)) byId.set(String(event.id), event);
    }
  }
  if (!byId.size && results.every((r) => r.status === "rejected")) {
    const first = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    throw first.reason;
  }
  return [...byId.values()];
}

/** Open (not necessarily live) events — used for daily weather markets. */
export async function fetchOpenEventsByTags(tags: string[]): Promise<GammaEvent[]> {
  const byId = new Map<string, GammaEvent>();
  const results = await Promise.allSettled(
    tags.map((tag) => fetchTagPages(tag, { liveOnly: false, maxOffset: 800 }))
  );
  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    for (const event of result.value) {
      if (!event.closed && event.ended !== true) byId.set(String(event.id), event);
    }
  }
  if (!byId.size && results.every((r) => r.status === "rejected")) {
    const first = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    throw first.reason;
  }
  return [...byId.values()];
}

export const SPORT_TAGS: Record<MonitorSport, string[]> = {
  soccer: [
    "soccer",
    "epl",
    "premier-league",
    "la-liga",
    "bundesliga",
    "serie-a",
    "ligue-1",
    "mls",
    "ucl",
    "liga-mx",
    "j-league",
    "japan-j-league",
    "japan-j1-league",
    "japan-j2-league",
  ],
  football: ["nfl", "ncaa-football", "football"],
  mlb: ["mlb", "baseball", "npb", "kbo"],
  weather: ["highest-temperature"],
};

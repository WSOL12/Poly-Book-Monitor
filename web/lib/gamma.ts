const GAMMA = "https://gamma-api.polymarket.com";

export type GammaTeam = {
  name: string;
  alias?: string | null;
  logo?: string | null;
  abbreviation?: string | null;
  ordering?: string | null;
};

export type GammaSportsEvent = {
  id: string;
  title: string;
  slug: string;
  score?: string | null;
  period?: string | null;
  elapsed?: string | null;
  live?: boolean;
  ended?: boolean;
  closed?: boolean;
  gameStatus?: string | null;
  startTime?: string | null;
  finishedTimestamp?: string | null;
  teams?: GammaTeam[];
  sport?: { ordering?: string | null; name?: string | null } | null;
};

export type GammaMarketStatus = {
  id?: string;
  slug?: string;
  question?: string;
  sportsMarketType?: string | null;
  volume?: string | number | null;
  volumeNum?: number | null;
  closed?: boolean;
  closedTime?: string;
  umaEndDate?: string;
};

export type GammaEventStatus = {
  id: string;
  slug?: string;
  ended?: boolean;
  live?: boolean;
  closed?: boolean;
  gameStatus?: string | null;
  updatedAt?: string;
  endDate?: string;
  finishedTimestamp?: string | null;
  score?: string | null;
  period?: string | null;
  elapsed?: string | null;
  volume?: number | null;
  seriesSlug?: string | null;
  series?: Array<{ title?: string | null; slug?: string | null }> | null;
  tags?: Array<{ label?: string | null; slug?: string | null }> | null;
  markets?: GammaMarketStatus[];
};

function parseGammaTime(raw?: string | null) {
  if (!raw) return null;
  const normalized = raw.includes("T") ? raw : raw.replace(" ", "T").replace(/\+00$/, "Z");
  const t = Date.parse(normalized);
  return Number.isFinite(t) ? t : null;
}

export function isFinalPeriod(period?: string | null) {
  const p = period?.trim().toUpperCase() ?? "";
  return p === "VFT" || p === "FT" || p === "FINAL" || p === "F";
}

export function isFinishedGammaEvent(
  event: Pick<GammaEventStatus, "ended" | "closed" | "live" | "period">,
  opts?: { sport?: string }
) {
  if (event.ended === true || event.closed === true) return true;
  if (isFinalPeriod(event.period)) return true;
  if (opts?.sport === "weather") return false;
  if (event.live === false) return true;
  return false;
}

export function finishedAtFromGamma(
  event: Pick<
    GammaEventStatus,
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
  if (!times.length) {
    push(event.endDate);
    for (const market of event.markets ?? []) push(market.umaEndDate);
  }
  return times.length ? Math.min(...times) : Date.now();
}

export async function fetchEventBySlug(slug: string): Promise<GammaSportsEvent | null> {
  if (!slug) return null;
  const res = await fetch(`${GAMMA}/events/slug/${encodeURIComponent(slug)}`, { next: { revalidate: 0 } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Gamma HTTP ${res.status}`);
  return (await res.json()) as GammaSportsEvent;
}

const EVENTS_BY_ID_CHUNK = 20;

async function fetchEventsByIdChunk(chunk: string[]): Promise<GammaEventStatus[]> {
  if (!chunk.length) return [];
  const qs = chunk.map((id) => `id=${encodeURIComponent(id)}`).join("&");
  const res = await fetch(`${GAMMA}/events?${qs}`, { next: { revalidate: 0 } });
  if (!res.ok) throw new Error(`Gamma HTTP ${res.status}`);
  return (await res.json()) as GammaEventStatus[];
}

export async function fetchEventsByIds(ids: string[]): Promise<GammaEventStatus[]> {
  const unique = [...new Set(ids.filter(Boolean).map(String))];
  if (!unique.length) return [];
  const out = new Map<string, GammaEventStatus>();
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

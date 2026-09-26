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
  outcomes?: string | string[] | null;
  outcomePrices?: string | Array<string | number> | null;
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
  event: Pick<GammaEventStatus, "ended" | "closed" | "live" | "period" | "gameStatus" | "score" | "markets">,
  opts?: { sport?: string }
) {
  if (event.ended === true || event.closed === true) return true;
  if (isFinalPeriod(event.period)) return true;
  if (opts?.sport === "weather") return false;
  if (opts?.sport === "tennis") return tennisStopReason(event) != null;
  if (event.live === false) return true;
  return false;
}

export type TennisStopReason = "started" | "canceled" | "retired";

function parseJsonField<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value !== "string") return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function marketPrices(market: GammaMarketStatus): [number, number] | null {
  const prices = parseJsonField<Array<string | number>>(market.outcomePrices, []);
  if (prices.length < 2) return null;
  const a = Number(prices[0]);
  const b = Number(prices[1]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return [a, b];
}

function priceIsYes(a: number, b: number) {
  return a >= 0.95 && b <= 0.05;
}

function priceIsNo(a: number, b: number) {
  return a <= 0.05 && b >= 0.95;
}

function priceIsFiftyFifty(a: number, b: number) {
  return Math.abs(a - 0.5) <= 0.03 && Math.abs(b - 0.5) <= 0.03;
}

/**
 * Polymarket tennis_completed_match: Yes = finished normally, No = cancel/retire.
 * Retirements still pay the moneyline winner — do NOT use set props @50¢ for this.
 */
function tennisCompletedMatchOutcome(
  event: Pick<GammaEventStatus, "markets">
): "yes" | "no" | "void" | null {
  for (const market of event.markets ?? []) {
    const type = (market.sportsMarketType ?? "").toLowerCase();
    if (type !== "tennis_completed_match" && !/completed match/i.test(market.question ?? "")) {
      continue;
    }
    const prices = marketPrices(market);
    if (!prices) continue;
    const [a, b] = prices;
    if (priceIsYes(a, b)) return "yes";
    if (priceIsNo(a, b)) return "no";
    if (priceIsFiftyFifty(a, b)) return "void";
  }
  return null;
}

/** Only the actual moneyline market — never Set Winner / Totals with "vs" in the title. */
function moneylineLooksVoided(event: Pick<GammaEventStatus, "markets">) {
  for (const market of event.markets ?? []) {
    if ((market.sportsMarketType ?? "").toLowerCase() !== "moneyline") continue;
    const prices = marketPrices(market);
    if (!prices) continue;
    if (priceIsFiftyFifty(prices[0], prices[1])) return true;
  }
  return false;
}

/** Moneyline resolved to a winner (retirements pay the advancer; cancels stay ~50/50). */
function moneylineHasWinner(event: Pick<GammaEventStatus, "markets">) {
  for (const market of event.markets ?? []) {
    if ((market.sportsMarketType ?? "").toLowerCase() !== "moneyline") continue;
    const prices = marketPrices(market);
    if (!prices) continue;
    const [a, b] = prices;
    if (priceIsYes(a, b) || priceIsNo(a, b)) return true;
  }
  return false;
}

function tennisSetWinner(homeGames: number, awayGames: number): "home" | "away" | null {
  if (homeGames >= 6 && homeGames - awayGames >= 2) return "home";
  if (awayGames >= 6 && awayGames - homeGames >= 2) return "away";
  if (homeGames === 7 && awayGames === 6) return "home";
  if (awayGames === 7 && homeGames === 6) return "away";
  return null;
}

/** Best-of-3/5 finished normally (someone reached 2+ or 3+ set wins). */
export function tennisScoreIsComplete(score?: string | null) {
  const raw = score?.trim();
  if (!raw) return false;
  if (raw.includes(",")) {
    let homeWins = 0;
    let awayWins = 0;
    for (const part of raw.split(",")) {
      const m = part.trim().match(/^(\d+)\s*-\s*(\d+)/);
      if (!m) return false;
      const winner = tennisSetWinner(Number(m[1]), Number(m[2]));
      if (!winner) return false;
      if (winner === "home") homeWins += 1;
      else awayWins += 1;
    }
    const played = homeWins + awayWins;
    if (played <= 3) return homeWins >= 2 || awayWins >= 2;
    return homeWins >= 3 || awayWins >= 3;
  }
  const simple = raw.match(/^(\d+)\s*-\s*(\d+)$/);
  if (!simple) return false;
  const home = Number(simple[1]);
  const away = Number(simple[2]);
  return (home >= 2 || away >= 2) && home + away <= 5 && Math.abs(home - away) <= 2;
}

function tennisScoreIsBlank(score?: string | null) {
  const s = (score ?? "").replace(/\s+/g, "");
  return !s || s === "0-0" || s === "0-0,0-0";
}

/** Why an open tennis watch stopped. Prefer tennis_completed_match over void heuristics. */
export function tennisStopReason(
  event: Pick<GammaEventStatus, "live" | "ended" | "closed" | "period" | "gameStatus" | "score" | "markets">
): TennisStopReason | null {
  if (event.live === true) return "started";
  const blob = `${event.gameStatus ?? ""} ${event.period ?? ""}`;
  if (/retir/i.test(blob)) return "retired";
  const p = blob.toUpperCase();
  if (/\bCAN\b|CANCEL|ABANDON|WALKOVER|\bWO\b/.test(p)) return "canceled";
  const settling =
    event.ended === true || event.closed === true || isFinalPeriod(event.period);
  if (!settling) return null;

  const completed = tennisCompletedMatchOutcome(event);
  if (completed === "yes" || tennisScoreIsComplete(event.score)) return "started";
  if (completed === "no") {
    // Completed Match = No + moneyline winner → retirement (Gamma often omits score).
    if (moneylineHasWinner(event) || !tennisScoreIsBlank(event.score)) return "retired";
    return "canceled";
  }
  if (moneylineLooksVoided(event) || completed === "void") {
    return tennisScoreIsBlank(event.score) ? "canceled" : "retired";
  }
  return "started";
}

export function finishedAtFromGamma(
  event: Pick<
    GammaEventStatus,
    "ended" | "closed" | "live" | "period" | "updatedAt" | "endDate" | "finishedTimestamp" | "markets"
  >,
  opts?: { sport?: string }
) {
  if (!isFinishedGammaEvent(event, opts)) return null;
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

import type { MonitorSport } from "../types/monitoring.ts";

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
  seriesSlug?: string | null;
  series?: Array<{ title?: string | null; slug?: string | null }> | null;
  tags?: Array<{ label?: string | null; slug?: string | null }> | null;
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
  event: Pick<GammaEvent, "ended" | "closed" | "live" | "period" | "gameStatus" | "score" | "markets">,
  opts?: { sport?: string }
) {
  if (event.ended === true || event.closed === true) return true;
  if (isFinalPeriod(event.period)) return true;
  // Weather stays open for the day; Gamma often has live=false the whole time.
  if (opts?.sport === "weather") return false;
  // Tennis: watch open prematch until started / canceled / retired — live=false is normal.
  if (opts?.sport === "tennis") {
    return tennisStopReason(event) != null;
  }
  if (event.live === false) return true;
  return false;
}

export type TennisStopReason = "started" | "canceled" | "retired";

function tennisSeriesSlug(event: Pick<GammaEvent, "seriesSlug" | "series">) {
  return (
    event.seriesSlug?.trim().toLowerCase() ||
    event.series?.[0]?.slug?.trim().toLowerCase() ||
    ""
  );
}

/** ITF / low-liquidity futures — skip entirely. */
export function isItfTennisEvent(
  event: Pick<GammaEvent, "title" | "slug" | "seriesSlug" | "series" | "tags">
) {
  const series = tennisSeriesSlug(event);
  if (series === "itf") return true;
  if ((event.tags ?? []).some((t) => /itf/i.test(t.slug ?? "") || /itf/i.test(t.label ?? ""))) {
    return true;
  }
  const title = event.title ?? "";
  const slug = event.slug ?? "";
  if (/\bitf\b/i.test(title) || /\bitf\b/i.test(slug)) return true;
  // W15 / M25 style ITF event names when series is missing or wrong.
  if (/\b[WM]\d{2}\b/i.test(title) && !/^(atp|wta)/.test(series)) return true;
  return false;
}

function marketPrices(market: GammaMarket): [number, number] | null {
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
  event: Pick<GammaEvent, "markets">
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
export function tennisMoneylineIsVoided(event: Pick<GammaEvent, "markets">) {
  for (const market of event.markets ?? []) {
    if ((market.sportsMarketType ?? "").toLowerCase() !== "moneyline") continue;
    const prices = marketPrices(market);
    if (!prices) continue;
    if (priceIsFiftyFifty(prices[0], prices[1])) return true;
  }
  return false;
}

function moneylineLooksVoided(event: Pick<GammaEvent, "markets">) {
  return tennisMoneylineIsVoided(event);
}

/** Moneyline resolved to a winner (retirements pay the advancer; cancels stay ~50/50). */
function moneylineHasWinner(event: Pick<GammaEvent, "markets">) {
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
  // Set-wins only (2-0 / 2-1 / 3-1…), not a single unfinished game line.
  return (home >= 2 || away >= 2) && home + away <= 5 && Math.abs(home - away) <= 2;
}

function tennisScoreIsBlank(score?: string | null) {
  const s = (score ?? "").replace(/\s+/g, "");
  return !s || s === "0-0" || s === "0-0,0-0";
}

function isCanceledTennisStatus(period?: string | null, gameStatus?: string | null) {
  const p = `${period ?? ""} ${gameStatus ?? ""}`.trim().toUpperCase();
  if (!p) return false;
  return (
    p === "CAN" ||
    /\bCAN\b/.test(p) ||
    /CANCEL/.test(p) ||
    /ABANDON/.test(p) ||
    /WALKOVER|\bWO\b/.test(p)
  );
}

/**
 * Why we stop watching an open tennis match.
 *
 * Priority:
 * 1) Explicit Gamma period/status (CAN / retir…)
 * 2) tennis_completed_match Yes/No (authoritative on Polymarket)
 * 3) moneyline @50/50 only when that market itself voided (cancel before start)
 * 4) Complete set line → normal finish
 */
export function tennisStopReason(
  event: Pick<
    GammaEvent,
    "live" | "ended" | "closed" | "period" | "gameStatus" | "score" | "markets"
  >
): TennisStopReason | null {
  if (event.live === true) return "started";

  const blob = `${event.gameStatus ?? ""} ${event.period ?? ""}`;
  if (/retir/i.test(blob)) return "retired";
  if (isCanceledTennisStatus(event.period, event.gameStatus)) return "canceled";

  const settling =
    event.ended === true || event.closed === true || isFinalPeriod(event.period);
  if (!settling) return null;

  const completed = tennisCompletedMatchOutcome(event);
  if (completed === "yes" || tennisScoreIsComplete(event.score)) return "started";
  if (completed === "no") {
    // Completed Match = No:
    //   moneyline winner → retirement/default (advancer paid)
    //   moneyline ~50/50 or blank → canceled / walkover before start
    // Gamma often omits the partial score on retirements — don't require it.
    if (moneylineHasWinner(event) || !tennisScoreIsBlank(event.score)) return "retired";
    return "canceled";
  }

  // Fallback when Completed Match market is missing: only trust the moneyline void.
  if (moneylineLooksVoided(event) || completed === "void") {
    return tennisScoreIsBlank(event.score) ? "canceled" : "retired";
  }

  // Settled without void signals — finished (possibly without ever seeing live=true).
  return "started";
}

/** Prematch ATP/WTA (etc.) still worth streaming. */
export function isTennisWatchable(event: GammaEvent) {
  if (event.closed || event.ended === true) return false;
  if (isItfTennisEvent(event)) return false;
  if (tennisStopReason(event) != null) return false;
  return true;
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
    | "ended"
    | "closed"
    | "live"
    | "period"
    | "gameStatus"
    | "score"
    | "updatedAt"
    | "endDate"
    | "finishedTimestamp"
    | "markets"
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
  // endDate / umaEndDate are often settlement windows, not whistle time
  if (!times.length) {
    push(event.endDate);
    for (const market of event.markets ?? []) push(market.umaEndDate);
  }
  return times.length ? Math.min(...times) : Date.now();
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

/** Tag slugs used when listing events via Predexon (see src/predexon/catalog.ts). */
export const SPORT_TAGS: Record<MonitorSport, string[]> = {
  soccer: ["soccer"],
  football: ["nfl"],
  mlb: ["mlb"],
  weather: ["highest-temperature"],
  tennis: ["tennis"],
};

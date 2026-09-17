import { createHash } from "node:crypto";
import {
  eventSchedule,
  parseJsonField,
  isLiveEvent,
  polyStatusFromEvent,
  type GammaEvent,
  type GammaMarket,
} from "./gamma.ts";
import type { MonitoredEvent, MonitoredMarket, MonitoredToken, MonitorSport } from "../types/monitoring.ts";

function marketKey(eventId: string, market: GammaMarket) {
  const slug = market.slug?.trim();
  if (slug) return `${eventId}:${slug}`;
  const q = market.question ?? "";
  const hash = createHash("sha1").update(q).digest("hex").slice(0, 12);
  return `${eventId}:${hash}`;
}

function token(
  args: Omit<MonitoredToken, "tokenId"> & { tokenId: string }
): MonitoredToken | null {
  if (!args.tokenId) return null;
  return args;
}

function ouFromMarket(
  sport: MonitorSport,
  eventId: string,
  market: GammaMarket,
  marketId: string,
  question: string
): MonitoredMarket | null {
  const q = question;
  const ou = q.match(/O\/U\s+([0-9.]+)/i) ?? q.match(/\b(?:over|under)\s+([0-9.]+)/i);
  if (!ou) return null;
  const names = parseJsonField<string[]>(market.outcomes, []);
  const tokens = parseJsonField<string[]>(market.clobTokenIds, []);
  const overIdx = names.findIndex((n) => /over/i.test(n));
  const underIdx = names.findIndex((n) => /under/i.test(n));
  if (overIdx < 0 || underIdx < 0) return null;
  const line = ou[1];
  const rows = [
    token({
      tokenId: tokens[overIdx] ?? "",
      marketId,
      eventId,
      sport,
      marketType: "total",
      side: "over",
      label: `Over ${line}`,
      line,
    }),
    token({
      tokenId: tokens[underIdx] ?? "",
      marketId,
      eventId,
      sport,
      marketType: "total",
      side: "under",
      label: `Under ${line}`,
      line,
    }),
  ].filter((row): row is MonitoredToken => row != null);
  if (rows.length < 2) return null;
  return {
    marketId,
    eventId,
    sport,
    marketType: "total",
    question,
    line,
    tokens: rows,
  };
}

function yesNo(market: GammaMarket) {
  const names = parseJsonField<string[]>(market.outcomes, []);
  const tokens = parseJsonField<string[]>(market.clobTokenIds, []);
  const yesIdx = names.findIndex((n) => /^yes$/i.test(n));
  const noIdx = names.findIndex((n) => /^no$/i.test(n));
  if (yesIdx < 0 || noIdx < 0) return null;
  return { yes: { name: "Yes", tokenId: tokens[yesIdx] ?? "" }, no: { name: "No", tokenId: tokens[noIdx] ?? "" } };
}

function splitSides(title: string): [string, string] | null {
  const parts = title.split(/ vs\.? /i).map((s) => s.trim());
  if (parts.length < 2 || !parts[0] || !parts[1]) return null;
  const away = parts[1]
    .replace(/\s+[-–]\s+(halftime|second half|exact score|more markets|total corners).*$/i, "")
    .trim();
  if (!away) return null;
  return [parts[0], away];
}

function mentionsTeam(q: string, team: string) {
  const ql = q.toLowerCase();
  const t = team.toLowerCase().trim();
  if (!t) return false;
  // Long names: substring is fine ("Sunderland AFC").
  if (t.length >= 4 && ql.includes(t)) return true;
  // Short codes ("AZ", "PSG"): require a token boundary so "AZ" ≠ "Azerbaijan".
  if (t.length >= 2) {
    const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`, "i").test(q)) return true;
  }
  const tok = team.split(/\s+/).filter((p) => p.length >= 3 && !/^(fc|cf|sc|afc|the)$/i.test(p));
  return tok.some((p) => ql.includes(p.toLowerCase()));
}

function sameTeam(a: string, b: string) {
  const na = a.toLowerCase().replace(/[^a-z0-9]/g, "");
  const nb = b.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

function baseMatchKey(title: string) {
  return title
    .replace(/^[a-z0-9]+:\s*/i, "")
    .replace(
      /\s+[-–]\s+(more markets|halftime result|second half result|exact score|first team to score|total corners).*$/i,
      ""
    )
    .trim()
    .toLowerCase();
}

function isMatchTotalMarket(market: GammaMarket) {
  if (!isTotalMarket(market)) return false;
  const q = market.question ?? "";
  const type = (market.sportsMarketType ?? "").toLowerCase();
  if (/half|team|btts|both_teams|spread|corner|card|booking|shot/i.test(type)) return false;
  if (/1st half|2nd half|first half|second half|both teams|team o\/u|team total/i.test(q)) return false;
  if (type === "totals") return true;
  if (/\bcombined for\b|\bcombined points\b/i.test(q)) return true;
  return / vs\.?: O\/U| vs\.? .* O\/U/i.test(q);
}

function parseTotalsForMatch(
  sport: MonitorSport,
  mainEventId: string,
  event: GammaEvent,
  seenMarketIds: Set<string>
): MonitoredMarket[] {
  const out: MonitoredMarket[] = [];
  for (const market of event.markets ?? []) {
    if (market.closed) continue;
    if (!isMatchTotalMarket(market)) continue;
    const marketId = marketKey(mainEventId, market);
    if (seenMarketIds.has(marketId)) continue;
    const question = market.question ?? "";
    const parsed = ouFromMarket(sport, mainEventId, market, marketId, question);
    if (!parsed) continue;
    seenMarketIds.add(parsed.marketId);
    out.push(parsed);
  }
  return out;
}

function isMatchTitle(title: string, sport: MonitorSport) {
  if (!/ vs\.? /i.test(title)) return false;
  if (/\b(total corners?|corners?|cards?|bookings?|shots?|offsides?|penalt(y|ies)|player props?|anytime scorer|first goal scorer)\b/i.test(title)) {
    return false;
  }
  if (sport === "soccer") {
    if (/\b(halftime|second half|exact score|more markets|winner|outright|golden boot|ballon)\b/i.test(title)) {
      return false;
    }
  }
  if (sport === "football") {
    if (/\b(player props?|mvp|outright|draft|season|super bowl champion|win the 20\d\d)\b/i.test(title)) {
      return false;
    }
  }
  if (sport === "mlb") {
    if (/\b(player props?|first 5|world series champion|al mvp|nl mvp|cy young|outright|win the 20\d\d)\b/i.test(title)) {
      return false;
    }
  }
  return true;
}

function isTotalMarket(market: GammaMarket) {
  const type = (market.sportsMarketType ?? "").toLowerCase();
  const q = market.question ?? "";
  if (/\bcorners?\b|\bcards?\b|\bbookings?\b|\bshots?\b/i.test(q)) return false;
  if (type === "totals" || type.includes("total")) return true;
  return /O\/U|over\/under|\bover\s+[0-9.]|\bunder\s+[0-9.]|\bcombined for\s+[0-9.]|\bcombined points\b/i.test(q);
}

function isMoneylineMarket(market: GammaMarket, home: string, away: string) {
  const type = (market.sportsMarketType ?? "").toLowerCase();
  const q = market.question ?? "";
  const names = parseJsonField<string[]>(market.outcomes, []);
  if (names.length < 2) return false;
  if (/\bcorners?\b|\bcards?\b|\bbookings?\b/i.test(q)) return false;
  if (type === "moneyline") return true;
  if (/spread|handicap|O\/U|over|under|touchdown|yards|coin toss|player|prop/i.test(q)) return false;
  if (/end in a draw/i.test(q)) return true;
  if (/ vs\.? /i.test(q) && !/O\/U|over|under/i.test(q)) return true;
  if (/will .+\s+win/i.test(q) && (mentionsTeam(q, home) || mentionsTeam(q, away))) return true;
  return false;
}

function parseSplitMoneylineToken(
  sport: MonitorSport,
  eventId: string,
  home: string,
  away: string,
  market: GammaMarket
): MonitoredToken | null {
  const yn = yesNo(market);
  if (!yn?.yes.tokenId) return null;
  const marketId = `${eventId}:moneyline`;
  const question = market.question ?? "";
  if (/end in a draw/i.test(question)) {
    return token({
      tokenId: yn.yes.tokenId,
      marketId,
      eventId,
      sport,
      marketType: "moneyline",
      side: "draw",
      label: "Draw",
      line: null,
    });
  }
  if (/will .+\s+win/i.test(question)) {
    if (mentionsTeam(question, home) && !mentionsTeam(question, away)) {
      return token({
        tokenId: yn.yes.tokenId,
        marketId,
        eventId,
        sport,
        marketType: "moneyline",
        side: "home",
        label: home,
        line: null,
      });
    }
    if (mentionsTeam(question, away) && !mentionsTeam(question, home)) {
      return token({
        tokenId: yn.yes.tokenId,
        marketId,
        eventId,
        sport,
        marketType: "moneyline",
        side: "away",
        label: away,
        line: null,
      });
    }
  }
  return null;
}

function parseMoneyline(
  sport: MonitorSport,
  eventId: string,
  home: string,
  away: string,
  market: GammaMarket
): MonitoredMarket | null {
  const marketId = marketKey(eventId, market);
  const question = market.question ?? "";
  const names = parseJsonField<string[]>(market.outcomes, []);
  const tokens = parseJsonField<string[]>(market.clobTokenIds, []);
  const yn = yesNo(market);

  if (yn && /end in a draw/i.test(question)) {
    const rows: MonitoredToken[] = [];
    const homeMarket = parseMoneylineFromOutcomes(sport, eventId, marketId, question, home, away, names, tokens);
    if (homeMarket) rows.push(...homeMarket.tokens);
    rows.push(
      token({
        tokenId: yn.yes.tokenId,
        marketId,
        eventId,
        sport,
        marketType: "moneyline",
        side: "draw",
        label: "Draw",
        line: null,
      })!
    );
    if (!rows.length) return null;
    return {
      marketId,
      eventId,
      sport,
      marketType: "moneyline",
      question,
      line: null,
      tokens: rows,
    };
  }

  if (yn && /will .+\s+win/i.test(question)) {
    const homeHit = mentionsTeam(question, home);
    const awayHit = mentionsTeam(question, away);
    // Need exactly one side — short names used to miss and wrongly default to away.
    if (homeHit === awayHit) return null;
    const side = homeHit ? home : away;
    const row = token({
      tokenId: yn.yes.tokenId,
      marketId,
      eventId,
      sport,
      marketType: "moneyline",
      side: side === home ? "home" : "away",
      label: side,
      line: null,
    });
    return row
      ? {
          marketId,
          eventId,
          sport,
          marketType: "moneyline",
          question,
          line: null,
          tokens: [row],
        }
      : null;
  }

  return parseMoneylineFromOutcomes(sport, eventId, marketId, question, home, away, names, tokens);
}

function parseMoneylineFromOutcomes(
  sport: MonitorSport,
  eventId: string,
  marketId: string,
  question: string,
  home: string,
  away: string,
  names: string[],
  tokenIds: string[]
): MonitoredMarket | null {
  if (names.length < 2 || tokenIds.length < 2) return null;
  if (names.some((n) => /^(yes|no)$/i.test(n))) return null;

  const mapped = names.map((name, i) => ({ name, tokenId: tokenIds[i] ?? "" }));
  const homeOut = mapped.find((o) => sameTeam(o.name, home) || mentionsTeam(o.name, home));
  const awayOut = mapped.find(
    (o) => o !== homeOut && (sameTeam(o.name, away) || mentionsTeam(o.name, away))
  );
  const drawOut = mapped.find((o) => /^draw$/i.test(o.name));

  const rows: MonitoredToken[] = [];
  if (homeOut?.tokenId) {
    rows.push(
      token({
        tokenId: homeOut.tokenId,
        marketId,
        eventId,
        sport,
        marketType: "moneyline",
        side: "home",
        label: homeOut.name,
        line: null,
      })!
    );
  }
  if (awayOut?.tokenId) {
    rows.push(
      token({
        tokenId: awayOut.tokenId,
        marketId,
        eventId,
        sport,
        marketType: "moneyline",
        side: "away",
        label: awayOut.name,
        line: null,
      })!
    );
  }
  if (drawOut?.tokenId) {
    rows.push(
      token({
        tokenId: drawOut.tokenId,
        marketId,
        eventId,
        sport,
        marketType: "moneyline",
        side: "draw",
        label: "Draw",
        line: null,
      })!
    );
  }

  if (rows.length < 2) {
    for (const row of mapped) {
      if (!row.tokenId) continue;
      if (rows.some((r) => r.tokenId === row.tokenId)) continue;
      rows.push(
        token({
          tokenId: row.tokenId,
          marketId,
          eventId,
          sport,
          marketType: "moneyline",
          side: row.name.toLowerCase(),
          label: row.name,
          line: null,
        })!
      );
    }
  }

  if (rows.length < 2) return null;
  return {
    marketId,
    eventId,
    sport,
    marketType: "moneyline",
    question,
    line: null,
    tokens: rows,
  };
}

function parseEventMarkets(sport: MonitorSport, event: GammaEvent): MonitoredEvent | null {
  const title = event.title ?? "";
  if (!isMatchTitle(title, sport)) return null;
  const sides = splitSides(title.replace(/^[a-z0-9]+:\s*/i, ""));
  if (!sides) return null;
  const [home, away] = sides;
  const markets: MonitoredMarket[] = [];
  const seenMarketIds = new Set<string>();
  let moneyline: MonitoredMarket | null = null;
  const splitMoneylineTokens: MonitoredToken[] = [];

  for (const market of event.markets ?? []) {
    if (market.closed) continue;
    const marketId = marketKey(event.id, market);
    const question = market.question ?? "";

    if (isMatchTotalMarket(market)) {
      const parsed = ouFromMarket(sport, event.id, market, marketId, question);
      if (!parsed || seenMarketIds.has(parsed.marketId)) continue;
      seenMarketIds.add(parsed.marketId);
      markets.push(parsed);
      continue;
    }

    if (!moneyline && isMoneylineMarket(market, home, away)) {
      const parsed = parseMoneyline(sport, event.id, home, away, market);
      if (parsed && parsed.tokens.length >= 2) {
        moneyline = parsed;
        seenMarketIds.add(parsed.marketId);
        continue;
      }
      const split = parseSplitMoneylineToken(sport, event.id, home, away, market);
      if (split && !splitMoneylineTokens.some((row) => row.tokenId === split.tokenId)) {
        splitMoneylineTokens.push(split);
      }
    }
  }

  if (!moneyline && splitMoneylineTokens.length >= 2) {
    moneyline = {
      marketId: `${event.id}:moneyline`,
      eventId: event.id,
      sport,
      marketType: "moneyline",
      question: `${home} vs ${away}`,
      line: null,
      tokens: splitMoneylineTokens,
    };
  }

  if (!moneyline) return null;
  markets.unshift(moneyline);
  const status = polyStatusFromEvent(event);
  return {
    eventId: event.id,
    sport,
    title: event.title,
    slug: event.slug,
    ...eventSchedule(event),
    ...status,
    markets,
  };
}

export function parseGammaEvent(sport: MonitorSport, event: GammaEvent): MonitoredEvent | null {
  if (!isLiveEvent(event)) return null;
  return parseEventMarkets(sport, event);
}

/** Parse live main matches + merge O/U from sibling "More Markets" events. */
export function parseLiveSportEvents(sport: MonitorSport, gammaEvents: GammaEvent[]): MonitoredEvent[] {
  const live = gammaEvents.filter(isLiveEvent);
  const byKey = new Map<string, MonitoredEvent>();
  const moreMarkets: GammaEvent[] = [];

  for (const event of live) {
    const title = event.title ?? "";
    if (/more markets/i.test(title)) {
      moreMarkets.push(event);
      continue;
    }
    const parsed = parseEventMarkets(sport, event);
    if (parsed) byKey.set(baseMatchKey(parsed.title), parsed);
  }

  for (const event of moreMarkets) {
    const key = baseMatchKey(event.title ?? "");
    const main = byKey.get(key);
    if (!main) continue;
    if (event.slug) main.moreMarketsSlug = event.slug;
    const seen = new Set(main.markets.map((m) => m.marketId));
    const totals = parseTotalsForMatch(sport, main.eventId, event, seen);
    if (totals.length) main.markets.push(...totals);
  }

  return [...byKey.values()];
}

function weatherBucketLabel(question: string): string {
  const q = question;
  const rangeF = q.match(/between\s+(\d+)\s*[-–]\s*(\d+)\s*°?\s*F/i);
  if (rangeF) return `${rangeF[1]}-${rangeF[2]}°F`;
  const rangeC = q.match(/between\s+(\d+)\s*[-–]\s*(\d+)\s*°?\s*C/i);
  if (rangeC) return `${rangeC[1]}-${rangeC[2]}°C`;
  const belowF = q.match(/(\d+)\s*°?\s*F\s+or\s+below/i);
  if (belowF) return `≤${belowF[1]}°F`;
  const belowC = q.match(/(\d+)\s*°?\s*C\s+or\s+below/i);
  if (belowC) return `≤${belowC[1]}°C`;
  const aboveF = q.match(/(\d+)\s*°?\s*F\s+or\s+higher/i);
  if (aboveF) return `≥${aboveF[1]}°F`;
  const aboveC = q.match(/(\d+)\s*°?\s*C\s+or\s+higher/i);
  if (aboveC) return `≥${aboveC[1]}°C`;
  const singleC = q.match(/\b(\d+)\s*°?\s*C\b/i);
  if (singleC) return `${singleC[1]}°C`;
  const singleF = q.match(/\b(\d+)\s*°?\s*F\b/i);
  if (singleF) return `${singleF[1]}°F`;
  return (
    q
      .replace(/^Will the highest temperature in .+? be\s+/i, "")
      .replace(/\s+on .+$/i, "")
      .trim() || "Bucket"
  );
}

function maxYesOutcomePrice(event: GammaEvent): number | null {
  let max: number | null = null;
  for (const market of event.markets ?? []) {
    if (market.closed) continue;
    const names = parseJsonField<string[]>(market.outcomes, []);
    const prices = parseJsonField<Array<string | number>>(market.outcomePrices, []);
    const yesIdx = names.findIndex((n) => /^yes$/i.test(n));
    const raw = prices[yesIdx >= 0 ? yesIdx : 0];
    const price = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(price)) continue;
    if (max == null || price > max) max = price;
  }
  return max;
}

function isHighTempWeather(event: GammaEvent) {
  const title = event.title ?? "";
  const slug = event.slug ?? "";
  if (event.closed || event.ended === true) return false;
  return /highest temperature/i.test(title) || /highest-temperature/i.test(slug);
}

/** Parse open highest-temperature bucket markets across all cities (Yes + No tokens). */
export function parseWeatherEvents(gammaEvents: GammaEvent[]): MonitoredEvent[] {
  const out: MonitoredEvent[] = [];
  for (const event of gammaEvents) {
    if (!isHighTempWeather(event)) continue;
    const markets: MonitoredMarket[] = [];
    for (const market of event.markets ?? []) {
      if (market.closed) continue;
      const yn = yesNo(market);
      if (!yn?.yes.tokenId) continue;
      const question = market.question ?? "";
      const label = weatherBucketLabel(question);
      const marketId = marketKey(event.id, market);
      const rows = [
        token({
          tokenId: yn.yes.tokenId,
          marketId,
          eventId: event.id,
          sport: "weather",
          marketType: "weather",
          side: "yes",
          label,
          line: label,
        }),
        yn.no.tokenId
          ? token({
              tokenId: yn.no.tokenId,
              marketId,
              eventId: event.id,
              sport: "weather",
              marketType: "weather",
              side: "no",
              label,
              line: label,
            })
          : null,
      ].filter((row): row is MonitoredToken => row != null);
      if (!rows.length) continue;
      markets.push({
        marketId,
        eventId: event.id,
        sport: "weather",
        marketType: "weather",
        question,
        line: label,
        tokens: rows,
      });
    }
    if (!markets.length) continue;
    markets.sort((a, b) => (a.line ?? "").localeCompare(b.line ?? "", undefined, { numeric: true }));
    const status = polyStatusFromEvent(event);
    out.push({
      eventId: event.id,
      sport: "weather",
      title: event.title,
      slug: event.slug,
      ...eventSchedule(event),
      ...status,
      // Weather days stay open even when Gamma `live` is false.
      ended: status.closed || event.ended === true,
      closed: status.closed,
      polyLive: !status.closed && event.ended !== true,
      finishedAt: status.closed || event.ended === true ? status.finishedAt : null,
      maxYesPrice: maxYesOutcomePrice(event),
      markets,
    });
  }
  return out;
}

export function allTokens(events: MonitoredEvent[]): MonitoredToken[] {
  const byId = new Map<string, MonitoredToken>();
  for (const event of events) {
    for (const market of event.markets) {
      for (const row of market.tokens) {
        byId.set(row.tokenId, row);
      }
    }
  }
  return [...byId.values()];
}

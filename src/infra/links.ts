import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { MonitoredEvent } from "../types/monitoring.ts";

export const LINKS_PATH = process.env.LINKS_PATH ?? resolve(process.cwd(), "data", "live-links.json");

export function polyEventUrl(slug: string) {
  return `https://polymarket.com/event/${encodeURIComponent(slug)}`;
}

export type LiveLinkToken = {
  tokenId: string;
  label: string;
  side: string;
  line: string | null;
  marketType: string;
  url: string;
};

export type LiveLinkMarket = {
  marketId: string;
  marketType: string;
  line: string | null;
  question: string;
  tokens: LiveLinkToken[];
};

export type LiveLinkEvent = {
  eventId: string;
  sport: string;
  title: string;
  slug: string;
  url: string;
  moreMarketsUrl: string | null;
  startTime: string | null;
  eventDate: string | null;
  marketCount: number;
  tokenCount: number;
  moneylineCount: number;
  totalCount: number;
  markets: LiveLinkMarket[];
};

export type LiveLinksFile = {
  updatedAt: string;
  count: number;
  tokenCount: number;
  events: LiveLinkEvent[];
};

export function buildLiveLinks(events: MonitoredEvent[]): LiveLinksFile {
  const rows: LiveLinkEvent[] = events.map((event) => {
    const eventUrl = polyEventUrl(event.slug);
    const markets: LiveLinkMarket[] = event.markets.map((market) => ({
      marketId: market.marketId,
      marketType: market.marketType,
      line: market.line,
      question: market.question,
      tokens: market.tokens.map((row) => ({
        tokenId: row.tokenId,
        label: row.label,
        side: row.side,
        line: row.line,
        marketType: row.marketType,
        url: eventUrl,
      })),
    }));
    const tokenCount = markets.reduce((n, m) => n + m.tokens.length, 0);
    return {
      eventId: event.eventId,
      sport: event.sport,
      title: event.title,
      slug: event.slug,
      url: eventUrl,
      moreMarketsUrl: event.moreMarketsSlug ? polyEventUrl(event.moreMarketsSlug) : null,
      startTime: event.startTime,
      eventDate: event.eventDate,
      marketCount: markets.length,
      tokenCount,
      moneylineCount: markets.filter((m) => m.marketType === "moneyline").length,
      totalCount: markets.filter((m) => m.marketType === "total").length,
      markets,
    };
  });

  return {
    updatedAt: new Date().toISOString(),
    count: rows.length,
    tokenCount: rows.reduce((n, e) => n + e.tokenCount, 0),
    events: rows,
  };
}

export function saveLiveLinks(events: MonitoredEvent[]) {
  const payload = buildLiveLinks(events);
  mkdirSync(dirname(LINKS_PATH), { recursive: true });
  writeFileSync(LINKS_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return payload;
}

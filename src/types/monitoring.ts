export type MonitorSport = "soccer" | "football" | "mlb" | "weather";

export type MarketType = "moneyline" | "total" | "weather";

export type MonitoredToken = {
  tokenId: string;
  marketId: string;
  eventId: string;
  sport: MonitorSport;
  marketType: MarketType;
  side: string;
  label: string;
  line: string | null;
};

export type MonitoredMarket = {
  marketId: string;
  eventId: string;
  sport: MonitorSport;
  marketType: MarketType;
  question: string;
  line: string | null;
  tokens: MonitoredToken[];
};

export type MonitoredEvent = {
  eventId: string;
  sport: MonitorSport;
  title: string;
  slug: string;
  /** Live "More Markets" companion event slug (totals live here on soccer). */
  moreMarketsSlug?: string | null;
  startTime: string | null;
  eventDate: string | null;
  /** Polymarket event.ended */
  ended: boolean;
  /** Polymarket event.live (in-play) */
  polyLive: boolean;
  /** Polymarket event.closed */
  closed: boolean;
  gameStatus: string | null;
  /** When Polymarket resolved / closed the event (ms). */
  finishedAt: number | null;
  /** Highest Yes outcome price seen on Gamma (weather arming). */
  maxYesPrice?: number | null;
  markets: MonitoredMarket[];
};

export type BookLevel = { price: number; size: number };

export type BookSnapshot = {
  tokenId: string;
  eventId: string;
  sport: MonitorSport;
  capturedAt: number;
  bestBid: number | null;
  bestAsk: number | null;
  bidDepth: number;
  askDepth: number;
  bids: BookLevel[];
  asks: BookLevel[];
  source: "wss" | "rest";
};

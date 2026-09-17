import WebSocket from "ws";
import { bestOf, depthSum, normalizeBookSide, parseLevels } from "../db/store.ts";
import type { MonitorHub } from "../db/store.ts";
import type { BookLevel, BookSnapshot, MonitoredToken } from "../types/monitoring.ts";
import { polyFetch } from "../utils/polyNet.ts";

const URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const CLOB_BOOK = "https://clob.polymarket.com/book";
const PING_MS = 10_000;
const STALE_MS = 20_000;
const WATCH_MS = 5_000;
const MAX_BACKOFF_MS = 15_000;
/** Background REST reconcile when we lack a seed book or best moved without sizes. */
const REST_REFRESH_MS = 5_000;

type Level = { price: string; size: string };
type BookEvent = { event_type: "book"; asset_id: string; bids?: Level[]; asks?: Level[] };
type PriceChange = {
  asset_id: string;
  price?: string;
  size?: string;
  side?: string;
  best_bid?: string;
  best_ask?: string;
};
type PriceChangeEvent = {
  event_type: "price_change";
  price_changes?: PriceChange[];
};
type BestBidAskEvent = {
  event_type: "best_bid_ask";
  asset_id: string;
  best_bid?: string;
  best_ask?: string;
};
type ParsedBook = { bids: BookLevel[]; asks: BookLevel[] };

export type TokenQuote = {
  bestBid: number | null;
  bestAsk: number | null;
  bidLevels: number;
  askLevels: number;
  lastBookAt: number | null;
  snapshots: number;
};

export type StreamStats = {
  connected: boolean;
  stale: boolean;
  messages: number;
  bookEvents: number;
  snapshotsWritten: number;
  sampleWrites: number;
  lastMessageAt: number | null;
  quotes: Map<string, TokenQuote>;
};

function subscribePayload(tokens: string[]) {
  return JSON.stringify({
    assets_ids: tokens,
    type: "market",
    initial_dump: true,
    level: 2,
    custom_feature_enabled: true,
  });
}

function patchPayload(tokens: string[], operation: "subscribe" | "unsubscribe") {
  return JSON.stringify(
    operation === "subscribe"
      ? { assets_ids: tokens, operation, initial_dump: true }
      : { assets_ids: tokens, operation }
  );
}

function bestPrice(levels: BookLevel[], side: "bid" | "ask") {
  if (!levels.length) return null;
  let best = levels[0]!.price;
  for (const level of levels) {
    if (side === "bid" ? level.price > best : level.price < best) best = level.price;
  }
  return best;
}

/** Full L2 signature — skip write only when the book is identical. */
function bookSignature(bids: BookLevel[], asks: BookLevel[]) {
  const fmt = (levels: BookLevel[], side: "bid" | "ask") =>
    normalizeBookSide(levels, side)
      .map((l) => `${l.price}:${l.size}`)
      .join(",");
  return `${fmt(bids, "bid")}|${fmt(asks, "ask")}`;
}

function applyLevelUpdate(levels: BookLevel[], price: number, size: number): BookLevel[] {
  const next = levels.filter((l) => l.price !== price);
  if (size > 0) next.push({ price, size });
  return next;
}

function isCrossed(book: ParsedBook) {
  const bb = bestOf(book.bids, "bid");
  const ba = bestOf(book.asks, "ask");
  return bb != null && ba != null && bb >= ba;
}

/** Drop stale opposite-side levels so bid never sits at/above ask. */
function uncrossBook(bids: BookLevel[], asks: BookLevel[]): ParsedBook {
  let nextBids = bids;
  let nextAsks = asks;
  for (let i = 0; i < 6; i++) {
    const bb = bestOf(nextBids, "bid");
    const ba = bestOf(nextAsks, "ask");
    if (bb == null || ba == null || bb < ba) break;
    // Prefer keeping the ask ladder when bids went stale after an ask improve.
    nextBids = nextBids.filter((l) => l.price < ba);
    const bb2 = bestOf(nextBids, "bid");
    if (bb2 != null && ba <= bb2) {
      nextAsks = nextAsks.filter((l) => l.price > bb2);
    }
  }
  return {
    bids: normalizeBookSide(nextBids, "bid"),
    asks: normalizeBookSide(nextAsks, "ask"),
  };
}

/** Trim depth to authoritative TOB from price_change / best_bid_ask payloads. */
function trimToTob(
  bids: BookLevel[],
  asks: BookLevel[],
  bestBid: number | null,
  bestAsk: number | null
): ParsedBook {
  let nextBids = bids;
  let nextAsks = asks;
  if (bestBid != null && Number.isFinite(bestBid)) {
    nextBids = nextBids.filter((l) => l.price <= bestBid + 1e-12);
  }
  if (bestAsk != null && Number.isFinite(bestAsk)) {
    nextAsks = nextAsks.filter((l) => l.price >= bestAsk - 1e-12);
  }
  if (
    bestBid != null &&
    bestAsk != null &&
    Number.isFinite(bestBid) &&
    Number.isFinite(bestAsk) &&
    bestBid < bestAsk
  ) {
    nextBids = nextBids.filter((l) => l.price < bestAsk);
    nextAsks = nextAsks.filter((l) => l.price > bestBid);
  }
  return uncrossBook(nextBids, nextAsks);
}

function applyPriceChange(book: ParsedBook, change: PriceChange): ParsedBook {
  let bids = book.bids;
  let asks = book.asks;
  const price = change.price != null ? Number(change.price) : NaN;
  const size = change.size != null ? Number(change.size) : NaN;
  const side = String(change.side ?? "").toUpperCase();

  if (Number.isFinite(price) && Number.isFinite(size)) {
    if (side === "BUY" || side === "BID") {
      bids = applyLevelUpdate(bids, price, size);
    } else if (side === "SELL" || side === "ASK") {
      asks = applyLevelUpdate(asks, price, size);
    }
  }

  const tobBid = change.best_bid != null ? Number(change.best_bid) : null;
  const tobAsk = change.best_ask != null ? Number(change.best_ask) : null;
  if (
    (tobBid != null && Number.isFinite(tobBid)) ||
    (tobAsk != null && Number.isFinite(tobAsk))
  ) {
    return trimToTob(
      bids,
      asks,
      tobBid != null && Number.isFinite(tobBid) ? tobBid : null,
      tobAsk != null && Number.isFinite(tobAsk) ? tobAsk : null
    );
  }

  return uncrossBook(bids, asks);
}

export class OrderbookStream {
  private ws: WebSocket | null = null;
  private ping: ReturnType<typeof setInterval> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private reconnect: ReturnType<typeof setTimeout> | null = null;
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private tokenSignature = "";
  private pendingTokens: string[] = [];
  private subscribed = new Set<string>();
  private stopped = false;
  private ignoreClose = false;
  private backoffMs = 1_000;
  private lastMessageAt = 0;
  private readonly lastBookSig = new Map<string, string>();
  private readonly tokenMeta = new Map<string, MonitoredToken>();
  private readonly bookCache = new Map<string, ParsedBook>();
  private messages = 0;
  private bookEvents = 0;
  private snapshotsWritten = 0;
  private readonly quotes = new Map<string, TokenQuote>();
  private readonly bookFetchAt = new Map<string, number>();

  constructor(
    private readonly getTokens: () => MonitoredToken[],
    private readonly store: Pick<MonitorHub, "recordSnapshot" | "getTokenMeta">,
    private readonly onEvent?: (message: string) => void
  ) {}

  getStats(): StreamStats {
    const connected = this.ws?.readyState === WebSocket.OPEN;
    const stale = connected && Date.now() - this.lastMessageAt >= STALE_MS;
    return {
      connected,
      stale,
      messages: this.messages,
      bookEvents: this.bookEvents,
      snapshotsWritten: this.snapshotsWritten,
      sampleWrites: 0,
      lastMessageAt: this.lastMessageAt || null,
      quotes: new Map(this.quotes),
    };
  }

  isLive() {
    return this.ws?.readyState === WebSocket.OPEN && Date.now() - this.lastMessageAt < STALE_MS;
  }

  sync() {
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null;
      this.syncNow();
    }, 250);
  }

  stop() {
    this.stopped = true;
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = null;
    this.killSocket();
    if (this.reconnect) clearTimeout(this.reconnect);
    this.reconnect = null;
  }

  private syncNow() {
    if (this.stopped) return;
    const tokens = this.getTokens();
    const active = new Set(tokens.map((row) => row.tokenId).filter(Boolean));
    for (const row of tokens) this.tokenMeta.set(row.tokenId, row);
    for (const tokenId of [...this.tokenMeta.keys()]) {
      if (!active.has(tokenId)) this.tokenMeta.delete(tokenId);
    }
    for (const tokenId of [...this.bookCache.keys()]) {
      if (!active.has(tokenId)) this.bookCache.delete(tokenId);
    }
    for (const tokenId of [...this.quotes.keys()]) {
      if (!active.has(tokenId)) this.quotes.delete(tokenId);
    }
    for (const tokenId of [...this.lastBookSig.keys()]) {
      if (!active.has(tokenId)) this.lastBookSig.delete(tokenId);
    }
    for (const tokenId of [...this.bookFetchAt.keys()]) {
      if (!active.has(tokenId)) this.bookFetchAt.delete(tokenId);
    }

    const ids = [...active].sort();
    const signature = ids.join(",");
    if (!ids.length) {
      this.tokenSignature = "";
      this.pendingTokens = [];
      this.subscribed.clear();
      if (this.reconnect) {
        clearTimeout(this.reconnect);
        this.reconnect = null;
      }
      this.killSocket();
      return;
    }

    this.pendingTokens = ids;

    if (this.ws?.readyState === WebSocket.OPEN) {
      if (!this.isLive()) {
        this.scheduleReconnect("stale socket");
        return;
      }
      if (signature === this.tokenSignature && this.subscribed.size) return;
      this.patchSubscription(ids, signature);
      return;
    }

    if (this.ws?.readyState === WebSocket.CONNECTING) {
      this.tokenSignature = signature;
      return;
    }

    if (this.reconnect) return;
    this.tokenSignature = signature;
    this.connect(ids);
  }

  private patchSubscription(tokens: string[], signature: string) {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      if (!this.subscribed.size) {
        ws.send(subscribePayload(tokens));
        this.subscribed = new Set(tokens);
        this.tokenSignature = signature;
        return;
      }
      const next = new Set(tokens);
      const added = tokens.filter((id) => !this.subscribed.has(id));
      const removed = [...this.subscribed].filter((id) => !next.has(id));
      if (removed.length) ws.send(patchPayload(removed, "unsubscribe"));
      if (added.length) ws.send(patchPayload(added, "subscribe"));
      this.subscribed = new Set(tokens);
      this.tokenSignature = signature;
    } catch {
      this.scheduleReconnect("resubscribe failed");
    }
  }

  private connect(tokens: string[]) {
    if (this.stopped) return;
    if (this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING) return;

    const ws = new WebSocket(URL);
    this.ws = ws;
    this.ignoreClose = false;

    ws.on("open", () => {
      this.backoffMs = 1_000;
      this.lastMessageAt = Date.now();
      const live = this.pendingTokens.length ? this.pendingTokens : tokens;
      this.subscribed = new Set(live);
      this.tokenSignature = live.join(",");
      if (live.length) ws.send(subscribePayload(live));
      this.startHeartbeat(ws);
      this.onEvent?.(`WSS connected (${live.length} tokens)`);
    });

    ws.on("message", (raw) => {
      this.lastMessageAt = Date.now();
      this.messages++;
      const text = raw.toString().trim();
      if (text === "PONG" || text === "NO NEW ASSETS") return;
      try {
        const payload = JSON.parse(text) as unknown;
        const events = Array.isArray(payload) ? payload : [payload];
        for (const event of events) {
          this.apply(event as BookEvent | PriceChangeEvent | BestBidAskEvent);
        }
      } catch (error) {
        this.onEvent?.(error instanceof Error ? error.message : String(error));
      }
    });

    ws.on("pong", () => {
      this.lastMessageAt = Date.now();
    });

    ws.on("error", (error) => {
      if (this.ignoreClose) return;
      const msg = error.message;
      if (/closed before the connection was established/i.test(msg)) return;
      this.onEvent?.(`WSS error: ${msg}`);
    });

    ws.on("close", () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.stopHeartbeat();
      if (this.stopped || this.ignoreClose) return;
      this.scheduleReconnect("closed");
    });
  }

  private startHeartbeat(ws: WebSocket) {
    this.stopHeartbeat();
    this.ping = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.send("PING");
        ws.ping();
      } catch {
        this.scheduleReconnect("ping failed");
      }
    }, PING_MS);
    this.watchdog = setInterval(() => {
      if (this.stopped) return;
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastMessageAt < STALE_MS) return;
      this.scheduleReconnect("no heartbeat");
    }, WATCH_MS);
  }

  private stopHeartbeat() {
    if (this.ping) clearInterval(this.ping);
    if (this.watchdog) clearInterval(this.watchdog);
    this.ping = null;
    this.watchdog = null;
  }

  private scheduleReconnect(reason: string) {
    if (this.stopped) return;
    if (this.reconnect) return;
    this.onEvent?.(`WSS ${reason}, reconnecting`);
    this.killSocket();
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    this.reconnect = setTimeout(() => {
      this.reconnect = null;
      this.connect(this.pendingTokens);
    }, delay);
  }

  private killSocket() {
    this.stopHeartbeat();
    this.subscribed.clear();
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    this.ignoreClose = true;
    ws.removeAllListeners("open");
    ws.removeAllListeners("message");
    ws.removeAllListeners("pong");
    ws.removeAllListeners("close");
    ws.on("error", () => {});
    try {
      if (ws.readyState === WebSocket.OPEN) ws.terminate();
      else if (ws.readyState === WebSocket.CONNECTING) ws.close();
    } catch {
      /* ignore */
    }
  }

  /** Write only when the book actually changed. No timers, no activity tiers. */
  private recordIfChanged(tokenId: string, bids: BookLevel[], asks: BookLevel[]) {
    const sig = bookSignature(bids, asks);
    if (this.lastBookSig.get(tokenId) === sig) return;
    this.lastBookSig.set(tokenId, sig);
    this.writeSnapshot(tokenId, bids, asks);
  }

  private async fetchFullBook(tokenId: string) {
    const res = await polyFetch(`${CLOB_BOOK}?token_id=${encodeURIComponent(tokenId)}`, 8_000);
    if (!res.ok) return null;
    const body = (await res.json()) as { bids?: Level[]; asks?: Level[] };
    return {
      bids: parseLevels(body.bids ?? []),
      asks: parseLevels(body.asks ?? []),
    };
  }

  private pickBook(wss: ParsedBook, rest: ParsedBook | null) {
    if (!rest) return uncrossBook(wss.bids, wss.asks);
    const wssBook = uncrossBook(wss.bids, wss.asks);
    const restBook = uncrossBook(rest.bids, rest.asks);
    const wssBad = isCrossed(wss);
    const restBad = isCrossed(rest);
    if (wssBad && !restBad) return restBook;
    if (restBad && !wssBad) return wssBook;
    const wssLevels = wssBook.bids.length + wssBook.asks.length;
    const restLevels = restBook.bids.length + restBook.asks.length;
    return restLevels >= wssLevels ? restBook : wssBook;
  }

  private queueBookWrite(tokenId: string, bids: BookLevel[], asks: BookLevel[]) {
    const book = uncrossBook(bids, asks);
    this.bookCache.set(tokenId, book);
    this.recordIfChanged(tokenId, book.bids, book.asks);
    this.maybeRefreshRest(tokenId);
  }

  private maybeRefreshRest(tokenId: string, force = false) {
    const now = Date.now();
    const lastFetch = this.bookFetchAt.get(tokenId) ?? 0;
    if (!force && now - lastFetch < REST_REFRESH_MS) return;
    this.bookFetchAt.set(tokenId, now);
    const cached = this.bookCache.get(tokenId);
    void this.fetchFullBook(tokenId)
      .then((rest) => {
        if (!rest) return;
        const wss = this.bookCache.get(tokenId) ?? cached;
        const picked = wss ? this.pickBook(wss, rest) : rest;
        this.bookCache.set(tokenId, picked);
        this.recordIfChanged(tokenId, picked.bids, picked.asks);
      })
      .catch(() => {
        /* WSS path already handled */
      });
  }

  private writeSnapshot(tokenId: string, bids: BookLevel[], asks: BookLevel[]) {
    if (!this.getTokens().some((row) => row.tokenId === tokenId)) {
      this.bookCache.delete(tokenId);
      return;
    }
    const meta = this.tokenMeta.get(tokenId) ?? this.store.getTokenMeta(tokenId);
    if (!meta) return;
    const bookBids = normalizeBookSide(bids, "bid");
    const bookAsks = normalizeBookSide(asks, "ask");
    const snap: BookSnapshot = {
      tokenId,
      eventId: meta.eventId,
      sport: meta.sport,
      capturedAt: Date.now(),
      bestBid: bestOf(bookBids, "bid"),
      bestAsk: bestOf(bookAsks, "ask"),
      bidDepth: depthSum(bookBids),
      askDepth: depthSum(bookAsks),
      bids: bookBids,
      asks: bookAsks,
      source: "wss",
    };
    this.store.recordSnapshot(snap);
    this.snapshotsWritten++;
    const prev = this.quotes.get(tokenId);
    this.quotes.set(tokenId, {
      bestBid: snap.bestBid,
      bestAsk: snap.bestAsk,
      bidLevels: bookBids.length,
      askLevels: bookAsks.length,
      lastBookAt: snap.capturedAt,
      snapshots: (prev?.snapshots ?? 0) + 1,
    });
  }

  private apply(event: BookEvent | PriceChangeEvent | BestBidAskEvent) {
    if (event.event_type === "book") {
      this.bookEvents++;
      this.queueBookWrite(event.asset_id, parseLevels(event.bids ?? []), parseLevels(event.asks ?? []));
      return;
    }

    if (event.event_type === "price_change") {
      for (const change of event.price_changes ?? []) {
        const cached = this.bookCache.get(change.asset_id);
        if (!cached) {
          this.maybeRefreshRest(change.asset_id, true);
          continue;
        }
        const next = applyPriceChange(cached, change);
        this.bookCache.set(change.asset_id, next);
        this.recordIfChanged(change.asset_id, next.bids, next.asks);
      }
      return;
    }

    if (event.event_type === "best_bid_ask") {
      const cached = this.bookCache.get(event.asset_id);
      if (!cached) {
        this.maybeRefreshRest(event.asset_id, true);
        return;
      }
      const prevBid = bestPrice(cached.bids, "bid");
      const prevAsk = bestPrice(cached.asks, "ask");
      const nextBid = event.best_bid != null ? Number(event.best_bid) : prevBid;
      const nextAsk = event.best_ask != null ? Number(event.best_ask) : prevAsk;
      const bidChanged = nextBid != null && Number.isFinite(nextBid) && nextBid !== prevBid;
      const askChanged = nextAsk != null && Number.isFinite(nextAsk) && nextAsk !== prevAsk;
      if (!bidChanged && !askChanged) return;

      const trimmed = trimToTob(
        cached.bids,
        cached.asks,
        nextBid != null && Number.isFinite(nextBid) ? nextBid : null,
        nextAsk != null && Number.isFinite(nextAsk) ? nextAsk : null
      );
      this.bookCache.set(event.asset_id, trimmed);
      this.recordIfChanged(event.asset_id, trimmed.bids, trimmed.asks);
      // Sizes may be wrong after TOB-only trim — pull full book.
      this.maybeRefreshRest(event.asset_id, true);
    }
  }
}

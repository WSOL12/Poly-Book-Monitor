import WebSocket from "ws";
import {
  BOOK_ACTIVE_MS,
  BOOK_DEAD_MS,
  BOOK_QUIET_MS,
  BOOK_SAMPLE_MS,
  BOOK_THROTTLE_MS,
} from "../config/env.ts";
import { bestOf, depthSum, normalizeBookSide, parseLevels } from "../db/store.ts";
import type { MonitorStore } from "../db/store.ts";
import type { BookSnapshot, MonitoredToken } from "../types/monitoring.ts";
import { polyFetch } from "../utils/polyNet.ts";

const URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const CLOB_BOOK = "https://clob.polymarket.com/book";
const PING_MS = 10_000;
const STALE_MS = 20_000;
const WATCH_MS = 5_000;
const MAX_BACKOFF_MS = 15_000;

type Level = { price: string; size: string };
type BookEvent = { event_type: "book"; asset_id: string; bids?: Level[]; asks?: Level[] };
type PriceChangeEvent = {
  event_type: "price_change";
  price_changes?: Array<{ asset_id: string; best_bid?: string; best_ask?: string }>;
};
type BestBidAskEvent = {
  event_type: "best_bid_ask";
  asset_id: string;
  best_bid?: string;
  best_ask?: string;
};
type ParsedBook = { bids: ReturnType<typeof parseLevels>; asks: ReturnType<typeof parseLevels> };

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

function bestPrice(levels: ReturnType<typeof parseLevels>, side: "bid" | "ask") {
  if (!levels.length) return null;
  let best = levels[0]!.price;
  for (const level of levels) {
    if (side === "bid" ? level.price > best : level.price < best) best = level.price;
  }
  return best;
}

/** active = useful mid-market; dead = basically resolved; quiet = everything else. */
function bookActivity(bestBid: number | null, bestAsk: number | null): "active" | "quiet" | "dead" {
  const midBid = bestBid != null && bestBid > 0.05 && bestBid < 0.95;
  const midAsk = bestAsk != null && bestAsk > 0.05 && bestAsk < 0.95;
  if (midBid || midAsk) return "active";
  const deadBid = bestBid != null && bestBid >= 0.98;
  const deadAsk = bestAsk != null && bestAsk <= 0.02;
  if (deadBid || deadAsk) return "dead";
  return "quiet";
}

function bookSignature(bids: ReturnType<typeof parseLevels>, asks: ReturnType<typeof parseLevels>) {
  const bid = bestPrice(bids, "bid");
  const ask = bestPrice(asks, "ask");
  const topBid = bids[0];
  const topAsk = asks[0];
  return [
    bid ?? "",
    ask ?? "",
    bids.length,
    asks.length,
    topBid ? `${topBid.price}:${topBid.size}` : "",
    topAsk ? `${topAsk.price}:${topAsk.size}` : "",
  ].join("|");
}

function writeGapMs(activity: "active" | "quiet" | "dead", changed: boolean) {
  if (changed) {
    if (activity === "active") return Math.min(BOOK_THROTTLE_MS, BOOK_ACTIVE_MS);
    if (activity === "quiet") return BOOK_THROTTLE_MS;
    return Math.max(BOOK_THROTTLE_MS, 2_000);
  }
  if (activity === "active") return BOOK_ACTIVE_MS;
  if (activity === "quiet") return BOOK_QUIET_MS;
  return BOOK_DEAD_MS;
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
  private readonly lastWriteAt = new Map<string, number>();
  private readonly lastBookSig = new Map<string, string>();
  private readonly tokenMeta = new Map<string, MonitoredToken>();
  private readonly bookCache = new Map<string, ParsedBook>();
  private sampleTimer: ReturnType<typeof setInterval> | null = null;
  private messages = 0;
  private bookEvents = 0;
  private snapshotsWritten = 0;
  private sampleWrites = 0;
  private readonly quotes = new Map<string, TokenQuote>();
  private readonly bookFetchAt = new Map<string, number>();

  constructor(
    private readonly getTokens: () => MonitoredToken[],
    private readonly store: MonitorStore,
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
      sampleWrites: this.sampleWrites,
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
    if (this.sampleTimer) clearInterval(this.sampleTimer);
    this.sampleTimer = null;
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
    for (const tokenId of [...this.lastWriteAt.keys()]) {
      if (!active.has(tokenId)) this.lastWriteAt.delete(tokenId);
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
      this.startSampling();
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

  private startSampling() {
    if (this.sampleTimer) clearInterval(this.sampleTimer);
    if (!BOOK_SAMPLE_MS || BOOK_SAMPLE_MS <= 0) return;
    this.sampleTimer = setInterval(() => {
      if (this.stopped || !this.bookCache.size) return;
      const active = new Set(this.getTokens().map((row) => row.tokenId));
      for (const [tokenId, book] of this.bookCache) {
        if (!active.has(tokenId)) {
          this.bookCache.delete(tokenId);
          continue;
        }
        // Heartbeat sample — skip flat settled books most of the time.
        if (!this.shouldWrite(tokenId, book.bids, book.asks, true)) continue;
        this.writeSnapshot(tokenId, book.bids, book.asks, "wss", true);
      }
    }, BOOK_SAMPLE_MS);
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
    if (this.sampleTimer) clearInterval(this.sampleTimer);
    this.sampleTimer = null;
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

  private shouldWrite(
    tokenId: string,
    bids: ReturnType<typeof parseLevels>,
    asks: ReturnType<typeof parseLevels>,
    sampled = false
  ) {
    const bestBid = bestPrice(bids, "bid");
    const bestAsk = bestPrice(asks, "ask");
    const activity = bookActivity(bestBid, bestAsk);
    const sig = bookSignature(bids, asks);
    const prevSig = this.lastBookSig.get(tokenId);
    const changed = prevSig == null || prevSig !== sig;
    // Periodic sampler: never spam identical dead books.
    if (sampled && !changed && activity === "dead") {
      const last = this.lastWriteAt.get(tokenId) ?? 0;
      if (Date.now() - last < BOOK_DEAD_MS) return false;
    }
    const gap = writeGapMs(activity, changed);
    const now = Date.now();
    const last = this.lastWriteAt.get(tokenId) ?? 0;
    if (now - last < gap) return false;
    this.lastWriteAt.set(tokenId, now);
    this.lastBookSig.set(tokenId, sig);
    return true;
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
    if (!rest) return wss;
    const wssLevels = wss.bids.length + wss.asks.length;
    const restLevels = rest.bids.length + rest.asks.length;
    return restLevels >= wssLevels ? rest : wss;
  }

  private queueBookWrite(
    tokenId: string,
    bids: ReturnType<typeof parseLevels>,
    asks: ReturnType<typeof parseLevels>
  ) {
    this.bookCache.set(tokenId, { bids, asks });
    const now = Date.now();
    const lastFetch = this.bookFetchAt.get(tokenId) ?? 0;

    if (now - lastFetch >= 2_000) {
      this.bookFetchAt.set(tokenId, now);
      void this.fetchFullBook(tokenId)
        .then((rest) => {
          const picked = this.pickBook({ bids, asks }, rest);
          this.bookCache.set(tokenId, picked);
          if (!this.shouldWrite(tokenId, picked.bids, picked.asks)) return;
          this.writeSnapshot(tokenId, picked.bids, picked.asks, "wss");
        })
        .catch(() => {
          if (this.shouldWrite(tokenId, bids, asks)) this.writeSnapshot(tokenId, bids, asks, "wss");
        });
      return;
    }

    if (this.shouldWrite(tokenId, bids, asks)) this.writeSnapshot(tokenId, bids, asks, "wss");
  }

  private writeSnapshot(
    tokenId: string,
    bids: ReturnType<typeof parseLevels>,
    asks: ReturnType<typeof parseLevels>,
    source: "wss",
    sampled = false
  ) {
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
      source,
    };
    this.store.recordSnapshot(snap);
    this.snapshotsWritten++;
    if (sampled) this.sampleWrites++;
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
      const bids = parseLevels(event.bids ?? []);
      const asks = parseLevels(event.asks ?? []);
      this.queueBookWrite(event.asset_id, bids, asks);
      return;
    }

    if (event.event_type === "price_change") {
      for (const change of event.price_changes ?? []) {
        const cached = this.bookCache.get(change.asset_id);
        if (!cached) continue;
        if (!this.shouldWrite(change.asset_id, cached.bids, cached.asks)) continue;
        this.writeSnapshot(change.asset_id, cached.bids, cached.asks, "wss");
      }
      return;
    }

    if (event.event_type === "best_bid_ask") {
      const cached = this.bookCache.get(event.asset_id);
      if (!cached) return;
      if (!this.shouldWrite(event.asset_id, cached.bids, cached.asks)) return;
      this.writeSnapshot(event.asset_id, cached.bids, cached.asks, "wss");
    }
  }
}

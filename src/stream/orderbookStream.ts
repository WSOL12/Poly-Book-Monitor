import WebSocket from "ws";
import { bestOf, depthSum, normalizeBookSide, parseLevels } from "../db/store.ts";
import type { MonitorHub } from "../db/store.ts";
import type { BookLevel, BookSnapshot, MonitoredToken } from "../types/monitoring.ts";
import { polyFetch } from "../utils/polyNet.ts";

const URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const CLOB_BOOK = "https://clob.polymarket.com/book";
const PING_MS = 10_000;
/** Treat socket as dead if no message/pong for this long. */
const STALE_MS = 12_000;
/** How often we check for silence. */
const WATCH_MS = 2_000;
/** First reconnect attempt — keep gaps short. */
const MIN_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 5_000;
/** Stagger shard connects so Polymarket doesn't refuse a 60-socket burst. */
const SHARD_CONNECT_STAGGER_MS = 75;
/** Polymarket market WSS dies when one socket carries thousands of assets. */
const MAX_ASSETS_PER_WS = 40;
/** Background REST reconcile when we lack a seed book or best moved without sizes. */
const REST_REFRESH_MS = 3_000;
/** When a shard is down/stale, poll REST so books keep moving. */
const REST_FALLBACK_MS = 1_000;
const REST_FALLBACK_CONCURRENCY = 60;
const REST_STALE_TOKEN_MS = 3_000;
const REST_BOOK_TIMEOUT_MS = 3_500;
/** After a shard reconnect, pull full books so missed WSS deltas don't leave holes. */
const RESYNC_CONCURRENCY = 24;
/** If no shard is live this long, tear down and rebuild all sockets. */
const WSS_DEAD_REBUILD_MS = 15_000;

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
  shards?: number;
  liveShards?: number;
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

function chunkIds(ids: string[], size: number) {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
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

type ShardHandlers = {
  onMessage: (event: BookEvent | PriceChangeEvent | BestBidAskEvent) => void;
  onConnected?: (tokens: string[]) => void;
  onLog?: (message: string) => void;
};

/** One Polymarket market socket — keep asset count small so heartbeats survive. */
class MarketShard {
  private ws: WebSocket | null = null;
  private ping: ReturnType<typeof setInterval> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private reconnect: ReturnType<typeof setTimeout> | null = null;
  private ignoreClose = false;
  private backoffMs = MIN_BACKOFF_MS;
  private stopped = false;
  private subscribed = new Set<string>();
  private tokenSignature = "";
  private connectDelay: ReturnType<typeof setTimeout> | null = null;
  lastMessageAt = 0;
  messages = 0;

  constructor(
    readonly index: number,
    private tokens: string[],
    private readonly handlers: ShardHandlers
  ) {}

  get tokenIds() {
    return this.tokens;
  }

  isLive() {
    return this.ws?.readyState === WebSocket.OPEN && Date.now() - this.lastMessageAt < STALE_MS;
  }

  connected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  setTokens(tokens: string[]) {
    this.tokens = tokens;
    const signature = tokens.join(",");
    if (!tokens.length) {
      this.tokenSignature = "";
      this.subscribed.clear();
      this.killSocket();
      return;
    }
    if (this.ws?.readyState === WebSocket.OPEN) {
      // Never kill from setTokens — watchdog handles silence. Sync thrashing
      // was reconnect-looping every catalog refresh and leaving WSS DOWN.
      if (signature === this.tokenSignature && this.subscribed.size) return;
      this.patchSubscription(tokens, signature);
      return;
    }
    if (this.ws?.readyState === WebSocket.CONNECTING) {
      this.tokenSignature = signature;
      return;
    }
    if (this.reconnect) {
      // Pending reconnect will pick up this.tokens.
      this.tokenSignature = signature;
      return;
    }
    this.tokenSignature = signature;
    this.scheduleConnect(tokens);
  }

  stop() {
    this.stopped = true;
    if (this.reconnect) clearTimeout(this.reconnect);
    this.reconnect = null;
    if (this.connectDelay) clearTimeout(this.connectDelay);
    this.connectDelay = null;
    this.killSocket();
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

  /** Spread opens across shards so we don't open dozens of sockets in one tick. */
  private scheduleConnect(tokens: string[]) {
    if (this.connectDelay) clearTimeout(this.connectDelay);
    const delay = this.index * SHARD_CONNECT_STAGGER_MS;
    this.connectDelay = setTimeout(() => {
      this.connectDelay = null;
      this.connect(tokens);
    }, delay);
  }

  private connect(tokens: string[]) {
    if (this.stopped) return;
    if (this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING) return;

    const ws = new WebSocket(URL);
    this.ws = ws;
    this.ignoreClose = false;

    ws.on("open", () => {
      this.backoffMs = MIN_BACKOFF_MS;
      this.lastMessageAt = Date.now();
      const live = this.tokens.length ? this.tokens : tokens;
      this.subscribed = new Set(live);
      this.tokenSignature = live.join(",");
      if (live.length) ws.send(subscribePayload(live));
      this.startHeartbeat(ws);
      this.handlers.onLog?.(`WSS#${this.index} up (${live.length} tok)`);
      this.handlers.onConnected?.(live);
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
          this.handlers.onMessage(event as BookEvent | PriceChangeEvent | BestBidAskEvent);
        }
      } catch (error) {
        this.handlers.onLog?.(error instanceof Error ? error.message : String(error));
      }
    });

    ws.on("pong", () => {
      this.lastMessageAt = Date.now();
    });

    ws.on("error", (error) => {
      if (this.ignoreClose) return;
      const msg = error.message;
      if (/closed before the connection was established/i.test(msg)) {
        this.scheduleReconnect("connect aborted");
        return;
      }
      this.handlers.onLog?.(`WSS#${this.index} error: ${msg}`);
      this.scheduleReconnect("error");
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
    this.handlers.onLog?.(`WSS#${this.index} ${reason}, reconnecting`);
    this.killSocket();
    const delay = this.backoffMs + this.index * 15; // slight jitter per shard
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    this.reconnect = setTimeout(() => {
      this.reconnect = null;
      this.connect(this.tokens);
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
}

export class OrderbookStream {
  private shards: MarketShard[] = [];
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private restFallbackTimer: ReturnType<typeof setInterval> | null = null;
  private restFallbackCursor = 0;
  private stopped = false;
  private readonly lastBookSig = new Map<string, string>();
  private readonly tokenMeta = new Map<string, MonitoredToken>();
  private readonly bookCache = new Map<string, ParsedBook>();
  private readonly bookFetchAt = new Map<string, number>();
  private readonly quotes = new Map<string, TokenQuote>();
  private bookEvents = 0;
  private snapshotsWritten = 0;
  private restInflight = 0;
  private readonly resyncQueue: string[] = [];
  private resyncTimer: ReturnType<typeof setInterval> | null = null;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private wssDeadSince: number | null = null;

  constructor(
    private readonly getTokens: () => MonitoredToken[],
    private readonly store: Pick<MonitorHub, "recordSnapshot" | "getTokenMeta">,
    private readonly onEvent?: (message: string) => void
  ) {
    this.restFallbackTimer = setInterval(() => this.restFallbackTick(), REST_FALLBACK_MS);
    this.resyncTimer = setInterval(() => this.drainResyncQueue(), 200);
    this.healthTimer = setInterval(() => this.healthTick(), 3_000);
  }

  getStats(): StreamStats {
    const liveShards = this.shards.filter((s) => s.isLive()).length;
    const openShards = this.shards.filter((s) => s.connected()).length;
    const connected = openShards > 0;
    const lastMessageAt = this.shards.reduce((max, s) => Math.max(max, s.lastMessageAt), 0);
    const messages = this.shards.reduce((sum, s) => sum + s.messages, 0);
    const stale = connected && Date.now() - lastMessageAt >= STALE_MS;
    return {
      connected,
      stale,
      messages,
      bookEvents: this.bookEvents,
      snapshotsWritten: this.snapshotsWritten,
      sampleWrites: 0,
      lastMessageAt: lastMessageAt || null,
      quotes: new Map(this.quotes),
      shards: this.shards.length,
      liveShards,
    };
  }

  isLive() {
    return this.shards.some((s) => s.isLive());
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
    if (this.restFallbackTimer) clearInterval(this.restFallbackTimer);
    this.restFallbackTimer = null;
    if (this.resyncTimer) clearInterval(this.resyncTimer);
    this.resyncTimer = null;
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
    this.resyncQueue.length = 0;
    for (const shard of this.shards) shard.stop();
    this.shards = [];
  }

  /** Tear down dead sockets and rebuild — catalog sync alone was leaving WSS DOWN for minutes. */
  private healthTick() {
    if (this.stopped) return;
    const tokens = this.getTokens();
    if (!tokens.length) {
      this.wssDeadSince = null;
      return;
    }
    const live = this.shards.some((s) => s.isLive());
    if (live) {
      this.wssDeadSince = null;
      return;
    }
    const now = Date.now();
    if (this.wssDeadSince == null) {
      this.wssDeadSince = now;
      return;
    }
    if (now - this.wssDeadSince < WSS_DEAD_REBUILD_MS) return;
    const deadFor = Math.round((now - this.wssDeadSince) / 1000);
    this.wssDeadSince = now;
    this.onEvent?.(`WSS dead ${deadFor}s — rebuilding ${this.shards.length} shards`);
    for (const shard of this.shards) shard.stop();
    this.shards = [];
    this.syncNow();
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
    if (!ids.length) {
      for (const shard of this.shards) shard.stop();
      this.shards = [];
      return;
    }

    const groups = chunkIds(ids, MAX_ASSETS_PER_WS);
    while (this.shards.length > groups.length) {
      this.shards.pop()?.stop();
    }
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i]!;
      let shard = this.shards[i];
      if (!shard) {
        shard = new MarketShard(i, group, {
          onMessage: (event) => this.apply(event),
          onConnected: (tokenIds) => this.queueShardResync(tokenIds),
          onLog: this.onEvent,
        });
        this.shards.push(shard);
      }
      shard.setTokens(group);
    }

    if (groups.length !== this.shards.length) {
      this.onEvent?.(
        `WSS sharded ${ids.length} tokens → ${groups.length} sockets (≤${MAX_ASSETS_PER_WS}/ea)`
      );
    }
  }

  /** Drop stale local books and REST-seed after every socket (re)connect. */
  private queueShardResync(tokenIds: string[]) {
    for (const id of tokenIds) {
      this.bookCache.delete(id);
      if (!this.resyncQueue.includes(id)) this.resyncQueue.push(id);
    }
  }

  private drainResyncQueue() {
    if (this.stopped) return;
    while (this.restInflight < RESYNC_CONCURRENCY && this.resyncQueue.length) {
      const tokenId = this.resyncQueue.shift()!;
      this.maybeRefreshRest(tokenId, true);
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
    const res = await polyFetch(
      `${CLOB_BOOK}?token_id=${encodeURIComponent(tokenId)}`,
      REST_BOOK_TIMEOUT_MS
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { bids?: Level[]; asks?: Level[] };
    return {
      bids: parseLevels(body.bids ?? []),
      asks: parseLevels(body.asks ?? []),
    };
  }

  /**
   * REST `/book` is the authoritative full ladder. Prefer it over a fat WSS cache —
   * settlement books are often one-sided/thin (0.1¢ ask, no bids); level-count
   * preference used to keep the stale mid-game WSS book forever.
   */
  private pickBook(wss: ParsedBook, rest: ParsedBook | null) {
    if (!rest) return uncrossBook(wss.bids, wss.asks);
    const wssBook = uncrossBook(wss.bids, wss.asks);
    const restBook = uncrossBook(rest.bids, rest.asks);
    const wssBad = isCrossed(wss);
    const restBad = isCrossed(rest);
    if (restBad && !wssBad) return wssBook;
    return restBook;
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
    this.restInflight++;
    void this.fetchFullBook(tokenId)
      .then((rest) => {
        if (!rest) return;
        const wss = this.bookCache.get(tokenId) ?? cached;
        const picked = wss ? this.pickBook(wss, rest) : uncrossBook(rest.bids, rest.asks);
        this.bookCache.set(tokenId, picked);
        this.recordIfChanged(tokenId, picked.bids, picked.asks);
      })
      .catch((err) => {
        if (Math.random() < 0.02) {
          this.onEvent?.(
            `REST book fail: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      })
      .finally(() => {
        this.restInflight = Math.max(0, this.restInflight - 1);
      });
  }

  /** Keep recording when shards flap — Polymarket books still move on REST. */
  private restFallbackTick() {
    if (this.stopped) return;
    const tokens = this.getTokens();
    if (!tokens.length) return;
    const now = Date.now();
    const wssLive = this.shards.some((s) => s.isLive());
    const concurrency = wssLive ? REST_FALLBACK_CONCURRENCY : REST_FALLBACK_CONCURRENCY * 2;
    const staleMs = wssLive ? REST_STALE_TOKEN_MS : 1_500;
    const slots = Math.max(0, concurrency - this.restInflight);
    if (!slots) return;

    const stale: { id: string; age: number }[] = [];
    for (const row of tokens) {
      const q = this.quotes.get(row.tokenId);
      const age = q?.lastBookAt != null ? now - q.lastBookAt : Infinity;
      if (age >= staleMs) stale.push({ id: row.tokenId, age });
    }
    if (!stale.length) return;
    // Oldest books first so one hot token can't starve the rest.
    stale.sort((a, b) => b.age - a.age);

    for (let i = 0; i < slots && i < stale.length; i++) {
      const idx = (this.restFallbackCursor + i) % stale.length;
      this.maybeRefreshRest(stale[idx]!.id, true);
    }
    this.restFallbackCursor = (this.restFallbackCursor + slots) % Math.max(1, stale.length);
  }

  private writeSnapshot(tokenId: string, bids: BookLevel[], asks: BookLevel[]) {
    if (!this.getTokens().some((row) => row.tokenId === tokenId)) {
      this.bookCache.delete(tokenId);
      return;
    }
    const meta = this.tokenMeta.get(tokenId) ?? this.store.getTokenMeta(tokenId);
    if (!meta) {
      this.onEvent?.(`snap drop: no meta ${tokenId.slice(0, 12)}…`);
      return;
    }
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
    try {
      this.store.recordSnapshot(snap);
    } catch (err) {
      this.onEvent?.(
        `snap write fail: ${err instanceof Error ? err.message : String(err)}`
      );
      return;
    }
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
      this.maybeRefreshRest(event.asset_id, true);
    }
  }
}

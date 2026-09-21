import WebSocket from "ws";
import { bestOf, depthSum, normalizeBookSide, parseLevels } from "../db/store.ts";
import type { MonitorHub } from "../db/store.ts";
import type { BookLevel, BookSnapshot, MonitoredToken } from "../types/monitoring.ts";

const URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const PING_MS = 5_000;
/** Quiet books still get PING/PONG — allow long gaps between price messages. */
const STALE_MS = 45_000;
/** How often we check for silence. */
const WATCH_MS = 3_000;
/** Grace after socket open before stale watchdog can kill (initial_dump lag). */
const OPEN_GRACE_MS = 20_000;
/** Abort hung TCP/TLS handshakes — otherwise shards stick in CONNECTING forever. */
const CONNECT_TIMEOUT_MS = 30_000;
/** First reconnect attempt — keep gaps short. */
const MIN_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 30_000;
/** Stagger shard connects so Polymarket doesn't refuse a burst. */
const SHARD_CONNECT_STAGGER_MS = 800;
/** Keep sockets small — large asset lists die quietly. */
const MAX_ASSETS_PER_WS = 40;
/** Full shard rebuild only after sustained death — don't thrash mid-reconnect. */
const WSS_DEAD_REBUILD_MS = 300_000;
/** Hard cap on concurrent market sockets — past ~4 Polymarket gets flaky here. */
const MAX_SHARDS = 3;

/** Only one TCP/TLS handshake at a time — parallel connects time out on Windows. */
let connectChain: Promise<void> = Promise.resolve();
function enqueueConnect(start: () => Promise<void>): Promise<void> {
  const next = connectChain.then(() => start()).catch(() => {});
  connectChain = next;
  return next;
}
function resetConnectQueue() {
  connectChain = Promise.resolve();
}

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
  private connectTimeout: ReturnType<typeof setTimeout> | null = null;
  private ignoreClose = false;
  private backoffMs = MIN_BACKOFF_MS;
  private stopped = false;
  private subscribed = new Set<string>();
  private tokenSignature = "";
  private connectDelay: ReturnType<typeof setTimeout> | null = null;
  private openAt = 0;
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

  isReconnecting() {
    return this.reconnect != null || this.connectDelay != null || this.ws?.readyState === WebSocket.CONNECTING;
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
    if (this.connectTimeout) clearTimeout(this.connectTimeout);
    this.connectTimeout = null;
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

  /** Serialize handshakes so only one shard is CONNECTING at a time. */
  private scheduleConnect(tokens: string[]) {
    if (this.connectDelay) clearTimeout(this.connectDelay);
    // Small stagger only for the queue order — real waiting is in enqueueConnect.
    const delay = this.index * 50;
    this.connectDelay = setTimeout(() => {
      this.connectDelay = null;
      void enqueueConnect(() => this.connectAwait(tokens));
    }, delay);
  }

  /** Open socket and resolve only after open / fail / timeout. */
  private connectAwait(tokens: string[]): Promise<void> {
    return new Promise((resolve) => {
      if (this.stopped) {
        resolve();
        return;
      }
      if (this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING) {
        resolve();
        return;
      }
      if (!tokens.length && !this.tokens.length) {
        resolve();
        return;
      }

      const ws = new WebSocket(URL);
      this.ws = ws;
      this.ignoreClose = false;
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };

      if (this.connectTimeout) clearTimeout(this.connectTimeout);
      this.connectTimeout = setTimeout(() => {
        this.connectTimeout = null;
        if (this.ws !== ws) {
          done();
          return;
        }
        if (ws.readyState === WebSocket.OPEN) {
          done();
          return;
        }
        this.handlers.onLog?.(`WSS#${this.index} connect timeout`);
        this.scheduleReconnect("connect timeout");
        done();
      }, CONNECT_TIMEOUT_MS);

      ws.on("open", () => {
        if (this.connectTimeout) {
          clearTimeout(this.connectTimeout);
          this.connectTimeout = null;
        }
        this.backoffMs = MIN_BACKOFF_MS;
        this.openAt = Date.now();
        this.lastMessageAt = Date.now();
        const live = this.tokens.length ? this.tokens : tokens;
        this.subscribed = new Set(live);
        this.tokenSignature = live.join(",");
        if (live.length) ws.send(subscribePayload(live));
        this.startHeartbeat(ws);
        this.handlers.onLog?.(`WSS#${this.index} up (${live.length} tok)`);
        this.handlers.onConnected?.(live);
        done();
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
          done();
          return;
        }
        this.handlers.onLog?.(`WSS#${this.index} error: ${msg}`);
        this.scheduleReconnect("error");
        done();
      });

      ws.on("close", () => {
        if (this.ws !== ws) {
          done();
          return;
        }
        this.ws = null;
        if (this.connectTimeout) {
          clearTimeout(this.connectTimeout);
          this.connectTimeout = null;
        }
        this.stopHeartbeat();
        if (this.stopped || this.ignoreClose) {
          done();
          return;
        }
        this.scheduleReconnect("closed");
        done();
      });
    });
  }

  private connect(_tokens: string[]) {
    // Prefer scheduleConnect / enqueueConnect — kept for rare direct calls.
    void enqueueConnect(() => this.connectAwait(this.tokens.length ? this.tokens : _tokens));
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
      // Give initial_dump time before declaring the socket dead.
      if (Date.now() - this.openAt < OPEN_GRACE_MS) return;
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
      void enqueueConnect(() => this.connectAwait(this.tokens));
    }, delay);
  }

  private killSocket() {
    this.stopHeartbeat();
    if (this.connectTimeout) {
      clearTimeout(this.connectTimeout);
      this.connectTimeout = null;
    }
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
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.terminate();
      } else {
        ws.close();
      }
    } catch {
      /* ignore */
    }
  }
}

export class OrderbookStream {
  private shards: MarketShard[] = [];
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private readonly lastBookSig = new Map<string, string>();
  private readonly tokenMeta = new Map<string, MonitoredToken>();
  private readonly bookCache = new Map<string, ParsedBook>();
  private readonly quotes = new Map<string, TokenQuote>();
  private bookEvents = 0;
  private snapshotsWritten = 0;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private wssDeadSince: number | null = null;

  constructor(
    private readonly getTokens: () => MonitoredToken[],
    private readonly store: Pick<MonitorHub, "recordSnapshot" | "getTokenMeta">,
    private readonly onEvent?: (message: string) => void
  ) {
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
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
    for (const shard of this.shards) shard.stop();
    this.shards = [];
  }

  /** Rebuild only when sockets are truly gone — not on quiet books or reconnect backoff. */
  private healthTick() {
    if (this.stopped) return;
    const tokens = this.getTokens();
    if (!tokens.length) {
      this.wssDeadSince = null;
      return;
    }
    if (!this.shards.length) {
      this.syncNow();
      return;
    }
    const live = this.shards.some((s) => s.isLive());
    if (live) {
      this.wssDeadSince = null;
      return;
    }
    const now = Date.now();
    // Open sockets that still exchange PING/PONG count as healthy even if books are quiet.
    if (this.shards.some((s) => s.connected())) {
      this.wssDeadSince = null;
      return;
    }
    // Let per-shard reconnect + connect-timeout work. Full rebuild only if every
    // shard has stopped retrying, or death has lasted long enough to unstick.
    const retrying = this.shards.some((s) => s.isReconnecting());
    this.wssDeadSince = this.wssDeadSince ?? now;
    const deadForMs = now - this.wssDeadSince;
    if (retrying && deadForMs < WSS_DEAD_REBUILD_MS) return;
    if (!retrying && deadForMs < 15_000) {
      // Nudge idle shards that somehow dropped timers without scheduling reconnect.
      for (const shard of this.shards) {
        if (!shard.connected() && !shard.isReconnecting()) {
          shard.setTokens(shard.tokenIds);
        }
      }
      return;
    }
    if (deadForMs < WSS_DEAD_REBUILD_MS) return;
    const deadFor = Math.round(deadForMs / 1000);
    this.wssDeadSince = now;
    this.onEvent?.(`WSS dead ${deadFor}s — rebuilding ${this.shards.length} shards`);
    for (const shard of this.shards) shard.stop();
    this.shards = [];
    resetConnectQueue();
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

    const ids = [...active].sort();
    if (!ids.length) {
      for (const shard of this.shards) shard.stop();
      this.shards = [];
      return;
    }

    const capped = ids.slice(0, MAX_SHARDS * MAX_ASSETS_PER_WS);
    if (capped.length < ids.length) {
      this.onEvent?.(
        `WSS cap ${ids.length}→${capped.length} tokens (≤${MAX_SHARDS} sockets)`
      );
    }
    const groups = chunkIds(capped, MAX_ASSETS_PER_WS);
    while (this.shards.length > groups.length) {
      this.shards.pop()?.stop();
    }
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i]!;
      let shard = this.shards[i];
      if (!shard) {
        shard = new MarketShard(i, group, {
          onMessage: (event) => this.apply(event),
          onConnected: (tokenIds) => this.clearBooksForReconnect(tokenIds),
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

  /** Drop local books on (re)connect — wait for WSS initial_dump, never REST. */
  private clearBooksForReconnect(tokenIds: string[]) {
    for (const id of tokenIds) {
      this.bookCache.delete(id);
      this.lastBookSig.delete(id);
    }
  }

  /** Write only when the book actually changed. No timers, no activity tiers. */
  private recordIfChanged(tokenId: string, bids: BookLevel[], asks: BookLevel[]) {
    const sig = bookSignature(bids, asks);
    if (this.lastBookSig.get(tokenId) === sig) return;
    this.lastBookSig.set(tokenId, sig);
    this.writeSnapshot(tokenId, bids, asks);
  }

  private queueBookWrite(tokenId: string, bids: BookLevel[], asks: BookLevel[]) {
    const book = uncrossBook(bids, asks);
    this.bookCache.set(tokenId, book);
    this.recordIfChanged(tokenId, book.bids, book.asks);
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
        // No seed yet — wait for WSS `book` / initial_dump.
        if (!cached) continue;
        const next = applyPriceChange(cached, change);
        this.bookCache.set(change.asset_id, next);
        this.recordIfChanged(change.asset_id, next.bids, next.asks);
      }
      return;
    }

    if (event.event_type === "best_bid_ask") {
      const cached = this.bookCache.get(event.asset_id);
      if (!cached) return;
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
    }
  }
}

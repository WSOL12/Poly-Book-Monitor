import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DB_PATH } from "../config/env.ts";
import type { BookLevel, BookSnapshot, MonitoredEvent, MonitoredToken, MonitorSport } from "../types/monitoring.ts";

export function openDb(readonly = false) {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH, { readonly, fileMustExist: readonly });
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  // Keep the WAL from growing without bound (pages ≈ 4KB; 1000 ≈ 4MB between auto-checkpoints).
  db.pragma("wal_autocheckpoint = 1000");
  // After a successful checkpoint, truncate WAL back under this size (256 MiB).
  db.pragma("journal_size_limit = 268435456");
  if (!readonly) {
    db.pragma("busy_timeout = 5000");
  }
  return db;
}

/** Flush WAL into the main DB file. TRUNCATE shrinks monitoring.db-wal on disk. */
export function checkpointDb(db: Database.Database, mode: "PASSIVE" | "TRUNCATE" = "PASSIVE") {
  try {
    db.pragma(`wal_checkpoint(${mode})`);
  } catch {
    // Readers may block TRUNCATE; PASSIVE is best-effort.
  }
}

export function initSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      event_id TEXT PRIMARY KEY,
      sport TEXT NOT NULL,
      title TEXT NOT NULL,
      slug TEXT NOT NULL,
      start_time TEXT,
      event_date TEXT,
      ended INTEGER NOT NULL DEFAULT 0,
      poly_live INTEGER NOT NULL DEFAULT 0,
      closed INTEGER NOT NULL DEFAULT 0,
      game_status TEXT,
      finished_at INTEGER,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS markets (
      market_id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      sport TEXT NOT NULL,
      market_type TEXT NOT NULL,
      question TEXT NOT NULL,
      line TEXT,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tokens (
      token_id TEXT PRIMARY KEY,
      market_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      sport TEXT NOT NULL,
      market_type TEXT NOT NULL,
      side TEXT NOT NULL,
      label TEXT NOT NULL,
      line TEXT,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS book_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      sport TEXT NOT NULL,
      captured_at INTEGER NOT NULL,
      best_bid REAL,
      best_ask REAL,
      bid_depth REAL NOT NULL DEFAULT 0,
      ask_depth REAL NOT NULL DEFAULT 0,
      bids_json TEXT NOT NULL DEFAULT '[]',
      asks_json TEXT NOT NULL DEFAULT '[]',
      source TEXT NOT NULL DEFAULT 'wss'
    );

    CREATE INDEX IF NOT EXISTS idx_snapshots_token_time ON book_snapshots(token_id, captured_at);
    CREATE INDEX IF NOT EXISTS idx_snapshots_event_time ON book_snapshots(event_id, captured_at);
    CREATE INDEX IF NOT EXISTS idx_snapshots_captured_at ON book_snapshots(captured_at);
    CREATE INDEX IF NOT EXISTS idx_tokens_event ON tokens(event_id);
    CREATE INDEX IF NOT EXISTS idx_markets_event ON markets(event_id);

    CREATE TABLE IF NOT EXISTS score_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL,
      captured_at INTEGER NOT NULL,
      score TEXT,
      period TEXT,
      elapsed TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_score_event_time ON score_snapshots(event_id, captured_at);
  `);

  const eventCols = db.prepare(`PRAGMA table_info(events)`).all() as Array<{ name: string }>;
  const names = new Set(eventCols.map((c) => c.name));
  if (!names.has("ended")) db.exec(`ALTER TABLE events ADD COLUMN ended INTEGER NOT NULL DEFAULT 0`);
  if (!names.has("poly_live")) db.exec(`ALTER TABLE events ADD COLUMN poly_live INTEGER NOT NULL DEFAULT 0`);
  if (!names.has("closed")) db.exec(`ALTER TABLE events ADD COLUMN closed INTEGER NOT NULL DEFAULT 0`);
  if (!names.has("game_status")) db.exec(`ALTER TABLE events ADD COLUMN game_status TEXT`);
  if (!names.has("finished_at")) db.exec(`ALTER TABLE events ADD COLUMN finished_at INTEGER`);
  if (!names.has("armed")) db.exec(`ALTER TABLE events ADD COLUMN armed INTEGER NOT NULL DEFAULT 0`);
  if (!names.has("league")) db.exec(`ALTER TABLE events ADD COLUMN league TEXT`);
  if (!names.has("volume")) db.exec(`ALTER TABLE events ADD COLUMN volume REAL`);
  const marketCols = db.prepare(`PRAGMA table_info(markets)`).all() as Array<{ name: string }>;
  const marketNames = new Set(marketCols.map((c) => c.name));
  if (!marketNames.has("volume")) db.exec(`ALTER TABLE markets ADD COLUMN volume REAL`);
}

export type PolyEventStatus = {
  eventId: string;
  ended: boolean;
  polyLive: boolean;
  closed: boolean;
  gameStatus: string | null;
  finishedAt: number | null;
  score?: string | null;
  period?: string | null;
  elapsed?: string | null;
};

export class MonitorStore {
  private readonly upsertEvent;
  private readonly upsertMarket;
  private readonly upsertToken;
  private readonly insertSnapshot;
  private readonly updatePolyStatus;
  private readonly lastScore;
  private readonly insertScore;

  constructor(private readonly db: Database.Database) {
    initSchema(db);
    this.upsertEvent = db.prepare(`
      INSERT INTO events (
        event_id, sport, title, slug, start_time, event_date,
        ended, poly_live, closed, game_status, finished_at, updated_at
      )
      VALUES (
        @eventId, @sport, @title, @slug, @startTime, @eventDate,
        @ended, @polyLive, @closed, @gameStatus, @finishedAt, @updatedAt
      )
      ON CONFLICT(event_id) DO UPDATE SET
        sport = excluded.sport,
        title = excluded.title,
        slug = excluded.slug,
        start_time = excluded.start_time,
        event_date = excluded.event_date,
        ended = CASE WHEN events.ended = 1 OR events.closed = 1 THEN 1 ELSE excluded.ended END,
        poly_live = CASE WHEN events.ended = 1 OR events.closed = 1 OR excluded.ended = 1 THEN 0 ELSE excluded.poly_live END,
        closed = CASE WHEN events.closed = 1 THEN 1 ELSE excluded.closed END,
        game_status = COALESCE(excluded.game_status, events.game_status),
        finished_at = COALESCE(events.finished_at, excluded.finished_at),
        updated_at = excluded.updated_at
    `);
    this.upsertMarket = db.prepare(`
      INSERT INTO markets (market_id, event_id, sport, market_type, question, line, updated_at)
      VALUES (@marketId, @eventId, @sport, @marketType, @question, @line, @updatedAt)
      ON CONFLICT(market_id) DO UPDATE SET
        question = excluded.question,
        line = excluded.line,
        updated_at = excluded.updated_at
    `);
    this.upsertToken = db.prepare(`
      INSERT INTO tokens (token_id, market_id, event_id, sport, market_type, side, label, line, updated_at)
      VALUES (@tokenId, @marketId, @eventId, @sport, @marketType, @side, @label, @line, @updatedAt)
      ON CONFLICT(token_id) DO UPDATE SET
        market_id = excluded.market_id,
        event_id = excluded.event_id,
        sport = excluded.sport,
        market_type = excluded.market_type,
        side = excluded.side,
        label = excluded.label,
        line = excluded.line,
        updated_at = excluded.updated_at
    `);
    this.insertSnapshot = db.prepare(`
      INSERT INTO book_snapshots (
        token_id, event_id, sport, captured_at, best_bid, best_ask,
        bid_depth, ask_depth, bids_json, asks_json, source
      ) VALUES (
        @tokenId, @eventId, @sport, @capturedAt, @bestBid, @bestAsk,
        @bidDepth, @askDepth, @bidsJson, @asksJson, @source
      )
    `);
    this.updatePolyStatus = db.prepare(`
      UPDATE events
      SET ended = @ended,
          poly_live = @polyLive,
          closed = @closed,
          game_status = @gameStatus,
          finished_at = CASE
            WHEN @ended = 1 OR @closed = 1 THEN COALESCE(@finishedAt, finished_at)
            ELSE finished_at
          END,
          updated_at = @updatedAt
      WHERE event_id = @eventId
    `);
    this.lastScore = db.prepare(`
      SELECT score, period, elapsed FROM score_snapshots
      WHERE event_id = @eventId ORDER BY captured_at DESC LIMIT 1
    `);
    this.insertScore = db.prepare(`
      INSERT INTO score_snapshots (event_id, captured_at, score, period, elapsed)
      VALUES (@eventId, @capturedAt, @score, @period, @elapsed)
    `);
  }

  syncCatalog(events: MonitoredEvent[]) {
    const now = Date.now();
    const tx = this.db.transaction(() => {
      for (const event of events) {
        this.upsertEvent.run({
          eventId: event.eventId,
          sport: event.sport,
          title: event.title,
          slug: event.slug,
          startTime: event.startTime,
          eventDate: event.eventDate,
          ended: event.ended ? 1 : 0,
          polyLive: event.polyLive ? 1 : 0,
          closed: event.closed ? 1 : 0,
          gameStatus: event.gameStatus,
          finishedAt: event.finishedAt,
          updatedAt: now,
        });
        for (const market of event.markets) {
          this.upsertMarket.run({
            marketId: market.marketId,
            eventId: event.eventId,
            sport: market.sport,
            marketType: market.marketType,
            question: market.question,
            line: market.line,
            updatedAt: now,
          });
          for (const row of market.tokens) {
            this.upsertToken.run({
              tokenId: row.tokenId,
              marketId: row.marketId,
              eventId: row.eventId,
              sport: row.sport,
              marketType: row.marketType,
              side: row.side,
              label: row.label,
              line: row.line,
              updatedAt: now,
            });
          }
        }
      }
    });
    tx();
  }

  listEventIds() {
    return (this.db.prepare(`SELECT event_id AS eventId FROM events`).all() as Array<{ eventId: string }>).map(
      (row) => row.eventId
    );
  }

  getEventSport(eventId: string): MonitorSport | null {
    const row = this.db.prepare(`SELECT sport FROM events WHERE event_id = ?`).get(eventId) as
      | { sport: MonitorSport }
      | undefined;
    return row?.sport ?? null;
  }

  isArmed(eventId: string) {
    const row = this.db.prepare(`SELECT armed FROM events WHERE event_id = ?`).get(eventId) as
      | { armed: number }
      | undefined;
    return row?.armed === 1;
  }

  armEvent(eventId: string) {
    this.db
      .prepare(`UPDATE events SET armed = 1, updated_at = ? WHERE event_id = ? AND armed = 0`)
      .run(Date.now(), eventId);
  }

  listArmedEventIds() {
    return (
      this.db.prepare(`SELECT event_id AS eventId FROM events WHERE armed = 1`).all() as Array<{ eventId: string }>
    ).map((row) => row.eventId);
  }

  /**
   * Sticky-arm weather we already recorded. The 60¢ gate must not unsubscribe
   * a market mid-flight just because the favorite later dipped below 60¢, or
   * because `armed` defaulted to 0 after a schema/code change.
   */
  armWeatherThatAlreadyHasBooks() {
    const ids = this.db
      .prepare(`SELECT event_id AS eventId FROM events WHERE sport = 'weather' AND armed = 0`)
      .all() as Array<{ eventId: string }>;
    if (!ids.length) return 0;
    const hasBook = this.db.prepare(`SELECT 1 AS ok FROM book_snapshots WHERE event_id = ? LIMIT 1`);
    let n = 0;
    const tx = this.db.transaction(() => {
      for (const { eventId } of ids) {
        if (!hasBook.get(eventId)) continue;
        this.armEvent(eventId);
        n++;
      }
    });
    tx();
    return n;
  }

  /** Mark events that left the live catalog as finished so UI/recording stop. */
  markEventsFinished(eventIds: string[], finishedAt = Date.now()) {
    if (!eventIds.length) return;
    const stmt = this.db.prepare(`
      UPDATE events
      SET ended = 1,
          poly_live = 0,
          finished_at = COALESCE(finished_at, @finishedAt),
          updated_at = @updatedAt
      WHERE event_id = @eventId AND ended = 0 AND closed = 0
    `);
    const now = Date.now();
    const tx = this.db.transaction(() => {
      for (const eventId of eventIds) {
        stmt.run({ eventId, finishedAt, updatedAt: now });
      }
    });
    tx();
  }

  updatePolyStatuses(rows: PolyEventStatus[]) {
    const now = Date.now();
    const tx = this.db.transaction(() => {
      for (const row of rows) {
        const finished = row.ended || row.closed;
        this.updatePolyStatus.run({
          eventId: row.eventId,
          ended: row.ended ? 1 : 0,
          polyLive: row.polyLive ? 1 : 0,
          closed: row.closed ? 1 : 0,
          gameStatus: row.gameStatus,
          finishedAt: finished ? row.finishedAt : null,
          updatedAt: now,
        });
        const score = row.score?.trim() || null;
        const period = row.period?.trim() || null;
        const elapsed = row.elapsed?.trim() || null;
        if (!score && !period && !elapsed) continue;
        const prev = this.lastScore.get({ eventId: row.eventId }) as
          | { score: string | null; period: string | null; elapsed: string | null }
          | undefined;
        if (prev && prev.score === score && prev.period === period && prev.elapsed === elapsed) continue;
        this.insertScore.run({ eventId: row.eventId, capturedAt: now, score, period, elapsed });
      }
    });
    tx();
  }

  recordSnapshot(snap: BookSnapshot) {
    this.insertSnapshot.run({
      tokenId: snap.tokenId,
      eventId: snap.eventId,
      sport: snap.sport,
      capturedAt: snap.capturedAt,
      bestBid: snap.bestBid,
      bestAsk: snap.bestAsk,
      bidDepth: snap.bidDepth,
      askDepth: snap.askDepth,
      bidsJson: JSON.stringify(snap.bids),
      asksJson: JSON.stringify(snap.asks),
      source: snap.source,
    });
  }

  getTokenMeta(tokenId: string): MonitoredToken | null {
    const row = this.db
      .prepare(
        `SELECT token_id AS tokenId, market_id AS marketId, event_id AS eventId, sport,
                market_type AS marketType, side, label, line
         FROM tokens WHERE token_id = ?`
      )
      .get(tokenId) as MonitoredToken | undefined;
    return row ?? null;
  }

  stats() {
    const events = (this.db.prepare(`SELECT COUNT(*) AS n FROM events`).get() as { n: number }).n;
    const tokens = (this.db.prepare(`SELECT COUNT(*) AS n FROM tokens`).get() as { n: number }).n;
    const snapshots = (this.db.prepare(`SELECT COUNT(*) AS n FROM book_snapshots`).get() as { n: number }).n;
    return { events, tokens, snapshots };
  }
}

export function parseLevels(raw: Array<{ price?: string | number; size?: string | number }>): BookLevel[] {
  const out: BookLevel[] = [];
  for (const row of raw) {
    const price = Number(row.price);
    const size = Number(row.size);
    if (!Number.isFinite(price) || !Number.isFinite(size) || size <= 0) continue;
    out.push({ price, size });
  }
  return out;
}

export function bestOf(levels: BookLevel[], side: "bid" | "ask"): number | null {
  let best: number | null = null;
  for (const level of levels) {
    if (best == null || (side === "bid" ? level.price > best : level.price < best)) best = level.price;
  }
  return best;
}

export function depthSum(levels: BookLevel[]) {
  return levels.reduce((sum, level) => sum + level.size, 0);
}

/** Store full book: bids best-first, asks best-first. */
export function normalizeBookSide(levels: BookLevel[], side: "bid" | "ask") {
  return [...levels].sort((a, b) => (side === "bid" ? b.price - a.price : a.price - b.price));
}

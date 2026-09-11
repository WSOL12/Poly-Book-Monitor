import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { fetchEventsByIds, finishedAtFromGamma, isFinishedGammaEvent } from "./gamma";
import { DB_PATH } from "./paths";

export type Sport = "soccer" | "football" | "mlb" | "weather";

export type OverviewStats = {
  dbPath: string;
  exists: boolean;
  events: number;
  tokens: number;
  snapshots: number;
  bySport: Array<{ sport: Sport; events: number; tokens: number }>;
};

export type EventRow = {
  eventId: string;
  sport: Sport;
  title: string;
  slug: string;
  startTime: string | null;
  eventDate: string | null;
  ended: boolean;
  polyLive: boolean;
  closed: boolean;
  gameStatus: string | null;
  finishedAt: number | null;
  marketCount: number;
  tokenCount: number;
  lastSnapshotAt: number | null;
};

export type MarketRow = {
  marketId: string;
  marketType: "moneyline" | "total" | "weather";
  question: string;
  line: string | null;
  tokens: TokenRow[];
};

export type TokenRow = {
  tokenId: string;
  side: string;
  label: string;
  line: string | null;
  lastBid: number | null;
  lastAsk: number | null;
  lastAt: number | null;
};

export type SnapshotRow = {
  id: number;
  capturedAt: number;
  bestBid: number | null;
  bestAsk: number | null;
  bidDepth: number;
  askDepth: number;
  bids: Array<{ price: number; size: number }>;
  asks: Array<{ price: number; size: number }>;
};

export type ScoreSnapshotRow = {
  capturedAt: number;
  score: string | null;
  period: string | null;
  elapsed: string | null;
};

function ensureDbSchema() {
  if (!existsSync(DB_PATH)) return;
  const db = new Database(DB_PATH);
  try {
    const cols = db.prepare(`PRAGMA table_info(events)`).all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    if (!names.has("ended")) db.exec(`ALTER TABLE events ADD COLUMN ended INTEGER NOT NULL DEFAULT 0`);
    if (!names.has("poly_live")) db.exec(`ALTER TABLE events ADD COLUMN poly_live INTEGER NOT NULL DEFAULT 0`);
    if (!names.has("closed")) db.exec(`ALTER TABLE events ADD COLUMN closed INTEGER NOT NULL DEFAULT 0`);
    if (!names.has("game_status")) db.exec(`ALTER TABLE events ADD COLUMN game_status TEXT`);
    if (!names.has("finished_at")) db.exec(`ALTER TABLE events ADD COLUMN finished_at INTEGER`);
    db.exec(`
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
  } finally {
    db.close();
  }
}

function mapEventRow(row: {
  eventId: string;
  sport: Sport;
  title: string;
  slug: string;
  startTime: string | null;
  eventDate: string | null;
  ended: number;
  polyLive: number;
  closed: number;
  gameStatus: string | null;
  finishedAt: number | null;
  marketCount: number;
  tokenCount: number;
  lastSnapshotAt: number | null;
}): EventRow {
  return {
    ...row,
    ended: row.ended === 1,
    polyLive: row.polyLive === 1,
    closed: row.closed === 1,
  };
}

export async function refreshPolyStatuses() {
  if (!existsSync(DB_PATH)) return;
  ensureDbSchema();
  const db = new Database(DB_PATH);
  try {
    const ids = (db.prepare(`SELECT event_id AS eventId FROM events`).all() as Array<{ eventId: string }>).map(
      (row) => row.eventId
    );
    if (!ids.length) return;
    const gammaRows = await fetchEventsByIds(ids);
    const update = db.prepare(`
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
    const lastScore = db.prepare(`
      SELECT score, period, elapsed FROM score_snapshots
      WHERE event_id = @eventId ORDER BY captured_at DESC LIMIT 1
    `);
    const insertScore = db.prepare(`
      INSERT INTO score_snapshots (event_id, captured_at, score, period, elapsed)
      VALUES (@eventId, @capturedAt, @score, @period, @elapsed)
    `);
    const sportById = new Map(
      (db.prepare(`SELECT event_id AS eventId, sport FROM events`).all() as Array<{ eventId: string; sport: Sport }>).map(
        (row) => [row.eventId, row.sport]
      )
    );
    const now = Date.now();
    const tx = db.transaction(() => {
      for (const row of gammaRows) {
        const id = String(row.id);
        const sport = sportById.get(id);
        const finished = isFinishedGammaEvent(row, { sport });
        update.run({
          eventId: id,
          ended: finished ? 1 : 0,
          polyLive: row.live === true && !finished ? 1 : 0,
          closed: row.closed === true ? 1 : 0,
          gameStatus: row.gameStatus?.trim() || row.period?.trim() || null,
          finishedAt: finished ? finishedAtFromGamma(row) : null,
          updatedAt: now,
        });
        const score = row.score?.trim() || null;
        const period = row.period?.trim() || null;
        const elapsed = row.elapsed?.trim() || null;
        if (!score && !period && !elapsed) continue;
        const prev = lastScore.get({ eventId: id }) as
          | { score: string | null; period: string | null; elapsed: string | null }
          | undefined;
        if (prev && prev.score === score && prev.period === period && prev.elapsed === elapsed) continue;
        insertScore.run({
          eventId: id,
          capturedAt: now,
          score,
          period,
          elapsed,
        });
      }
    });
    tx();
  } finally {
    db.close();
  }
}

function openReadonly() {
  if (!existsSync(DB_PATH)) return null;
  ensureDbSchema();
  return new Database(DB_PATH, { readonly: true, fileMustExist: true });
}

export function getOverview(): OverviewStats {
  const db = openReadonly();
  if (!db) {
    return {
      dbPath: DB_PATH,
      exists: false,
      events: 0,
      tokens: 0,
      snapshots: 0,
      bySport: [],
    };
  }
  try {
    const events = (db.prepare(`SELECT COUNT(*) AS n FROM events`).get() as { n: number }).n;
    const tokens = (db.prepare(`SELECT COUNT(*) AS n FROM tokens`).get() as { n: number }).n;
    const snapshots = (db.prepare(`SELECT COUNT(*) AS n FROM book_snapshots`).get() as { n: number }).n;
    const bySport = db
      .prepare(
        `SELECT e.sport, COUNT(DISTINCT e.event_id) AS events, COUNT(DISTINCT t.token_id) AS tokens
         FROM events e
         LEFT JOIN tokens t ON t.event_id = e.event_id
         GROUP BY e.sport
         ORDER BY e.sport`
      )
      .all() as Array<{ sport: Sport; events: number; tokens: number }>;
    return { dbPath: DB_PATH, exists: true, events, tokens, snapshots, bySport };
  } finally {
    db.close();
  }
}

export function listEvents(sport?: Sport): EventRow[] {
  const db = openReadonly();
  if (!db) return [];
  try {
    const rows = db
      .prepare(
        `SELECT
           e.event_id AS eventId,
           e.sport,
           e.title,
           e.slug,
           e.start_time AS startTime,
           e.event_date AS eventDate,
           e.ended,
           e.poly_live AS polyLive,
           e.closed,
           e.game_status AS gameStatus,
           e.finished_at AS finishedAt,
           (SELECT COUNT(*) FROM markets m WHERE m.event_id = e.event_id) AS marketCount,
           (SELECT COUNT(*) FROM tokens t WHERE t.event_id = e.event_id) AS tokenCount,
           (SELECT MAX(s.captured_at) FROM book_snapshots s WHERE s.event_id = e.event_id) AS lastSnapshotAt
         FROM events e
         ${sport ? "WHERE e.sport = @sport" : ""}
         ORDER BY e.ended ASC, e.closed ASC, e.finished_at DESC, lastSnapshotAt DESC, COALESCE(e.event_date, '9999-12-31') DESC, e.title`
      )
      .all(sport ? { sport } : {}) as Array<Parameters<typeof mapEventRow>[0]>;
    return rows.map(mapEventRow);
  } finally {
    db.close();
  }
}

export function getEvent(eventId: string) {
  const db = openReadonly();
  if (!db) return null;
  try {
    const event = db
      .prepare(
        `SELECT event_id AS eventId, sport, title, slug, start_time AS startTime, event_date AS eventDate,
                ended, poly_live AS polyLive, closed, game_status AS gameStatus, finished_at AS finishedAt
         FROM events WHERE event_id = ?`
      )
      .get(eventId) as Parameters<typeof mapEventRow>[0] | undefined;
    if (!event) return null;

    const markets = db
      .prepare(
        `SELECT market_id AS marketId, market_type AS marketType, question, line
         FROM markets WHERE event_id = ?
         ORDER BY CASE market_type WHEN 'moneyline' THEN 0 ELSE 1 END, COALESCE(line, '0')`
      )
      .all(eventId) as Array<Omit<MarketRow, "tokens">>;

    const tokens = db
      .prepare(
        `SELECT
           t.token_id AS tokenId,
           t.market_id AS marketId,
           t.side,
           t.label,
           t.line,
           s.best_bid AS lastBid,
           s.best_ask AS lastAsk,
           s.captured_at AS lastAt
         FROM tokens t
         LEFT JOIN book_snapshots s ON s.id = (
           SELECT id FROM book_snapshots WHERE token_id = t.token_id ORDER BY captured_at DESC LIMIT 1
         )
         WHERE t.event_id = ?
         ORDER BY t.market_type, COALESCE(t.line, '0'), t.side`
      )
      .all(eventId) as Array<
        TokenRow & { marketId: string; marketType: "moneyline" | "total" | "weather" }
      >;

    const marketRows: MarketRow[] = markets.map((market) => ({
      ...market,
      tokens: tokens
        .filter((token) => token.marketId === market.marketId)
        .map(({ tokenId, side, label, line, lastBid, lastAsk, lastAt }) => ({
          tokenId,
          side,
          label,
          line,
          lastBid,
          lastAsk,
          lastAt,
        })),
    }));

    const lastSnapshotAt = (
      db
        .prepare(`SELECT MAX(captured_at) AS ts FROM book_snapshots WHERE event_id = ?`)
        .get(eventId) as { ts: number | null }
    ).ts;

    return {
      ...mapEventRow({
        ...event,
        marketCount: marketRows.length,
        tokenCount: tokens.length,
        lastSnapshotAt,
      }),
      markets: marketRows,
      lastSnapshotAt,
    };
  } finally {
    db.close();
  }
}

export function getTokenHistory(tokenId: string): {
  token: (TokenRow & { eventId: string; sport: Sport; marketType: string }) | null;
  eventTitle: string | null;
  /** Compact columnar timeline (no book depth). Client expands to SnapshotRow[]. */
  timeline: {
    id: number[];
    at: number[];
    bestBid: Array<number | null>;
    bestAsk: Array<number | null>;
  };
  totalSnapshots: number;
  eventFinished: boolean;
} {
  const db = openReadonly();
  if (!db) {
    return {
      token: null,
      eventTitle: null,
      timeline: { id: [], at: [], bestBid: [], bestAsk: [] },
      totalSnapshots: 0,
      eventFinished: false,
    };
  }
  try {
    const token = db
      .prepare(
        `SELECT token_id AS tokenId, event_id AS eventId, sport, market_type AS marketType, side, label, line
         FROM tokens WHERE token_id = ?`
      )
      .get(tokenId) as (TokenRow & { eventId: string; sport: Sport; marketType: string }) | undefined;

    const eventTitle = token
      ? ((db.prepare(`SELECT title FROM events WHERE event_id = ?`).get(token.eventId) as { title: string } | undefined)
          ?.title ?? null)
      : null;

    // Timeline only — skip bids/asks JSON (tens of MB). Full book loaded per-frame.
    const rawRows = db
      .prepare(
        `SELECT id, captured_at AS capturedAt, best_bid AS bestBid, best_ask AS bestAsk
         FROM book_snapshots
         WHERE token_id = ?
         ORDER BY captured_at ASC`
      )
      .all(tokenId) as Array<{
        id: number;
        capturedAt: number;
        bestBid: number | null;
        bestAsk: number | null;
      }>;

    const n = rawRows.length;
    const timeline = {
      id: new Array<number>(n),
      at: new Array<number>(n),
      bestBid: new Array<number | null>(n),
      bestAsk: new Array<number | null>(n),
    };
    for (let i = 0; i < n; i++) {
      const row = rawRows[i]!;
      timeline.id[i] = row.id;
      timeline.at[i] = row.capturedAt;
      timeline.bestBid[i] = row.bestBid;
      timeline.bestAsk[i] = row.bestAsk;
    }

    const eventStatus = token
      ? (db
          .prepare(`SELECT ended, closed FROM events WHERE event_id = ?`)
          .get(token.eventId) as { ended: number; closed: number } | undefined)
      : undefined;
    const eventFinished = Boolean(eventStatus && (eventStatus.ended === 1 || eventStatus.closed === 1));

    return {
      token: token ?? null,
      eventTitle,
      timeline,
      totalSnapshots: n,
      eventFinished,
    };
  } finally {
    db.close();
  }
}

export function getSnapshotById(id: number): SnapshotRow | null {
  const db = openReadonly();
  if (!db) return null;
  try {
    const row = db
      .prepare(
        `SELECT id, captured_at AS capturedAt, best_bid AS bestBid, best_ask AS bestAsk,
                bid_depth AS bidDepth, ask_depth AS askDepth, bids_json AS bidsJson, asks_json AS asksJson
         FROM book_snapshots WHERE id = ?`
      )
      .get(id) as
      | {
          id: number;
          capturedAt: number;
          bestBid: number | null;
          bestAsk: number | null;
          bidDepth: number;
          askDepth: number;
          bidsJson: string;
          asksJson: string;
        }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      capturedAt: row.capturedAt,
      bestBid: row.bestBid,
      bestAsk: row.bestAsk,
      bidDepth: row.bidDepth,
      askDepth: row.askDepth,
      bids: JSON.parse(row.bidsJson) as Array<{ price: number; size: number }>,
      asks: JSON.parse(row.asksJson) as Array<{ price: number; size: number }>,
    };
  } finally {
    db.close();
  }
}

/** Compact bid/ask series for sidebar scrub — dense samples across the match window. */
export function getEventQuoteSeries(eventId: string): Record<
  string,
  Array<{ capturedAt: number; bestBid: number | null; bestAsk: number | null }>
> {
  const db = openReadonly();
  if (!db) return {};
  try {
    const tokens = db
      .prepare(`SELECT token_id AS tokenId FROM tokens WHERE event_id = ?`)
      .all(eventId) as Array<{ tokenId: string }>;
    if (!tokens.length) return {};

    const event = db
      .prepare(
        `SELECT start_time AS startTime, finished_at AS finishedAt
         FROM events WHERE event_id = ?`
      )
      .get(eventId) as { startTime: string | null; finishedAt: number | null } | undefined;

    const span = db
      .prepare(
        `SELECT MIN(captured_at) AS a, MAX(captured_at) AS b
         FROM book_snapshots WHERE event_id = ?`
      )
      .get(eventId) as { a: number | null; b: number | null };

    if (span?.a == null || span?.b == null) return {};

    const startMs = event?.startTime ? Date.parse(event.startTime) : NaN;
    const finishMs = event?.finishedAt != null ? Number(event.finishedAt) : NaN;
    const from = Number.isFinite(startMs) ? Math.max(span.a, startMs - 5 * 60_000) : span.a;
    const to = Number.isFinite(finishMs) ? Math.min(span.b, finishMs + 10 * 60_000) : span.b;
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    const TARGET = 360;
    const step = Math.max(1_000, Math.floor((hi - lo) / Math.max(1, TARGET - 1)));

    const atTimes: number[] = [];
    for (let t = lo; t <= hi; t += step) atTimes.push(t);
    if (atTimes[atTimes.length - 1] !== hi) atTimes.push(hi);
    // Always include absolute first/last snap times so scrub edges resolve.
    if (atTimes[0] !== span.a) atTimes.unshift(span.a);
    if (atTimes[atTimes.length - 1] !== span.b) atTimes.push(span.b);

    const stmt = db.prepare(
      `SELECT best_bid AS bestBid, best_ask AS bestAsk, captured_at AS capturedAt
       FROM book_snapshots
       WHERE token_id = ? AND captured_at <= ?
       ORDER BY captured_at DESC
       LIMIT 1`
    );

    const out: Record<
      string,
      Array<{ capturedAt: number; bestBid: number | null; bestAsk: number | null }>
    > = {};

    for (const { tokenId } of tokens) {
      const series: Array<{ capturedAt: number; bestBid: number | null; bestAsk: number | null }> =
        [];
      for (const at of atTimes) {
        const row = stmt.get(tokenId, at) as
          | { bestBid: number | null; bestAsk: number | null; capturedAt: number }
          | undefined;
        if (!row) continue;
        const prev = series[series.length - 1];
        if (
          prev &&
          prev.bestBid === row.bestBid &&
          prev.bestAsk === row.bestAsk
        ) {
          continue;
        }
        series.push({
          capturedAt: row.capturedAt,
          bestBid: row.bestBid,
          bestAsk: row.bestAsk,
        });
      }
      out[tokenId] = series;
    }

    return out;
  } finally {
    db.close();
  }
}

export function getScoreHistory(eventId: string): ScoreSnapshotRow[] {
  const db = openReadonly();
  if (!db) return [];
  try {
    ensureDbSchema();
    return db
      .prepare(
        `SELECT captured_at AS capturedAt, score, period, elapsed
         FROM score_snapshots
         WHERE event_id = ?
         ORDER BY captured_at ASC`
      )
      .all(eventId) as ScoreSnapshotRow[];
  } finally {
    db.close();
  }
}

export function recordScoreSnapshot(
  eventId: string,
  score: string | null,
  period: string | null,
  elapsed: string | null
) {
  if (!existsSync(DB_PATH)) return;
  ensureDbSchema();
  const db = new Database(DB_PATH);
  try {
    const last = db
      .prepare(
        `SELECT score, period, elapsed FROM score_snapshots
         WHERE event_id = ? ORDER BY captured_at DESC LIMIT 1`
      )
      .get(eventId) as { score: string | null; period: string | null; elapsed: string | null } | undefined;
    if (last && last.score === score && last.period === period && last.elapsed === elapsed) return;
    db.prepare(
      `INSERT INTO score_snapshots (event_id, captured_at, score, period, elapsed)
       VALUES (?, ?, ?, ?, ?)`
    ).run(eventId, Date.now(), score, period, elapsed);
  } finally {
    db.close();
  }
}

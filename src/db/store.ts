import Database from "better-sqlite3";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  DATA_DIR,
  SPORTS,
  dbPathForDay,
  idxPathForSport,
  sportDir,
  utcDay,
} from "../config/env.ts";
import type { BookLevel, BookSnapshot, MonitoredEvent, MonitoredToken, MonitorSport } from "../types/monitoring.ts";

export function openDb(path: string, readonly = false) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { readonly, fileMustExist: readonly });
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("wal_autocheckpoint = 1000");
  db.pragma("journal_size_limit = 268435456");
  if (!readonly) db.pragma("busy_timeout = 5000");
  return db;
}

export function checkpointDb(db: Database.Database, mode: "PASSIVE" | "TRUNCATE" = "PASSIVE") {
  try {
    db.pragma(`wal_checkpoint(${mode})`);
  } catch {
    /* readers may block TRUNCATE */
  }
}

export function dayForEvent(event: Pick<MonitoredEvent, "eventDate" | "startTime">): string {
  if (event.eventDate && /^\d{4}-\d{2}-\d{2}$/.test(event.eventDate)) return event.eventDate;
  if (event.startTime) {
    const t = Date.parse(event.startTime);
    if (Number.isFinite(t)) return utcDay(t);
  }
  return utcDay();
}

export function listDayFiles(sport: MonitorSport): string[] {
  const dir = sportDir(sport);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.db$/.test(name))
    .map((name) => name.slice(0, 10))
    .sort()
    .reverse();
}

/**
 * Compact schema. Layout on disk:
 *   data/{sport}/{YYYY-MM-DD}.db
 *   data/{sport}/_idx.db   (event/token → day)
 */
export function initSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ev (
      id TEXT PRIMARY KEY,
      t TEXT NOT NULL,
      s TEXT NOT NULL,
      st TEXT,
      d TEXT,
      e INTEGER NOT NULL DEFAULT 0,
      l INTEGER NOT NULL DEFAULT 0,
      c INTEGER NOT NULL DEFAULT 0,
      gs TEXT,
      fa INTEGER,
      ar INTEGER NOT NULL DEFAULT 0,
      lg TEXT,
      v REAL,
      u INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mk (
      id TEXT PRIMARY KEY,
      eid TEXT NOT NULL,
      mt TEXT NOT NULL,
      q TEXT NOT NULL,
      ln TEXT,
      v REAL,
      u INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tk (
      id TEXT PRIMARY KEY,
      mid TEXT NOT NULL,
      eid TEXT NOT NULL,
      mt TEXT NOT NULL,
      sd TEXT NOT NULL,
      lb TEXT NOT NULL,
      ln TEXT,
      u INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ob (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tid TEXT NOT NULL,
      eid TEXT NOT NULL,
      ts INTEGER NOT NULL,
      bb REAL,
      ba REAL,
      bd REAL NOT NULL DEFAULT 0,
      ad REAL NOT NULL DEFAULT 0,
      bj TEXT NOT NULL DEFAULT '[]',
      aj TEXT NOT NULL DEFAULT '[]'
    );

    CREATE INDEX IF NOT EXISTS idx_ob_tid_ts ON ob(tid, ts);
    CREATE INDEX IF NOT EXISTS idx_ob_eid_ts ON ob(eid, ts);

    CREATE TABLE IF NOT EXISTS sc (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      eid TEXT NOT NULL,
      ts INTEGER NOT NULL,
      sc TEXT,
      p TEXT,
      el TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sc_eid_ts ON sc(eid, ts);

    CREATE INDEX IF NOT EXISTS idx_tk_eid ON tk(eid);
    CREATE INDEX IF NOT EXISTS idx_mk_eid ON mk(eid);
  `);
}

/** Compact level JSON: [{p,s},…] */
export function levelsToJson(levels: BookLevel[]) {
  return JSON.stringify(levels.map((l) => ({ p: l.price, s: l.size })));
}

export function levelsFromJson(raw: string): BookLevel[] {
  try {
    const arr = JSON.parse(raw) as Array<{ p?: number; s?: number; price?: number; size?: number }>;
    if (!Array.isArray(arr)) return [];
    const out: BookLevel[] = [];
    for (const row of arr) {
      const price = Number(row.p ?? row.price);
      const size = Number(row.s ?? row.size);
      if (!Number.isFinite(price) || !Number.isFinite(size) || size <= 0) continue;
      out.push({ price, size });
    }
    return out;
  } catch {
    return [];
  }
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

  constructor(
    private readonly db: Database.Database,
    readonly sport: MonitorSport,
    readonly day: string
  ) {
    initSchema(db);
    this.upsertEvent = db.prepare(`
      INSERT INTO ev (id, t, s, st, d, e, l, c, gs, fa, u)
      VALUES (@id, @t, @s, @st, @d, @e, @l, @c, @gs, @fa, @u)
      ON CONFLICT(id) DO UPDATE SET
        t = excluded.t,
        s = excluded.s,
        st = excluded.st,
        d = excluded.d,
        e = CASE WHEN ev.e = 1 OR ev.c = 1 THEN 1 ELSE excluded.e END,
        l = CASE WHEN ev.e = 1 OR ev.c = 1 OR excluded.e = 1 THEN 0 ELSE excluded.l END,
        c = CASE WHEN ev.c = 1 THEN 1 ELSE excluded.c END,
        gs = COALESCE(excluded.gs, ev.gs),
        fa = COALESCE(ev.fa, excluded.fa),
        u = excluded.u
    `);
    this.upsertMarket = db.prepare(`
      INSERT INTO mk (id, eid, mt, q, ln, u)
      VALUES (@id, @eid, @mt, @q, @ln, @u)
      ON CONFLICT(id) DO UPDATE SET
        q = excluded.q,
        ln = excluded.ln,
        u = excluded.u
    `);
    this.upsertToken = db.prepare(`
      INSERT INTO tk (id, mid, eid, mt, sd, lb, ln, u)
      VALUES (@id, @mid, @eid, @mt, @sd, @lb, @ln, @u)
      ON CONFLICT(id) DO UPDATE SET
        mid = excluded.mid,
        eid = excluded.eid,
        mt = excluded.mt,
        sd = excluded.sd,
        lb = excluded.lb,
        ln = excluded.ln,
        u = excluded.u
    `);
    this.insertSnapshot = db.prepare(`
      INSERT INTO ob (tid, eid, ts, bb, ba, bd, ad, bj, aj)
      VALUES (@tid, @eid, @ts, @bb, @ba, @bd, @ad, @bj, @aj)
    `);
    this.updatePolyStatus = db.prepare(`
      UPDATE ev
      SET e = @e,
          l = @l,
          c = @c,
          gs = @gs,
          fa = CASE
            WHEN @e = 1 OR @c = 1 THEN COALESCE(@fa, fa)
            ELSE fa
          END,
          u = @u
      WHERE id = @id
    `);
    this.lastScore = db.prepare(`
      SELECT sc, p, el FROM sc WHERE eid = @eid ORDER BY ts DESC LIMIT 1
    `);
    this.insertScore = db.prepare(`
      INSERT INTO sc (eid, ts, sc, p, el) VALUES (@eid, @ts, @sc, @p, @el)
    `);
  }

  get raw() {
    return this.db;
  }

  syncCatalog(events: MonitoredEvent[]) {
    const now = Date.now();
    const tx = this.db.transaction(() => {
      for (const event of events) {
        if (event.sport !== this.sport) continue;
        this.upsertEvent.run({
          id: event.eventId,
          t: event.title,
          s: event.slug,
          st: event.startTime,
          d: event.eventDate,
          e: event.ended ? 1 : 0,
          l: event.polyLive ? 1 : 0,
          c: event.closed ? 1 : 0,
          gs: event.gameStatus,
          fa: event.finishedAt,
          u: now,
        });
        for (const market of event.markets) {
          this.upsertMarket.run({
            id: market.marketId,
            eid: market.eventId,
            mt: market.marketType,
            q: market.question,
            ln: market.line,
            u: now,
          });
          for (const row of market.tokens) {
            this.upsertToken.run({
              id: row.tokenId,
              mid: row.marketId,
              eid: row.eventId,
              mt: row.marketType,
              sd: row.side,
              lb: row.label,
              ln: row.line,
              u: now,
            });
          }
        }
      }
    });
    tx();
  }

  listEventIds() {
    return (this.db.prepare(`SELECT id FROM ev`).all() as Array<{ id: string }>).map((r) => r.id);
  }

  isArmed(eventId: string) {
    const row = this.db.prepare(`SELECT ar FROM ev WHERE id = ?`).get(eventId) as { ar: number } | undefined;
    return row?.ar === 1;
  }

  armEvent(eventId: string) {
    this.db.prepare(`UPDATE ev SET ar = 1, u = ? WHERE id = ? AND ar = 0`).run(Date.now(), eventId);
  }

  listArmedEventIds() {
    return (this.db.prepare(`SELECT id FROM ev WHERE ar = 1`).all() as Array<{ id: string }>).map((r) => r.id);
  }

  armWeatherThatAlreadyHasBooks() {
    if (this.sport !== "weather") return 0;
    const ids = this.db.prepare(`SELECT id FROM ev WHERE ar = 0`).all() as Array<{ id: string }>;
    if (!ids.length) return 0;
    const hasBook = this.db.prepare(`SELECT 1 AS ok FROM ob WHERE eid = ? LIMIT 1`);
    let n = 0;
    const tx = this.db.transaction(() => {
      for (const { id } of ids) {
        if (!hasBook.get(id)) continue;
        this.armEvent(id);
        n++;
      }
    });
    tx();
    return n;
  }

  markEventsFinished(eventIds: string[], finishedAt = Date.now()) {
    if (!eventIds.length) return;
    const stmt = this.db.prepare(`
      UPDATE ev
      SET e = 1, l = 0, fa = COALESCE(fa, @fa), u = @u
      WHERE id = @id AND e = 0 AND c = 0
    `);
    const now = Date.now();
    const tx = this.db.transaction(() => {
      for (const id of eventIds) stmt.run({ id, fa: finishedAt, u: now });
    });
    tx();
  }

  updatePolyStatuses(rows: PolyEventStatus[]) {
    const now = Date.now();
    const tx = this.db.transaction(() => {
      for (const row of rows) {
        const finished = row.ended || row.closed;
        this.updatePolyStatus.run({
          id: row.eventId,
          e: row.ended ? 1 : 0,
          l: row.polyLive ? 1 : 0,
          c: row.closed ? 1 : 0,
          gs: row.gameStatus,
          fa: finished ? row.finishedAt : null,
          u: now,
        });
        const score = row.score?.trim() || null;
        const period = row.period?.trim() || null;
        const elapsed = row.elapsed?.trim() || null;
        if (!score && !period && !elapsed) continue;
        const prev = this.lastScore.get({ eid: row.eventId }) as
          | { sc: string | null; p: string | null; el: string | null }
          | undefined;
        if (prev && prev.sc === score && prev.p === period && prev.el === elapsed) continue;
        this.insertScore.run({ eid: row.eventId, ts: now, sc: score, p: period, el: elapsed });
      }
    });
    tx();
  }

  recordSnapshot(snap: BookSnapshot) {
    this.insertSnapshot.run({
      tid: snap.tokenId,
      eid: snap.eventId,
      ts: snap.capturedAt,
      bb: snap.bestBid,
      ba: snap.bestAsk,
      bd: snap.bidDepth,
      ad: snap.askDepth,
      bj: levelsToJson(snap.bids),
      aj: levelsToJson(snap.asks),
    });
  }

  getTokenMeta(tokenId: string): MonitoredToken | null {
    const row = this.db
      .prepare(
        `SELECT id AS tokenId, mid AS marketId, eid AS eventId, mt AS marketType, sd AS side, lb AS label, ln AS line
         FROM tk WHERE id = ?`
      )
      .get(tokenId) as
      | {
          tokenId: string;
          marketId: string;
          eventId: string;
          marketType: MonitoredToken["marketType"];
          side: string;
          label: string;
          line: string | null;
        }
      | undefined;
    if (!row) return null;
    return { ...row, sport: this.sport };
  }

  stats() {
    const events = (this.db.prepare(`SELECT COUNT(*) AS n FROM ev`).get() as { n: number }).n;
    const tokens = (this.db.prepare(`SELECT COUNT(*) AS n FROM tk`).get() as { n: number }).n;
    const snapshots = (this.db.prepare(`SELECT COUNT(*) AS n FROM ob`).get() as { n: number }).n;
    return { events, tokens, snapshots };
  }
}

/** Routes catalog/snapshots across data/{sport}/{day}.db files. */
export class MonitorHub {
  private readonly cache = new Map<string, MonitorStore>();
  private readonly eventLoc = new Map<string, { sport: MonitorSport; day: string }>();
  private readonly tokenLoc = new Map<string, { sport: MonitorSport; day: string }>();
  private readonly idx = new Map<MonitorSport, Database.Database>();

  constructor() {
    mkdirSync(DATA_DIR, { recursive: true });
    for (const sport of SPORTS) {
      mkdirSync(sportDir(sport), { recursive: true });
      const idxDb = openDb(idxPathForSport(sport));
      idxDb.exec(`
        CREATE TABLE IF NOT EXISTS loc (
          eid TEXT PRIMARY KEY,
          day TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS tok (
          tid TEXT PRIMARY KEY,
          eid TEXT NOT NULL,
          day TEXT NOT NULL
        );
      `);
      this.idx.set(sport, idxDb);
      // Warm location maps from index.
      for (const row of idxDb.prepare(`SELECT eid, day FROM loc`).all() as Array<{ eid: string; day: string }>) {
        this.eventLoc.set(row.eid, { sport, day: row.day });
      }
      for (const row of idxDb.prepare(`SELECT tid, eid, day FROM tok`).all() as Array<{
        tid: string;
        eid: string;
        day: string;
      }>) {
        this.tokenLoc.set(row.tid, { sport, day: row.day });
      }
    }
  }

  private key(sport: MonitorSport, day: string) {
    return `${sport}/${day}`;
  }

  store(sport: MonitorSport, day: string) {
    const k = this.key(sport, day);
    let s = this.cache.get(k);
    if (!s) {
      s = new MonitorStore(openDb(dbPathForDay(sport, day)), sport, day);
      this.cache.set(k, s);
    }
    return s;
  }

  private remember(event: MonitoredEvent, day: string) {
    const sport = event.sport;
    this.eventLoc.set(event.eventId, { sport, day });
    const idx = this.idx.get(sport)!;
    idx.prepare(`INSERT INTO loc (eid, day) VALUES (?, ?) ON CONFLICT(eid) DO UPDATE SET day = excluded.day`).run(
      event.eventId,
      day
    );
    const upsertTok = idx.prepare(
      `INSERT INTO tok (tid, eid, day) VALUES (?, ?, ?) ON CONFLICT(tid) DO UPDATE SET eid = excluded.eid, day = excluded.day`
    );
    for (const market of event.markets) {
      for (const token of market.tokens) {
        this.tokenLoc.set(token.tokenId, { sport, day });
        upsertTok.run(token.tokenId, event.eventId, day);
      }
    }
  }

  syncCatalog(events: MonitoredEvent[]) {
    const groups = new Map<string, MonitoredEvent[]>();
    for (const event of events) {
      const day = dayForEvent(event);
      const k = this.key(event.sport, day);
      const list = groups.get(k) ?? [];
      list.push(event);
      groups.set(k, list);
      this.remember(event, day);
    }
    for (const [k, list] of groups) {
      const [sport, day] = k.split("/") as [MonitorSport, string];
      this.store(sport, day).syncCatalog(list);
    }
  }

  listEventIds() {
    return [...this.eventLoc.keys()];
  }

  getEventSport(eventId: string): MonitorSport | null {
    return this.eventLoc.get(eventId)?.sport ?? null;
  }

  getEventLoc(eventId: string) {
    return this.eventLoc.get(eventId) ?? null;
  }

  listArmedEventIds() {
    const out = new Set<string>();
    for (const day of listDayFiles("weather")) {
      for (const id of this.store("weather", day).listArmedEventIds()) out.add(id);
    }
    return [...out];
  }

  armEvent(eventId: string) {
    const loc = this.eventLoc.get(eventId);
    if (!loc || loc.sport !== "weather") return;
    this.store(loc.sport, loc.day).armEvent(eventId);
  }

  armWeatherThatAlreadyHasBooks() {
    let n = 0;
    for (const day of listDayFiles("weather")) {
      n += this.store("weather", day).armWeatherThatAlreadyHasBooks();
    }
    return n;
  }

  markEventsFinished(eventIds: string[], finishedAt = Date.now()) {
    if (!eventIds.length) return;
    const by = new Map<string, string[]>();
    for (const id of eventIds) {
      const loc = this.eventLoc.get(id);
      if (!loc) continue;
      const k = this.key(loc.sport, loc.day);
      const list = by.get(k) ?? [];
      list.push(id);
      by.set(k, list);
    }
    for (const [k, ids] of by) {
      const [sport, day] = k.split("/") as [MonitorSport, string];
      this.store(sport, day).markEventsFinished(ids, finishedAt);
    }
  }

  updatePolyStatuses(rows: PolyEventStatus[]) {
    const by = new Map<string, PolyEventStatus[]>();
    for (const row of rows) {
      const loc = this.eventLoc.get(row.eventId);
      if (!loc) continue;
      const k = this.key(loc.sport, loc.day);
      const list = by.get(k) ?? [];
      list.push(row);
      by.set(k, list);
    }
    for (const [k, list] of by) {
      const [sport, day] = k.split("/") as [MonitorSport, string];
      this.store(sport, day).updatePolyStatuses(list);
    }
  }

  recordSnapshot(snap: BookSnapshot) {
    const loc =
      this.tokenLoc.get(snap.tokenId) ??
      this.eventLoc.get(snap.eventId) ??
      { sport: snap.sport, day: utcDay(snap.capturedAt) };
    this.store(loc.sport, loc.day).recordSnapshot(snap);
  }

  getTokenMeta(tokenId: string): MonitoredToken | null {
    const loc = this.tokenLoc.get(tokenId);
    if (loc) return this.store(loc.sport, loc.day).getTokenMeta(tokenId);
    for (const sport of SPORTS) {
      const row = this.idx.get(sport)!.prepare(`SELECT day FROM tok WHERE tid = ?`).get(tokenId) as
        | { day: string }
        | undefined;
      if (!row) continue;
      this.tokenLoc.set(tokenId, { sport, day: row.day });
      return this.store(sport, row.day).getTokenMeta(tokenId);
    }
    return null;
  }

  stats() {
    let events = 0;
    let tokens = 0;
    let snapshots = 0;
    for (const sport of SPORTS) {
      for (const day of listDayFiles(sport)) {
        const s = this.store(sport, day).stats();
        events += s.events;
        tokens += s.tokens;
        snapshots += s.snapshots;
      }
    }
    return { events, tokens, snapshots };
  }

  checkpointAll(mode: "PASSIVE" | "TRUNCATE" = "PASSIVE") {
    for (const store of this.cache.values()) checkpointDb(store.raw, mode);
    for (const idx of this.idx.values()) checkpointDb(idx, mode);
  }

  close() {
    for (const store of this.cache.values()) store.raw.close();
    this.cache.clear();
    for (const idx of this.idx.values()) idx.close();
    this.idx.clear();
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

export function normalizeBookSide(levels: BookLevel[], side: "bid" | "ask") {
  return [...levels].sort((a, b) => (side === "bid" ? b.price - a.price : a.price - b.price));
}

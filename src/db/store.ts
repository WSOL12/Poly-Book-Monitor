import Database from "better-sqlite3";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  DATA_DIR,
  SPORTS,
  dbPathForMonth,
  idxPathForSport,
  sportDir,
  utcMonth,
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

/** Shard key = UTC calendar month YYYY-MM (same idea as compare-poly-predict monthly sqlite). */
export function monthForEvent(event: Pick<MonitoredEvent, "eventDate" | "startTime">): string {
  if (event.eventDate && /^\d{4}-\d{2}-\d{2}$/.test(event.eventDate)) return event.eventDate.slice(0, 7);
  if (event.eventDate && /^\d{4}-\d{2}$/.test(event.eventDate)) return event.eventDate;
  if (event.startTime) {
    const t = Date.parse(event.startTime);
    if (Number.isFinite(t)) return utcMonth(t);
  }
  return utcMonth();
}

/** @deprecated use monthForEvent */
export function dayForEvent(event: Pick<MonitoredEvent, "eventDate" | "startTime">): string {
  return monthForEvent(event);
}

export function listMonthFiles(sport: MonitorSport): string[] {
  const dir = sportDir(sport);
  if (!existsSync(dir)) return [];
  const months = new Set<string>();
  for (const name of readdirSync(dir)) {
    const monthly = /^(\d{4}-\d{2})\.db$/.exec(name);
    if (monthly) {
      months.add(monthly[1]!);
      continue;
    }
    // Legacy daily shards from the old monitor.
    const daily = /^(\d{4}-\d{2})-\d{2}\.db$/.exec(name);
    if (daily) months.add(daily[1]!);
  }
  return [...months].sort().reverse();
}

/** @deprecated use listMonthFiles */
export function listDayFiles(sport: MonitorSport): string[] {
  return listMonthFiles(sport);
}

/**
 * Compact schema. Layout on disk:
 *   data/{sport}/{YYYY-MM}.db
 *   data/{sport}/_idx.db   (event/token → month)
 *
 * `dl` tracks Predexon download completeness (like history-download markets.complete).
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

    -- Download job tracker (compare-poly-predict markets.complete pattern)
    CREATE TABLE IF NOT EXISTS dl (
      eid TEXT PRIMARY KEY,
      complete INTEGER NOT NULL DEFAULT 0,
      tokens INTEGER NOT NULL DEFAULT 0,
      snapshots INTEGER NOT NULL DEFAULT 0,
      last_ts INTEGER,
      from_ms INTEGER,
      to_ms INTEGER,
      downloaded_at TEXT,
      note TEXT
    );
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
    readonly month: string
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
      SET e = CASE WHEN e = 1 OR c = 1 THEN 1 ELSE @e END,
          l = CASE WHEN e = 1 OR c = 1 OR @e = 1 THEN 0 ELSE @l END,
          c = CASE WHEN c = 1 THEN 1 ELSE @c END,
          gs = @gs,
          fa = CASE
            WHEN @e = 1 OR @c = 1 OR e = 1 OR c = 1 THEN COALESCE(@fa, fa)
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

  listOpenEventIds() {
    return (this.db.prepare(`SELECT id FROM ev WHERE e = 0`).all() as Array<{ id: string }>).map(
      (r) => r.id
    );
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

  isDownloadComplete(eventId: string): boolean {
    const row = this.db.prepare(`SELECT complete FROM dl WHERE eid = ?`).get(eventId) as
      | { complete: number }
      | undefined;
    return row?.complete === 1;
  }

  markDownloadIncomplete(
    eventId: string,
    args: { tokens: number; fromMs: number; toMs: number; note?: string | null },
  ) {
    this.db
      .prepare(
        `INSERT INTO dl (eid, complete, tokens, snapshots, last_ts, from_ms, to_ms, downloaded_at, note)
         VALUES (?, 0, ?, 0, NULL, ?, ?, ?, ?)
         ON CONFLICT(eid) DO UPDATE SET
           complete=0,
           tokens=excluded.tokens,
           snapshots=0,
           last_ts=NULL,
           from_ms=excluded.from_ms,
           to_ms=excluded.to_ms,
           downloaded_at=excluded.downloaded_at,
           note=excluded.note`,
      )
      .run(
        eventId,
        args.tokens,
        args.fromMs,
        args.toMs,
        new Date().toISOString(),
        args.note ?? null,
      );
  }

  markDownloadComplete(
    eventId: string,
    args: {
      tokens: number;
      snapshots: number;
      lastTs: number | null;
      fromMs: number;
      toMs: number;
      note?: string | null;
    },
  ) {
    this.db
      .prepare(
        `INSERT INTO dl (eid, complete, tokens, snapshots, last_ts, from_ms, to_ms, downloaded_at, note)
         VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(eid) DO UPDATE SET
           complete=1,
           tokens=excluded.tokens,
           snapshots=excluded.snapshots,
           last_ts=excluded.last_ts,
           from_ms=excluded.from_ms,
           to_ms=excluded.to_ms,
           downloaded_at=excluded.downloaded_at,
           note=excluded.note`,
      )
      .run(
        eventId,
        args.tokens,
        args.snapshots,
        args.lastTs,
        args.fromMs,
        args.toMs,
        new Date().toISOString(),
        args.note ?? null,
      );
  }

  clearDownload(eventId: string) {
    this.db.prepare(`DELETE FROM dl WHERE eid = ?`).run(eventId);
  }

  deleteEventSnapshots(eventId: string) {
    this.db.prepare(`DELETE FROM ob WHERE eid = ?`).run(eventId);
  }

  lastTokenSnapshotTs(tokenId: string): number | null {
    const row = this.db.prepare(`SELECT MAX(ts) AS hi FROM ob WHERE tid = ?`).get(tokenId) as
      | { hi: number | null }
      | undefined;
    return row?.hi ?? null;
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

/** Routes catalog/snapshots across data/{sport}/{YYYY-MM}.db files. */
export class MonitorHub {
  private readonly cache = new Map<string, MonitorStore>();
  /** Shard key stored as `day` in _idx for dashboard compat — value is YYYY-MM. */
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
      for (const row of idxDb.prepare(`SELECT eid, day FROM loc`).all() as Array<{ eid: string; day: string }>) {
        this.eventLoc.set(row.eid, { sport, day: normalizeShard(row.day) });
      }
      for (const row of idxDb.prepare(`SELECT tid, eid, day FROM tok`).all() as Array<{
        tid: string;
        eid: string;
        day: string;
      }>) {
        this.tokenLoc.set(row.tid, { sport, day: normalizeShard(row.day) });
      }
    }
  }

  private key(sport: MonitorSport, month: string) {
    return `${sport}/${month}`;
  }

  store(sport: MonitorSport, month: string) {
    const shard = normalizeShard(month);
    const k = this.key(sport, shard);
    let s = this.cache.get(k);
    if (!s) {
      s = new MonitorStore(openDb(dbPathForMonth(sport, shard)), sport, shard);
      this.cache.set(k, s);
    }
    return s;
  }

  private remember(event: MonitoredEvent, month: string) {
    const sport = event.sport;
    const shard = normalizeShard(month);
    this.eventLoc.set(event.eventId, { sport, day: shard });
    const idx = this.idx.get(sport)!;
    idx.prepare(`INSERT INTO loc (eid, day) VALUES (?, ?) ON CONFLICT(eid) DO UPDATE SET day = excluded.day`).run(
      event.eventId,
      shard,
    );
    const upsertTok = idx.prepare(
      `INSERT INTO tok (tid, eid, day) VALUES (?, ?, ?) ON CONFLICT(tid) DO UPDATE SET eid = excluded.eid, day = excluded.day`,
    );
    for (const market of event.markets) {
      for (const token of market.tokens) {
        this.tokenLoc.set(token.tokenId, { sport, day: shard });
        upsertTok.run(token.tokenId, event.eventId, shard);
      }
    }
  }

  syncCatalog(events: MonitoredEvent[]) {
    const groups = new Map<string, MonitoredEvent[]>();
    for (const event of events) {
      const month = monthForEvent(event);
      const k = this.key(event.sport, month);
      const list = groups.get(k) ?? [];
      list.push(event);
      groups.set(k, list);
      this.remember(event, month);
    }
    for (const [k, list] of groups) {
      const [sport, month] = k.split("/") as [MonitorSport, string];
      this.store(sport, month).syncCatalog(list);
    }
  }

  listEventIds() {
    return [...this.eventLoc.keys()];
  }

  listOpenEventIds(sport?: MonitorSport) {
    const sports = sport ? [sport] : [...SPORTS];
    const out: string[] = [];
    for (const s of sports) {
      for (const month of listMonthFiles(s)) {
        for (const id of this.store(s, month).listOpenEventIds()) {
          this.eventLoc.set(id, { sport: s, day: month });
          out.push(id);
        }
      }
    }
    return out;
  }

  getEventSport(eventId: string): MonitorSport | null {
    return this.eventLoc.get(eventId)?.sport ?? null;
  }

  getEventLoc(eventId: string) {
    return this.eventLoc.get(eventId) ?? null;
  }

  isDownloadComplete(eventId: string): boolean {
    const loc = this.eventLoc.get(eventId);
    if (!loc) return false;
    return this.store(loc.sport, loc.day).isDownloadComplete(eventId);
  }

  markDownloadIncomplete(
    eventId: string,
    args: { tokens: number; fromMs: number; toMs: number; note?: string | null },
  ) {
    const loc = this.eventLoc.get(eventId);
    if (!loc) return;
    this.store(loc.sport, loc.day).markDownloadIncomplete(eventId, args);
  }

  markDownloadComplete(
    eventId: string,
    args: {
      tokens: number;
      snapshots: number;
      lastTs: number | null;
      fromMs: number;
      toMs: number;
      note?: string | null;
    },
  ) {
    const loc = this.eventLoc.get(eventId);
    if (!loc) return;
    this.store(loc.sport, loc.day).markDownloadComplete(eventId, args);
  }

  resetDownload(eventId: string) {
    const loc = this.eventLoc.get(eventId);
    if (!loc) return;
    const store = this.store(loc.sport, loc.day);
    store.clearDownload(eventId);
    store.deleteEventSnapshots(eventId);
  }

  lastTokenSnapshotTs(tokenId: string, eventId: string): number | null {
    const loc = this.eventLoc.get(eventId) ?? this.tokenLoc.get(tokenId);
    if (!loc) return null;
    return this.store(loc.sport, loc.day).lastTokenSnapshotTs(tokenId);
  }

  listArmedEventIds() {
    const out = new Set<string>();
    for (const month of listMonthFiles("weather")) {
      for (const id of this.store("weather", month).listArmedEventIds()) out.add(id);
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
    for (const month of listMonthFiles("weather")) {
      n += this.store("weather", month).armWeatherThatAlreadyHasBooks();
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
      const [sport, month] = k.split("/") as [MonitorSport, string];
      this.store(sport, month).markEventsFinished(ids, finishedAt);
    }
  }

  scrubSilentOpen(sport: MonitorSport, maxAgeMs: number, now = Date.now()) {
    const finished: string[] = [];
    for (const month of listMonthFiles(sport)) {
      const store = this.store(sport, month);
      for (const id of store.listOpenEventIds()) {
        this.eventLoc.set(id, { sport, day: month });
        const hi = store.raw
          .prepare(`SELECT MAX(ts) AS hi FROM ob WHERE eid = ?`)
          .get(id) as { hi: number | null };
        const age = hi.hi != null ? now - hi.hi : Number.POSITIVE_INFINITY;
        if (age >= maxAgeMs) finished.push(id);
      }
    }
    if (finished.length) this.markEventsFinished(finished, now);
    return finished.length;
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
      const [sport, month] = k.split("/") as [MonitorSport, string];
      this.store(sport, month).updatePolyStatuses(list);
    }
  }

  recordSnapshot(snap: BookSnapshot) {
    const loc =
      this.tokenLoc.get(snap.tokenId) ??
      this.eventLoc.get(snap.eventId) ??
      { sport: snap.sport, day: utcMonth(snap.capturedAt) };
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
      const shard = normalizeShard(row.day);
      this.tokenLoc.set(tokenId, { sport, day: shard });
      return this.store(sport, shard).getTokenMeta(tokenId);
    }
    return null;
  }

  stats() {
    let events = 0;
    let tokens = 0;
    let snapshots = 0;
    for (const sport of SPORTS) {
      for (const month of listMonthFiles(sport)) {
        const s = this.store(sport, month).stats();
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

/** Normalize shard key to YYYY-MM (accepts legacy YYYY-MM-DD). */
function normalizeShard(raw: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw.slice(0, 7);
  return raw;
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


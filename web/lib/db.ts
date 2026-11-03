import Database from "better-sqlite3";
import { existsSync, readdirSync } from "node:fs";
import { fetchEventsByIds, finishedAtFromGamma, isFinishedGammaEvent, tennisStopReason, type GammaMarketStatus } from "./gamma";
import { leagueFromGamma } from "./league";
import {
  footballCodesMatchTitle,
  isFootballSlugEvent,
  parseFootballSlug,
} from "./footballSlugs";
import { titleSimilarity, matchSides } from "./matchTitles";
import {
  DATA_DIR,
  SPORTS,
  dbPathForDay,
  dbPathForMonth,
  idxPathForSport,
  listDayFiles,
  listMonthFiles,
  sportDir,
  type Sport,
} from "./paths";

export type { Sport };

export type OverviewStats = {
  dbPath: string;
  exists: boolean;
  events: number;
  tokens: number;
  snapshots: number;
  bySport: Array<{ sport: Sport; events: number; tokens: number; snapshots: number; path: string }>;
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
  score: string | null;
  period: string | null;
  winTemp: string | null;
  league: string | null;
  volume: number | null;
  /** True when a cross-venue Poly↔Predict.fun twin exists in local DB. */
  hasTwin?: boolean;
};

export type MarketRow = {
  marketId: string;
  marketType: string;
  question: string;
  line: string | null;
  volume: number | null;
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
  /** Size within N¢ of touch (best bid − N / best ask + N). */
  bidNear3?: number;
  askNear3?: number;
  bidNear5?: number;
  askNear5?: number;
  bidNear10?: number;
  askNear10?: number;
  bids: Array<{ price: number; size: number }>;
  asks: Array<{ price: number; size: number }>;
  day?: string;
};

export type ScoreSnapshotRow = {
  capturedAt: number;
  score: string | null;
  period: string | null;
  elapsed: string | null;
};

export type LocRef = { sport: Sport; day: string };

function ensureSchema(db: Database.Database) {
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

function levelsFromJson(raw: string): Array<{ price: number; size: number }> {
  try {
    const arr = JSON.parse(raw) as Array<{ p?: number; s?: number; price?: number; size?: number }>;
    if (!Array.isArray(arr)) return [];
    const out: Array<{ price: number; size: number }> = [];
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

function bestLevel(
  levels: Array<{ price: number; size: number }>,
  side: "bid" | "ask"
): number | null {
  let best: number | null = null;
  for (const level of levels) {
    if (best == null || (side === "bid" ? level.price > best : level.price < best)) best = level.price;
  }
  return best;
}

/** Repair crossed books written before WSS uncross (bid >= ask). */
function sanitizeBook(bids: Array<{ price: number; size: number }>, asks: Array<{ price: number; size: number }>) {
  let nextBids = bids;
  let nextAsks = asks;
  for (let i = 0; i < 6; i++) {
    const bb = bestLevel(nextBids, "bid");
    const ba = bestLevel(nextAsks, "ask");
    if (bb == null || ba == null || bb < ba) break;
    nextBids = nextBids.filter((l) => l.price < ba);
  }
  nextBids = [...nextBids].sort((a, b) => b.price - a.price);
  nextAsks = [...nextAsks].sort((a, b) => a.price - b.price);
  return {
    bids: nextBids,
    asks: nextAsks,
    bestBid: bestLevel(nextBids, "bid"),
    bestAsk: bestLevel(nextAsks, "ask"),
  };
}

function sanitizeQuote(bestBid: number | null, bestAsk: number | null) {
  if (bestBid != null && bestAsk != null && bestBid >= bestAsk) {
    // Prefer ask when TOB was crossed — matches uncrossBook recorder bias.
    return { bestBid: null as number | null, bestAsk };
  }
  return { bestBid, bestAsk };
}

/**
 * True top-of-book from L2 JSON when present.
 * Stored bb/ba columns are often stale (~50¢) while bj/aj still hold the real ladder.
 */
function tobFromObRow(row: {
  bestBid: number | null;
  bestAsk: number | null;
  bidsJson?: string | null;
  asksJson?: string | null;
}): { bestBid: number | null; bestAsk: number | null } {
  if (row.bidsJson != null && row.asksJson != null && row.bidsJson !== "" && row.asksJson !== "") {
    const clean = sanitizeBook(levelsFromJson(row.bidsJson), levelsFromJson(row.asksJson));
    if (clean.bestBid != null || clean.bestAsk != null) {
      return { bestBid: clean.bestBid, bestAsk: clean.bestAsk };
    }
  }
  return sanitizeQuote(row.bestBid, row.bestAsk);
}

function openDay(sport: Sport, dayOrMonth: string, readonly = true) {
  const month = /^\d{4}-\d{2}-\d{2}$/.test(dayOrMonth) ? dayOrMonth.slice(0, 7) : dayOrMonth;
  const candidates: string[] = [dbPathForMonth(sport, month)];
  if (/^\d{4}-\d{2}-\d{2}$/.test(dayOrMonth)) {
    candidates.push(dbPathForDay(sport, dayOrMonth));
  } else {
    // Legacy: monthly key may only exist as daily files from the old monitor.
    const dir = sportDir(sport);
    if (existsSync(dir)) {
      for (const name of readdirSync(dir)) {
        if (name.startsWith(`${month}-`) && /^\d{4}-\d{2}-\d{2}\.db$/.test(name)) {
          candidates.push(dbPathForDay(sport, name.slice(0, 10)));
        }
      }
    }
  }

  let path: string | null = null;
  for (const p of candidates) {
    if (existsSync(p)) {
      path = p;
      break;
    }
  }
  if (!path) return null;
  const db = new Database(path, { readonly, fileMustExist: true });
  if (!readonly) {
    db.pragma("busy_timeout = 5000");
    ensureSchema(db);
  }
  return db;
}

function openIdx(sport: Sport) {
  const path = idxPathForSport(sport);
  if (!existsSync(path)) return null;
  return new Database(path, { readonly: true, fileMustExist: true });
}

function findLoc(eventId: string, preferSport?: Sport): LocRef | null {
  const order: Sport[] =
    preferSport != null
      ? [preferSport, ...SPORTS.filter((s) => s !== preferSport)]
      : eventId.startsWith("pf:")
        ? (["predictfun", ...SPORTS.filter((s) => s !== "predictfun")] as Sport[])
        : SPORTS;

  for (const sport of order) {
    // Prefer the shard that actually has orderbooks (events often move month when
    // Gamma updates startTime — books stay on the old month, idx points at empty).
    let best: { day: string; snaps: number } | null = null;
    for (const day of listDayFiles(sport)) {
      const db = openDay(sport, day);
      if (!db) continue;
      try {
        const exists = db.prepare(`SELECT 1 AS ok FROM ev WHERE id = ?`).get(eventId);
        if (!exists) continue;
        const snaps = (
          db.prepare(`SELECT COUNT(*) AS n FROM ob WHERE eid = ?`).get(eventId) as { n: number }
        ).n;
        if (!best || snaps > best.snaps || (snaps === best.snaps && day > best.day)) {
          best = { day, snaps };
        }
      } finally {
        db.close();
      }
    }
    if (best) return { sport, day: best.day };

    const idx = openIdx(sport);
    if (idx) {
      try {
        const row = idx.prepare(`SELECT day FROM loc WHERE eid = ?`).get(eventId) as
          | { day: string }
          | undefined;
        if (row?.day) return { sport, day: row.day };
      } finally {
        idx.close();
      }
    }
  }
  return null;
}

function findTok(tokenId: string, preferSport?: Sport): LocRef | null {
  // Predict.fun CLOB token ids are long numerics — check PF idx first.
  const likelyPf = /^\d{20,}$/.test(tokenId);
  const order: Sport[] =
    preferSport != null
      ? [preferSport, ...SPORTS.filter((s) => s !== preferSport)]
      : likelyPf
        ? (["predictfun", ...SPORTS.filter((s) => s !== "predictfun")] as Sport[])
        : SPORTS;

  for (const sport of order) {
    let best: { day: string; snaps: number } | null = null;
    for (const day of listDayFiles(sport)) {
      const db = openDay(sport, day);
      if (!db) continue;
      try {
        const exists = db.prepare(`SELECT 1 AS ok FROM tk WHERE id = ?`).get(tokenId);
        if (!exists) continue;
        const snaps = (
          db.prepare(`SELECT COUNT(*) AS n FROM ob WHERE tid = ?`).get(tokenId) as { n: number }
        ).n;
        if (!best || snaps > best.snaps || (snaps === best.snaps && day > best.day)) {
          best = { day, snaps };
        }
      } finally {
        db.close();
      }
    }
    if (best) return { sport, day: best.day };

    const idx = openIdx(sport);
    if (idx) {
      try {
        const row = idx.prepare(`SELECT day FROM tok WHERE tid = ?`).get(tokenId) as
          | { day: string }
          | undefined;
        if (row?.day) return { sport, day: row.day };
      } finally {
        idx.close();
      }
    }
  }
  return null;
}

function parseGammaVolume(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim()) {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function marketVolumesFromGamma(eventId: string, markets: GammaMarketStatus[] | undefined) {
  const out = new Map<string, number>();
  let moneyline = 0;
  for (const market of markets ?? []) {
    const vol = parseGammaVolume(market.volumeNum ?? market.volume) ?? 0;
    if (vol <= 0) continue;
    const type = market.sportsMarketType?.trim().toLowerCase() ?? "";
    if (type === "moneyline" || type === "child_moneyline") {
      moneyline += vol;
      continue;
    }
    const slug = market.slug?.trim();
    if (slug) {
      const key = `${eventId}:${slug}`;
      out.set(key, (out.get(key) ?? 0) + vol);
    }
  }
  if (moneyline > 0) out.set(`${eventId}:moneyline`, moneyline);
  return out;
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
  score?: string | null;
  period?: string | null;
  winTemp?: string | null;
  league?: string | null;
  volume?: number | null;
}): EventRow {
  return {
    ...row,
    ended: row.ended === 1,
    polyLive: row.polyLive === 1,
    closed: row.closed === 1,
    score: row.score ?? null,
    period: row.period ?? null,
    winTemp: row.winTemp ?? null,
    league: row.league ?? null,
    volume: row.volume != null && Number.isFinite(Number(row.volume)) ? Number(row.volume) : null,
  };
}

export async function refreshPolyStatuses() {
  // Only hit Gamma for matches that still need live status — not thousands of old DONE/VOID rows.
  const recentCutoff = Date.now() - 12 * 60 * 60 * 1000;
  for (const sport of SPORTS) {
    if (sport === "predictfun") continue; // no Gamma — Predexon PF catalog only
    for (const day of listDayFiles(sport)) {
      const path = dbPathForDay(sport, day);
      if (!existsSync(path)) continue;
      const db = new Database(path);
      try {
        ensureSchema(db);
        const ids = (
          db
            .prepare(
              `SELECT id AS eventId FROM ev
               WHERE (e = 0 AND c = 0)
                  OR (fa IS NOT NULL AND fa > ?)
                  OR (fa IS NULL AND e = 0)`
            )
            .all(recentCutoff) as Array<{ eventId: string }>
        ).map((row) => row.eventId);
        if (!ids.length) continue;
        const gammaRows = await fetchEventsByIds(ids);
        const update = db.prepare(`
          UPDATE ev
          SET e = @ended,
              l = @polyLive,
              c = @closed,
              gs = @gameStatus,
              fa = CASE
                WHEN @ended = 1 OR @closed = 1 THEN COALESCE(@finishedAt, fa)
                ELSE fa
              END,
              lg = COALESCE(@league, lg),
              v = COALESCE(@volume, v),
              u = @updatedAt
          WHERE id = @eventId
        `);
        const updateMarketVolume = db.prepare(`UPDATE mk SET v = @volume WHERE id = @marketId`);
        const lastScore = db.prepare(`SELECT sc, p, el FROM sc WHERE eid = @eventId ORDER BY ts DESC LIMIT 1`);
        const insertScore = db.prepare(
          `INSERT INTO sc (eid, ts, sc, p, el) VALUES (@eventId, @capturedAt, @score, @period, @elapsed)`
        );
        const now = Date.now();
        const tx = db.transaction(() => {
          for (const row of gammaRows) {
            const id = String(row.id);
            const tennisReason = sport === "tennis" ? tennisStopReason(row) : null;
            const finished =
              sport === "tennis"
                ? tennisReason != null || isFinishedGammaEvent(row, { sport })
                : isFinishedGammaEvent(row, { sport });
            update.run({
              eventId: id,
              ended: finished ? 1 : 0,
              polyLive: row.live === true && !finished ? 1 : 0,
              closed: row.closed === true ? 1 : 0,
              gameStatus:
                sport === "tennis"
                  ? tennisReason ?? (row.gameStatus?.trim() || row.period?.trim() || null)
                  : row.gameStatus?.trim() || row.period?.trim() || null,
              finishedAt: finished ? finishedAtFromGamma(row, { sport }) : null,
              league: leagueFromGamma({
                series: row.series,
                seriesSlug: row.seriesSlug,
                tags: row.tags,
                slug: row.slug,
              }),
              volume: parseGammaVolume(row.volume),
              updatedAt: now,
            });
            for (const [marketId, volume] of marketVolumesFromGamma(id, row.markets)) {
              updateMarketVolume.run({ marketId, volume });
            }
            const score = row.score?.trim() || null;
            const period = row.period?.trim() || null;
            const elapsed = row.elapsed?.trim() || null;
            if (!score && !period && !elapsed) continue;
            const prev = lastScore.get({ eventId: id }) as
              | { sc: string | null; p: string | null; el: string | null }
              | undefined;
            if (prev && prev.sc === score && prev.p === period && prev.el === elapsed) continue;
            insertScore.run({ eventId: id, capturedAt: now, score, period, elapsed });
          }
        });
        tx();
      } finally {
        db.close();
      }
    }
  }
}

let overviewCache: { at: number; value: OverviewStats } | null = null;
const OVERVIEW_CACHE_MS = 15_000;

export function getOverview(): OverviewStats {
  const now = Date.now();
  if (overviewCache && now - overviewCache.at < OVERVIEW_CACHE_MS) {
    return overviewCache.value;
  }
  const bySport: OverviewStats["bySport"] = [];
  let events = 0;
  let tokens = 0;
  let snapshots = 0;
  let any = false;
  for (const sport of SPORTS) {
    const path = sportDir(sport);
    let e = 0;
    let t = 0;
    let s = 0;
    const days = listDayFiles(sport);
    if (days.length) any = true;
    for (const day of days) {
      const db = openDay(sport, day);
      if (!db) continue;
      try {
        e += (db.prepare(`SELECT COUNT(*) AS n FROM ev`).get() as { n: number }).n;
        t += (db.prepare(`SELECT COUNT(*) AS n FROM tk`).get() as { n: number }).n;
        s += (db.prepare(`SELECT COUNT(*) AS n FROM ob`).get() as { n: number }).n;
      } finally {
        db.close();
      }
    }
    events += e;
    tokens += t;
    snapshots += s;
    bySport.push({ sport, events: e, tokens: t, snapshots: s, path });
  }
  const value = { dbPath: DATA_DIR, exists: any, events, tokens, snapshots, bySport };
  overviewCache = { at: now, value };
  return value;
}

export function listEvents(sport?: Sport): EventRow[] {
  const key = sport ?? "all";
  const now = Date.now();
  const hit = listEventsCache.get(key);
  if (hit && now - hit.at < LIST_EVENTS_TTL_MS) return hit.rows;

  const sports = sport ? [sport] : SPORTS;
  const byId = new Map<string, EventRow>();
  for (const s of sports) {
    // listDayFiles is newest-first; first seen wins (prefer newest day)
    for (const day of listDayFiles(s)) {
      const db = openDay(s, day);
      if (!db) continue;
      try {
        const rows = db
          .prepare(
            `SELECT
               e.id AS eventId,
               e.t AS title,
               e.s AS slug,
               e.st AS startTime,
               e.d AS eventDate,
               e.e AS ended,
               e.l AS polyLive,
               e.c AS closed,
               e.gs AS gameStatus,
               e.fa AS finishedAt,
               e.lg AS league,
               e.v AS volume,
               (SELECT COUNT(*) FROM mk m WHERE m.eid = e.id) AS marketCount,
               (SELECT COUNT(*) FROM tk t WHERE t.eid = e.id) AS tokenCount,
               (SELECT MAX(o.ts) FROM ob o WHERE o.eid = e.id) AS lastSnapshotAt,
               (SELECT sc.sc FROM sc WHERE sc.eid = e.id ORDER BY sc.ts DESC LIMIT 1) AS score,
               (SELECT sc.p FROM sc WHERE sc.eid = e.id ORDER BY sc.ts DESC LIMIT 1) AS period,
               CASE WHEN ? = 'weather' THEN (
                 SELECT t.lb FROM tk t
                 WHERE t.eid = e.id AND t.sd = 'yes'
                 ORDER BY COALESCE((
                   SELECT o.bb FROM ob o WHERE o.tid = t.id ORDER BY o.ts DESC LIMIT 1
                 ), 0) DESC,
                 COALESCE((
                   SELECT o.ba FROM ob o WHERE o.tid = t.id ORDER BY o.ts DESC LIMIT 1
                 ), 0) DESC
                 LIMIT 1
               ) ELSE NULL END AS winTemp
             FROM ev e
             ORDER BY e.e ASC, e.c ASC, e.fa DESC, lastSnapshotAt DESC, COALESCE(e.d, '9999-12-31') DESC, e.t`
          )
          .all(s) as Array<Omit<Parameters<typeof mapEventRow>[0], "sport"> & { sport?: Sport }>;
        for (const row of rows) {
          const mapped = mapEventRow({ ...row, sport: s });
          const prev = byId.get(row.eventId);
          // Prefer the shard that has books when Gamma moved the event across months.
          if (!prev) {
            byId.set(row.eventId, mapped);
          } else if ((mapped.lastSnapshotAt ?? 0) > (prev.lastSnapshotAt ?? 0)) {
            byId.set(row.eventId, mapped);
          }
        }
      } finally {
        db.close();
      }
    }
  }
  const out = [...byId.values()];
  out.sort((a, b) => {
    const ae = a.ended || a.closed ? 1 : 0;
    const be = b.ended || b.closed ? 1 : 0;
    if (ae !== be) return ae - be;
    return (b.lastSnapshotAt ?? 0) - (a.lastSnapshotAt ?? 0);
  });
  listEventsCache.set(key, { at: now, rows: out });
  return out;
}

let listEventsCache = new Map<string, { at: number; rows: EventRow[] }>();
const LIST_EVENTS_TTL_MS = 60_000;

let twinCatalogCache: {
  at: number;
  poly: EventRow[];
  pf: EventRow[];
  /** PF football-code events (titles often lack "vs") — matched via slug codes. */
  pfFootball: EventRow[];
  polyByName: Map<string, number[]>;
  pfByName: Map<string, number[]>;
  polyByDate: Map<string, EventRow[]>;
} | null = null;
const TWIN_CATALOG_TTL_MS = 5 * 60_000;

/** Last-name / team-token / weather-city keys for inverted twin index. */
function twinNameKeys(title: string): string[] {
  const sides = matchSides(title);
  const keys: string[] = [];
  if (sides) {
    for (const side of sides) {
      const parts = side.split(/\s+/).filter(Boolean);
      const last = parts[parts.length - 1];
      if (last && last.length >= 3) keys.push(last);
      // Also index penultimate for double-barrelled / team names
      if (parts.length >= 2) {
        const prev = parts[parts.length - 2]!;
        if (prev.length >= 4) keys.push(prev);
      }
    }
  } else {
    const city = weatherCityKey(title);
    if (city) keys.push(city);
    // Multi-word cities: also index each word (buenos, aires)
    const m = /temperature\s+in\s+(.+?)\s+on\s+/i.exec(title);
    if (m?.[1]) {
      for (const w of m[1]
        .toLowerCase()
        .replace(/\(.*?\)/g, " ")
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((t) => t.length >= 4)) {
        if (!keys.includes(w)) keys.push(w);
      }
    }
  }
  return keys;
}

function buildNameIndex(rows: EventRow[]): Map<string, number[]> {
  const map = new Map<string, number[]>();
  for (let i = 0; i < rows.length; i++) {
    for (const key of twinNameKeys(rows[i]!.title)) {
      const list = map.get(key) ?? [];
      list.push(i);
      map.set(key, list);
    }
  }
  return map;
}

function candidatesByName(
  title: string,
  rows: EventRow[],
  index: Map<string, number[]>
): EventRow[] {
  const keys = twinNameKeys(title);
  if (!keys.length) return rows;
  const seen = new Set<number>();
  const out: EventRow[] = [];
  for (const key of keys) {
    for (const i of index.get(key) ?? []) {
      if (seen.has(i)) continue;
      seen.add(i);
      out.push(rows[i]!);
    }
  }
  // No surname overlap → no twin (skip O(n) full scan).
  return out;
}

/** Only titles that can twin with Polymarket (sports A vs B, or daily high-temp weather). */
function isTwinableTitle(title: string): boolean {
  if (/highest\s+temp/i.test(title) || /temperature\s+in\s+/i.test(title)) return true;
  if (!/\bvs\.?\b/i.test(title)) return false;
  if (/^(map|game|set)\s*\d+/i.test(title.trim())) return false;
  return true;
}

/** City token from "Highest temperature in Tokyo on October 2?" */
function weatherCityKey(title: string): string | null {
  const m =
    /temperature\s+in\s+(.+?)\s+on\s+/i.exec(title) ??
    /highest\s+temp(?:erature)?\s+in\s+(.+?)(?:\s+on\s+|\?|$)/i.exec(title);
  if (!m?.[1]) return null;
  const city = m[1]
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Prefer last significant word (e.g. "buenos aires" → aires + buenos via split)
  const parts = city.split(" ").filter((t) => t.length >= 3);
  return parts[parts.length - 1] ?? null;
}

function buildDateIndex(rows: EventRow[]): Map<string, EventRow[]> {
  const map = new Map<string, EventRow[]>();
  for (const ev of rows) {
    const days = new Set<string>();
    if (ev.eventDate) days.add(ev.eventDate);
    const start = ev.startTime ? ev.startTime.slice(0, 10) : null;
    if (start) days.add(start);
    for (const d of days) {
      const list = map.get(d) ?? [];
      list.push(ev);
      map.set(d, list);
    }
  }
  return map;
}

function twinCatalogs() {
  const now = Date.now();
  if (twinCatalogCache && now - twinCatalogCache.at < TWIN_CATALOG_TTL_MS) return twinCatalogCache;
  const polySports = SPORTS.filter((s) => s !== "predictfun");
  const poly: EventRow[] = [];
  for (const s of polySports) poly.push(...listEvents(s));
  const allPf = listEvents("predictfun");
  // Football code-slug events must twin via slug codes only — repaired titles can
  // falsely Jaccard-match the wrong Poly fixture (e.g. ARG→Argyle).
  const pfFootball = allPf.filter(
    (ev) => isFootballSlugEvent(ev.eventId) || isFootballSlugEvent(ev.slug),
  );
  const footballIds = new Set(pfFootball.map((ev) => ev.eventId));
  const pf = allPf.filter((ev) => isTwinableTitle(ev.title) && !footballIds.has(ev.eventId));
  twinCatalogCache = {
    at: now,
    poly,
    pf,
    pfFootball,
    polyByName: buildNameIndex(poly),
    pfByName: buildNameIndex(pf),
    polyByDate: buildDateIndex(poly.filter((ev) => ev.sport === "soccer" || ev.sport === "football")),
  };
  return twinCatalogCache;
}

/** Twin via epl-bou-liv-YYYY-MM-DD style PF slugs ↔ Poly soccer titles. */
function footballSlugTwinScore(polyTitle: string, pfEv: EventRow, anchorMs: number | null): number {
  const parts = parseFootballSlug(pfEv.eventId) ?? parseFootballSlug(pfEv.slug);
  if (!parts) return 0;
  if (!footballCodesMatchTitle(parts.home, parts.away, polyTitle, parts.league)) return 0;
  let score = 0.92;
  const slugDay = Date.parse(`${parts.date}T12:00:00Z`);
  if (Number.isFinite(slugDay) && anchorMs != null) {
    const days = Math.abs(anchorMs - slugDay) / 86_400_000;
    if (days <= 1) score = 1;
    else if (days <= 3) score = 0.96;
    else if (days > 14) return 0;
  }
  return score;
}

function findFootballPolyTwin(pfEv: EventRow): (EventRow & { score: number }) | null {
  const parts = parseFootballSlug(pfEv.eventId) ?? parseFootballSlug(pfEv.slug);
  if (!parts) return null;
  const cat = twinCatalogs();
  const pool = new Set<EventRow>();
  for (const d of [parts.date, pfEv.eventDate].filter(Boolean) as string[]) {
    for (const ev of cat.polyByDate.get(d) ?? []) pool.add(ev);
  }
  // Also scan ±1 day from slug date
  const base = Date.parse(`${parts.date}T12:00:00Z`);
  if (Number.isFinite(base)) {
    for (const delta of [-1, 1]) {
      const d = new Date(base + delta * 86_400_000).toISOString().slice(0, 10);
      for (const ev of cat.polyByDate.get(d) ?? []) pool.add(ev);
    }
  }
  let best: (EventRow & { score: number }) | null = null;
  for (const ev of pool) {
    const score = footballSlugTwinScore(ev.title, pfEv, eventAnchorMs(ev));
    if (score < 0.55) continue;
    if (!best || score > best.score || (score === best.score && (ev.volume ?? 0) > (best.volume ?? 0))) {
      best = { ...ev, score };
    }
  }
  return best;
}

function eventAnchorMs(ev: Pick<EventRow, "startTime" | "eventDate" | "finishedAt" | "lastSnapshotAt">): number | null {
  const candidates = [ev.startTime, ev.eventDate]
    .map((v) => (v ? Date.parse(v) : NaN))
    .filter((n) => Number.isFinite(n));
  if (candidates.length) return Math.min(...candidates);
  if (ev.finishedAt != null && Number.isFinite(ev.finishedAt)) return ev.finishedAt;
  if (ev.lastSnapshotAt != null && Number.isFinite(ev.lastSnapshotAt)) return ev.lastSnapshotAt;
  return null;
}

/** Soft date boost — never kill a strong name match (MLB series / delayed start labels). */
function twinScore(
  title: string,
  anchorMs: number | null,
  ev: EventRow
): number {
  const base = titleSimilarity(title, ev.title);
  if (base < 0.55) return 0;
  if (anchorMs == null) return base;
  const other = eventAnchorMs(ev);
  if (other == null) return base;
  const days = Math.abs(anchorMs - other) / 86_400_000;
  if (days <= 2) return Math.min(1, base + 0.08);
  if (days <= 7) return base;
  // Weak demotion only — titleSimilarity already rejects cross-tournament rematches.
  return Math.max(0.55, base * 0.9);
}

/** Best Polymarket event matches for a Predict.Fun title (local catalog only). */
export function findPolyTwins(
  title: string,
  limit = 5,
  opts?: { anchorMs?: number | null; pfEventId?: string; pfSlug?: string }
): Array<EventRow & { score: number }> {
  const cat = twinCatalogs();
  const scored: Array<EventRow & { score: number }> = [];

  // Football slug path (BOU/LIV codes) when title is not "A vs B".
  const pfKey = opts?.pfEventId ?? opts?.pfSlug ?? "";
  if (pfKey && isFootballSlugEvent(pfKey)) {
    const fakePf: EventRow = {
      eventId: opts?.pfEventId ?? pfKey,
      sport: "predictfun",
      title,
      slug: opts?.pfSlug ?? pfKey,
      startTime: null,
      eventDate: parseFootballSlug(pfKey)?.date ?? null,
      ended: true,
      polyLive: false,
      closed: true,
      gameStatus: null,
      finishedAt: null,
      marketCount: 0,
      tokenCount: 0,
      lastSnapshotAt: null,
      score: null,
      period: null,
      winTemp: null,
      league: null,
      volume: null,
    };
    const hit = findFootballPolyTwin(fakePf);
    if (hit) scored.push(hit);
  }

  if (isTwinableTitle(title)) {
    const candidates = candidatesByName(title, cat.poly, cat.polyByName);
    for (const ev of candidates) {
      const score = twinScore(title, opts?.anchorMs ?? null, ev);
      if (score < 0.55) continue;
      if (scored.some((s) => s.eventId === ev.eventId)) continue;
      scored.push({ ...ev, score });
    }
  }

  scored.sort((a, b) => b.score - a.score || (b.volume ?? 0) - (a.volume ?? 0));
  return scored.slice(0, limit);
}

/** Best Predict.Fun event matches for a Polymarket title. */
export function findPredictTwins(
  title: string,
  limit = 5,
  opts?: { anchorMs?: number | null }
): Array<EventRow & { score: number }> {
  const cat = twinCatalogs();
  const scored: Array<EventRow & { score: number }> = [];

  // Title-based tennis / named fixtures
  if (isTwinableTitle(title)) {
    const candidates = candidatesByName(title, cat.pf, cat.pfByName);
    for (const ev of candidates) {
      const score = twinScore(title, opts?.anchorMs ?? null, ev);
      if (score < 0.55) continue;
      scored.push({ ...ev, score });
    }
  }

  // Football code slugs in PF catalog
  for (const pfEv of cat.pfFootball) {
    const score = footballSlugTwinScore(title, pfEv, opts?.anchorMs ?? null);
    if (score < 0.55) continue;
    if (scored.some((s) => s.eventId === pfEv.eventId)) continue;
    scored.push({ ...pfEv, score });
  }

  scored.sort((a, b) => b.score - a.score || (b.volume ?? 0) - (a.volume ?? 0));
  return scored.slice(0, limit);
}

let twinIdCache: { at: number; ids: Set<string> } | null = null;

/** Event IDs (Poly + Predict.fun) that have a ≥0.55 cross-venue twin. */
export function twinMatchedIds(): Set<string> {
  const now = Date.now();
  if (twinIdCache && now - twinIdCache.at < TWIN_CATALOG_TTL_MS) return twinIdCache.ids;
  const { pf, pfFootball } = twinCatalogs();
  const ids = new Set<string>();
  // PF → Poly only (indexed). Reverse full tennis scan was O(n·m) and froze reloads.
  for (const pfEv of pf) {
    const best = findPolyTwins(pfEv.title, 1, {
      anchorMs: eventAnchorMs(pfEv),
      pfEventId: pfEv.eventId,
      pfSlug: pfEv.slug,
    })[0];
    if (!best || best.score < 0.55) continue;
    ids.add(pfEv.eventId);
    ids.add(best.eventId);
  }
  for (const pfEv of pfFootball) {
    if (ids.has(pfEv.eventId)) continue;
    const best = findFootballPolyTwin(pfEv);
    if (!best || best.score < 0.55) continue;
    ids.add(pfEv.eventId);
    ids.add(best.eventId);
  }
  twinIdCache = { at: now, ids };
  return ids;
}

/** Annotate rows with hasTwin for list UIs. */
export function withTwinFlags<T extends EventRow>(rows: T[]): Array<T & { hasTwin: boolean }> {
  const ids = twinMatchedIds();
  return rows.map((ev) => ({ ...ev, hasTwin: ids.has(ev.eventId) }));
}

export function getEvent(eventId: string) {
  const loc = findLoc(eventId);
  if (!loc) return null;
  const db = openDay(loc.sport, loc.day);
  if (!db) return null;
  try {
    const event = db
      .prepare(
        `SELECT id AS eventId, t AS title, s AS slug, st AS startTime, d AS eventDate,
                e AS ended, l AS polyLive, c AS closed, gs AS gameStatus, fa AS finishedAt,
                lg AS league, v AS volume
         FROM ev WHERE id = ?`
      )
      .get(eventId) as
      | Omit<Parameters<typeof mapEventRow>[0], "sport" | "marketCount" | "tokenCount" | "lastSnapshotAt">
      | undefined;
    if (!event) return null;

    const markets = db
      .prepare(
        `SELECT id AS marketId, mt AS marketType, q AS question, ln AS line, v AS volume
         FROM mk WHERE eid = ?
         ORDER BY CASE mt WHEN 'moneyline' THEN 0 ELSE 1 END, COALESCE(ln, '0')`
      )
      .all(eventId) as Array<Omit<MarketRow, "tokens">>;

    const tokens = db
      .prepare(
        `SELECT
           t.id AS tokenId,
           t.mid AS marketId,
           t.sd AS side,
           t.lb AS label,
           t.ln AS line,
           o.bb AS lastBid,
           o.ba AS lastAsk,
           o.ts AS lastAt
         FROM tk t
         LEFT JOIN ob o ON o.id = (
           SELECT id FROM ob WHERE tid = t.id ORDER BY ts DESC LIMIT 1
         )
         WHERE t.eid = ?
         ORDER BY t.mt, COALESCE(t.ln, '0'),
           CASE t.sd WHEN 'yes' THEN 0 WHEN 'over' THEN 0 WHEN 'home' THEN 0 WHEN 'no' THEN 1 WHEN 'under' THEN 1 ELSE 2 END,
           t.sd`
      )
      .all(eventId) as Array<TokenRow & { marketId: string }>;

    const marketRows: MarketRow[] = markets.map((market) => ({
      ...market,
      volume:
        market.volume != null && Number.isFinite(Number(market.volume)) ? Number(market.volume) : null,
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
      db.prepare(`SELECT MAX(ts) AS ts FROM ob WHERE eid = ?`).get(eventId) as { ts: number | null }
    ).ts;

    return {
      ...mapEventRow({
        ...event,
        sport: loc.sport,
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

/** Sum size of levels within `band` (absolute price) of the touch. */
function nearTouchDepth(
  levels: Array<{ price: number; size: number }>,
  touch: number | null,
  side: "bid" | "ask",
  band: number,
): number {
  if (touch == null || !Number.isFinite(touch) || band <= 0 || !levels.length) return 0;
  let sum = 0;
  if (side === "bid") {
    const floor = touch - band;
    for (const lv of levels) {
      if (lv.price >= floor && lv.price <= touch + 1e-9) sum += lv.size;
    }
  } else {
    const ceil = touch + band;
    for (const lv of levels) {
      if (lv.price <= ceil && lv.price >= touch - 1e-9) sum += lv.size;
    }
  }
  return sum;
}

export function getTokenHistory(
  tokenId: string,
  preferSport?: Sport
): {
  token: (TokenRow & { eventId: string; sport: Sport; marketType: string }) | null;
  eventTitle: string | null;
  timeline: {
    id: number[];
    at: number[];
    bestBid: Array<number | null>;
    bestAsk: Array<number | null>;
    bidDepth: number[];
    askDepth: number[];
    bidNear3: number[];
    askNear3: number[];
    bidNear5: number[];
    askNear5: number[];
    bidNear10: number[];
    askNear10: number[];
    day: string[];
  };
  totalSnapshots: number;
  eventFinished: boolean;
} {
  const emptyTimeline = {
    id: [] as number[],
    at: [] as number[],
    bestBid: [] as Array<number | null>,
    bestAsk: [] as Array<number | null>,
    bidDepth: [] as number[],
    askDepth: [] as number[],
    bidNear3: [] as number[],
    askNear3: [] as number[],
    bidNear5: [] as number[],
    askNear5: [] as number[],
    bidNear10: [] as number[],
    askNear10: [] as number[],
    day: [] as string[],
  };
  const empty = {
    token: null,
    eventTitle: null,
    timeline: emptyTimeline,
    totalSnapshots: 0,
    eventFinished: false,
  };
  const loc = findTok(tokenId, preferSport);
  if (!loc) return empty;
  const db = openDay(loc.sport, loc.day);
  if (!db) return empty;
  try {
    const token = db
      .prepare(
        `SELECT id AS tokenId, eid AS eventId, mt AS marketType, sd AS side, lb AS label, ln AS line
         FROM tk WHERE id = ?`
      )
      .get(tokenId) as
      | (TokenRow & { eventId: string; marketType: string; lastBid?: null; lastAsk?: null; lastAt?: null })
      | undefined;

    const eventTitle = token
      ? ((db.prepare(`SELECT t AS title FROM ev WHERE id = ?`).get(token.eventId) as { title: string } | undefined)
          ?.title ?? null)
      : null;

    const rawRows = db
      .prepare(
        `SELECT id, ts AS capturedAt, bb AS bestBid, ba AS bestAsk, bd AS bidDepth, ad AS askDepth
         FROM ob WHERE tid = ? ORDER BY ts ASC`,
      )
      .all(tokenId) as Array<{
      id: number;
      capturedAt: number;
      bestBid: number | null;
      bestAsk: number | null;
      bidDepth: number | null;
      askDepth: number | null;
    }>;

    const n = rawRows.length;
    let keepIdx = Array.from({ length: n }, (_, i) => i);
    // Soft-cap huge histories (PF backfills) so reload doesn't freeze on JSON expand.
    const MAX_HISTORY_POINTS = 12_000;
    if (n > MAX_HISTORY_POINTS) {
      const step = Math.ceil(n / MAX_HISTORY_POINTS);
      keepIdx = [];
      for (let i = 0; i < n; i += step) keepIdx.push(i);
      if (keepIdx[keepIdx.length - 1] !== n - 1) keepIdx.push(n - 1);
    }

    // Load L2 only for kept frames — used for 3¢/5¢/10¢ near-touch depth.
    const keepIds = keepIdx.map((i) => rawRows[i]!.id);
    const l2ById = new Map<number, { bids: Array<{ price: number; size: number }>; asks: Array<{ price: number; size: number }> }>();
    if (keepIds.length) {
      // Chunk IN-lists to stay under SQLite variable limits.
      const CHUNK = 400;
      for (let c = 0; c < keepIds.length; c += CHUNK) {
        const chunk = keepIds.slice(c, c + CHUNK);
        const ph = chunk.map(() => "?").join(",");
        const rows = db
          .prepare(`SELECT id, bj AS bidsJson, aj AS asksJson FROM ob WHERE id IN (${ph})`)
          .all(...chunk) as Array<{ id: number; bidsJson: string; asksJson: string }>;
        for (const r of rows) {
          l2ById.set(r.id, {
            bids: levelsFromJson(r.bidsJson ?? "[]"),
            asks: levelsFromJson(r.asksJson ?? "[]"),
          });
        }
      }
    }

    const m = keepIdx.length;
    const timeline = {
      id: new Array<number>(m),
      at: new Array<number>(m),
      bestBid: new Array<number | null>(m),
      bestAsk: new Array<number | null>(m),
      bidDepth: new Array<number>(m),
      askDepth: new Array<number>(m),
      bidNear3: new Array<number>(m),
      askNear3: new Array<number>(m),
      bidNear5: new Array<number>(m),
      askNear5: new Array<number>(m),
      bidNear10: new Array<number>(m),
      askNear10: new Array<number>(m),
      day: new Array<string>(m),
    };

    for (let j = 0; j < m; j++) {
      const row = rawRows[keepIdx[j]!]!;
      const l2 = l2ById.get(row.id);
      const clean = l2
        ? sanitizeBook(l2.bids, l2.asks)
        : { bids: [] as Array<{ price: number; size: number }>, asks: [] as Array<{ price: number; size: number }>, bestBid: null as number | null, bestAsk: null as number | null };
      const q = clean.bestBid != null || clean.bestAsk != null
        ? { bestBid: clean.bestBid, bestAsk: clean.bestAsk }
        : sanitizeQuote(row.bestBid, row.bestAsk);
      const touchBid = q.bestBid;
      const touchAsk = q.bestAsk;
      const bids = clean.bids;
      const asks = clean.asks;
      timeline.id[j] = row.id;
      timeline.at[j] = row.capturedAt;
      timeline.bestBid[j] = q.bestBid;
      timeline.bestAsk[j] = q.bestAsk;
      timeline.bidDepth[j] = Number(row.bidDepth) || (bids.reduce((s, lv) => s + lv.size, 0) || 0);
      timeline.askDepth[j] = Number(row.askDepth) || (asks.reduce((s, lv) => s + lv.size, 0) || 0);
      timeline.bidNear3[j] = nearTouchDepth(bids, touchBid, "bid", 0.03);
      timeline.askNear3[j] = nearTouchDepth(asks, touchAsk, "ask", 0.03);
      timeline.bidNear5[j] = nearTouchDepth(bids, touchBid, "bid", 0.05);
      timeline.askNear5[j] = nearTouchDepth(asks, touchAsk, "ask", 0.05);
      timeline.bidNear10[j] = nearTouchDepth(bids, touchBid, "bid", 0.1);
      timeline.askNear10[j] = nearTouchDepth(asks, touchAsk, "ask", 0.1);
      timeline.day[j] = loc.day;
    }

    const eventStatus = token
      ? (db.prepare(`SELECT e AS ended, c AS closed FROM ev WHERE id = ?`).get(token.eventId) as
          | { ended: number; closed: number }
          | undefined)
      : undefined;
    const eventFinished = Boolean(eventStatus && (eventStatus.ended === 1 || eventStatus.closed === 1));

    return {
      token: token
        ? {
            tokenId: token.tokenId,
            side: token.side,
            label: token.label,
            line: token.line,
            lastBid: null,
            lastAsk: null,
            lastAt: null,
            eventId: token.eventId,
            sport: loc.sport,
            marketType: token.marketType,
          }
        : null,
      eventTitle,
      timeline,
      totalSnapshots: n,
      eventFinished,
    };
  } finally {
    db.close();
  }
}

function readSnapshotRow(db: Database.Database, id: number, day?: string): SnapshotRow | null {
  const row = db
    .prepare(
      `SELECT id, ts AS capturedAt, bb AS bestBid, ba AS bestAsk,
              bd AS bidDepth, ad AS askDepth, bj AS bidsJson, aj AS asksJson
       FROM ob WHERE id = ?`
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
  const bids = levelsFromJson(row.bidsJson);
  const asks = levelsFromJson(row.asksJson);
  const clean = sanitizeBook(bids, asks);
  return {
    id: row.id,
    capturedAt: row.capturedAt,
    bestBid: clean.bestBid ?? row.bestBid,
    bestAsk: clean.bestAsk ?? row.bestAsk,
    bidDepth: row.bidDepth,
    askDepth: row.askDepth,
    bids: clean.bids,
    asks: clean.asks,
    ...(day ? { day } : {}),
  };
}

export function getSnapshotById(id: number, sport?: Sport | null, day?: string | null): SnapshotRow | null {
  if (sport && day) {
    const db = openDay(sport, day);
    if (!db) return null;
    try {
      return readSnapshotRow(db, id, day);
    } finally {
      db.close();
    }
  }

  if (sport) {
    for (const d of listDayFiles(sport)) {
      const db = openDay(sport, d);
      if (!db) continue;
      try {
        const snap = readSnapshotRow(db, id, d);
        if (snap) return snap;
      } finally {
        db.close();
      }
    }
    return null;
  }

  // Legacy: scan all sports/days
  for (const s of SPORTS) {
    for (const d of listDayFiles(s)) {
      const db = openDay(s, d);
      if (!db) continue;
      try {
        const snap = readSnapshotRow(db, id, d);
        if (snap) return snap;
      } finally {
        db.close();
      }
    }
  }
  return null;
}

/** Dense bid/ask series for sidebar scrub — every TOB change in the match window. */
export function getEventQuoteSeries(eventId: string): Record<
  string,
  Array<{ id: number; capturedAt: number; bestBid: number | null; bestAsk: number | null; day: string }>
> {
  const loc = findLoc(eventId);
  if (!loc) return {};
  const db = openDay(loc.sport, loc.day);
  if (!db) return {};
  try {
    const tokens = db.prepare(`SELECT id AS tokenId FROM tk WHERE eid = ?`).all(eventId) as Array<{
      tokenId: string;
    }>;
    if (!tokens.length) return {};

    const span = db
      .prepare(`SELECT MIN(ts) AS a, MAX(ts) AS b FROM ob WHERE eid = ?`)
      .get(eventId) as { a: number | null; b: number | null };

    if (span?.a == null || span?.b == null) return {};

    const lo = span.a;
    const hi = span.b;

    const stmt = db.prepare(
      `SELECT id, ts AS capturedAt, bb AS bestBid, ba AS bestAsk
       FROM ob
       WHERE tid = ? AND ts >= ? AND ts <= ?
       ORDER BY ts ASC`
    );

    const out: Record<
      string,
      Array<{ id: number; capturedAt: number; bestBid: number | null; bestAsk: number | null; day: string }>
    > = {};

    const MAX_POINTS = 12_000;
    for (const { tokenId } of tokens) {
      const rows = stmt.all(tokenId, lo, hi) as Array<{
        id: number;
        capturedAt: number;
        bestBid: number | null;
        bestAsk: number | null;
      }>;
      const series: Array<{
        id: number;
        capturedAt: number;
        bestBid: number | null;
        bestAsk: number | null;
        day: string;
      }> = [];
      let lastKeep = -Infinity;
      for (const row of rows) {
        const q = sanitizeQuote(row.bestBid, row.bestAsk);
        const prev = series[series.length - 1];
        const changed = !prev || prev.bestBid !== q.bestBid || prev.bestAsk !== q.bestAsk;
        if (!changed && row.capturedAt - lastKeep < 2_000) continue;
        series.push({
          id: row.id,
          capturedAt: row.capturedAt,
          bestBid: q.bestBid,
          bestAsk: q.bestAsk,
          day: loc.day,
        });
        lastKeep = row.capturedAt;
      }
      // Soft-cap so venue switch stays snappy on dense PF books.
      if (series.length > MAX_POINTS) {
        const step = Math.ceil(series.length / MAX_POINTS);
        const kept = [];
        for (let i = 0; i < series.length; i += step) kept.push(series[i]!);
        const last = series[series.length - 1]!;
        if (kept[kept.length - 1]?.id !== last.id) kept.push(last);
        out[tokenId] = kept;
      } else {
        out[tokenId] = series;
      }
    }

    return out;
  } finally {
    db.close();
  }
}

/** Exact top-of-book for every token at scrub time (not the downsampled series). */
export function getEventQuotesAt(
  eventId: string,
  atMs: number
): Record<string, { capturedAt: number; bestBid: number | null; bestAsk: number | null }> {
  const loc = findLoc(eventId);
  if (!loc) return {};
  const db = openDay(loc.sport, loc.day);
  if (!db) return {};
  try {
    const tokens = db.prepare(`SELECT id AS tokenId FROM tk WHERE eid = ?`).all(eventId) as Array<{
      tokenId: string;
    }>;
    if (!tokens.length || !Number.isFinite(atMs)) return {};

    const stmt = db.prepare(
      `SELECT bb AS bestBid, ba AS bestAsk, bj AS bidsJson, aj AS asksJson, ts AS capturedAt
       FROM ob WHERE tid = ? AND ts <= ? ORDER BY ts DESC LIMIT 1`
    );

    const out: Record<string, { capturedAt: number; bestBid: number | null; bestAsk: number | null }> =
      {};
    for (const { tokenId } of tokens) {
      const row = stmt.get(tokenId, atMs) as
        | {
            bestBid: number | null;
            bestAsk: number | null;
            bidsJson: string | null;
            asksJson: string | null;
            capturedAt: number;
          }
        | undefined;
      if (!row) continue;
      const q = tobFromObRow(row);
      out[tokenId] = {
        capturedAt: row.capturedAt,
        bestBid: q.bestBid,
        bestAsk: q.bestAsk,
      };
    }
    return out;
  } finally {
    db.close();
  }
}

export function getScoreHistory(eventId: string): ScoreSnapshotRow[] {
  const loc = findLoc(eventId);
  if (!loc) return [];
  const db = openDay(loc.sport, loc.day);
  if (!db) return [];
  try {
    return db
      .prepare(`SELECT ts AS capturedAt, sc AS score, p AS period, el AS elapsed FROM sc WHERE eid = ? ORDER BY ts ASC`)
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
  const loc = findLoc(eventId);
  if (!loc) return;
  const path = dbPathForDay(loc.sport, loc.day);
  if (!existsSync(path)) return;
  const db = new Database(path);
  try {
    ensureSchema(db);
    const last = db
      .prepare(`SELECT sc, p, el FROM sc WHERE eid = ? ORDER BY ts DESC LIMIT 1`)
      .get(eventId) as { sc: string | null; p: string | null; el: string | null } | undefined;
    if (last && last.sc === score && last.p === period && last.el === elapsed) return;
    db.prepare(`INSERT INTO sc (eid, ts, sc, p, el) VALUES (?, ?, ?, ?, ?)`).run(
      eventId,
      Date.now(),
      score,
      period,
      elapsed
    );
  } finally {
    db.close();
  }
}

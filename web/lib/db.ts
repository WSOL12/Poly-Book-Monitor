import Database from "better-sqlite3";
import { existsSync, readdirSync } from "node:fs";
import { fetchEventsByIds, finishedAtFromGamma, isFinishedGammaEvent, tennisStopReason, type GammaMarketStatus } from "./gamma";
import { leagueFromGamma } from "./league";
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

function findLoc(eventId: string): LocRef | null {
  for (const sport of SPORTS) {
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
  for (const sport of SPORTS) {
    for (const day of listDayFiles(sport)) {
      const db = openDay(sport, day);
      if (!db) continue;
      try {
        const row = db.prepare(`SELECT 1 AS ok FROM ev WHERE id = ?`).get(eventId);
        if (row) return { sport, day };
      } finally {
        db.close();
      }
    }
  }
  return null;
}

function findTok(tokenId: string): LocRef | null {
  for (const sport of SPORTS) {
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
  for (const sport of SPORTS) {
    for (const day of listDayFiles(sport)) {
      const db = openDay(sport, day);
      if (!db) continue;
      try {
        const row = db.prepare(`SELECT 1 AS ok FROM tk WHERE id = ?`).get(tokenId);
        if (row) return { sport, day };
      } finally {
        db.close();
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
  for (const sport of SPORTS) {
    for (const day of listDayFiles(sport)) {
      const path = dbPathForDay(sport, day);
      if (!existsSync(path)) continue;
      const db = new Database(path);
      try {
        ensureSchema(db);
        const ids = (db.prepare(`SELECT id AS eventId FROM ev`).all() as Array<{ eventId: string }>).map(
          (row) => row.eventId
        );
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

export function getOverview(): OverviewStats {
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
  return { dbPath: DATA_DIR, exists: any, events, tokens, snapshots, bySport };
}

export function listEvents(sport?: Sport): EventRow[] {
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
          if (byId.has(row.eventId)) continue;
          byId.set(row.eventId, mapEventRow({ ...row, sport: s }));
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
  return out;
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

export function getTokenHistory(tokenId: string): {
  token: (TokenRow & { eventId: string; sport: Sport; marketType: string }) | null;
  eventTitle: string | null;
  timeline: {
    id: number[];
    at: number[];
    bestBid: Array<number | null>;
    bestAsk: Array<number | null>;
    day: string[];
  };
  totalSnapshots: number;
  eventFinished: boolean;
} {
  const empty = {
    token: null,
    eventTitle: null,
    timeline: { id: [], at: [], bestBid: [], bestAsk: [], day: [] },
    totalSnapshots: 0,
    eventFinished: false,
  };
  const loc = findTok(tokenId);
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
      .prepare(`SELECT id, ts AS capturedAt, bb AS bestBid, ba AS bestAsk FROM ob WHERE tid = ? ORDER BY ts ASC`)
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
      day: new Array<string>(n),
    };
    for (let i = 0; i < n; i++) {
      const row = rawRows[i]!;
      const q = sanitizeQuote(row.bestBid, row.bestAsk);
      timeline.id[i] = row.id;
      timeline.at[i] = row.capturedAt;
      timeline.bestBid[i] = q.bestBid;
      timeline.bestAsk[i] = q.bestAsk;
      timeline.day[i] = loc.day;
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
  Array<{ capturedAt: number; bestBid: number | null; bestAsk: number | null }>
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

    const event = db
      .prepare(`SELECT st AS startTime, fa AS finishedAt FROM ev WHERE id = ?`)
      .get(eventId) as { startTime: string | null; finishedAt: number | null } | undefined;

    const span = db
      .prepare(`SELECT MIN(ts) AS a, MAX(ts) AS b FROM ob WHERE eid = ?`)
      .get(eventId) as { a: number | null; b: number | null };

    if (span?.a == null || span?.b == null) return {};

    const startMs = event?.startTime ? Date.parse(event.startTime) : NaN;
    const finishMs = event?.finishedAt != null ? Number(event.finishedAt) : NaN;
    let lo = span.a;
    let hi = span.b;
    if (Number.isFinite(startMs) && Number.isFinite(finishMs) && finishMs > startMs) {
      lo = Math.max(span.a, startMs - 5 * 60_000);
      // Prefer last score / recording over a premature finished_at for the series window.
      hi = span.b;
      const matchHi = Math.min(span.b, finishMs + 30 * 60_000);
      if (matchHi - lo >= 0.2 * (span.b - span.a)) {
        hi = Math.max(matchHi, Math.min(span.b, startMs + 3 * 60 * 60_000));
      }
    }

    const stmt = db.prepare(
      `SELECT ts AS capturedAt, bb AS bestBid, ba AS bestAsk
       FROM ob
       WHERE tid = ? AND ts >= ? AND ts <= ?
       ORDER BY ts ASC`
    );

    const out: Record<
      string,
      Array<{ capturedAt: number; bestBid: number | null; bestAsk: number | null }>
    > = {};

    for (const { tokenId } of tokens) {
      const rows = stmt.all(tokenId, lo, hi) as Array<{
        capturedAt: number;
        bestBid: number | null;
        bestAsk: number | null;
      }>;
      const series: Array<{ capturedAt: number; bestBid: number | null; bestAsk: number | null }> =
        [];
      let lastKeep = -Infinity;
      for (const row of rows) {
        const prev = series[series.length - 1];
        const changed =
          !prev || prev.bestBid !== row.bestBid || prev.bestAsk !== row.bestAsk;
        // Keep every quote change; heartbeat every 2s so scrubbing always has a nearby sample.
        if (!changed && row.capturedAt - lastKeep < 2_000) continue;
        const q = sanitizeQuote(row.bestBid, row.bestAsk);
        series.push({
          capturedAt: row.capturedAt,
          bestBid: q.bestBid,
          bestAsk: q.bestAsk,
        });
        lastKeep = row.capturedAt;
      }
      out[tokenId] = series;
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
      `SELECT bb AS bestBid, ba AS bestAsk, ts AS capturedAt
       FROM ob WHERE tid = ? AND ts <= ? ORDER BY ts DESC LIMIT 1`
    );

    const out: Record<string, { capturedAt: number; bestBid: number | null; bestAsk: number | null }> =
      {};
    for (const { tokenId } of tokens) {
      const row = stmt.get(tokenId, atMs) as
        | { bestBid: number | null; bestAsk: number | null; capturedAt: number }
        | undefined;
      if (!row) continue;
      const q = sanitizeQuote(row.bestBid, row.bestAsk);
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

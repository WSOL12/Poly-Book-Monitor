/**
 * Audit void tennis matches: snap counts by market type (local DB)
 * and optional Predexon spot-check for moneyline vs set_winner.
 *
 *   node scripts/audit-void-books.mjs
 *   node scripts/audit-void-books.mjs --predexon 5
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import Database from "better-sqlite3";

for (const line of readFileSync(resolve("D:/Poly-Book-Monitor/.env"), "utf8").split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("=");
  if (i <= 0) continue;
  const k = t.slice(0, i).trim();
  let v = t.slice(i + 1).trim();
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    v = v.slice(1, -1);
  }
  if (process.env[k] == null) process.env[k] = v;
}

const ROOT = resolve("D:/Poly-Book-Monitor/data/tennis");
const predexonN = (() => {
  const i = process.argv.indexOf("--predexon");
  if (i < 0) return 0;
  return Math.max(0, Number(process.argv[i + 1] || "3") || 3);
})();

function openMonths() {
  if (!existsSync(ROOT)) return [];
  return readdirSync(ROOT)
    .filter((n) => /^\d{4}-\d{2}\.db$/.test(n))
    .map((n) => resolve(ROOT, n));
}

function isVoid(gs) {
  const s = (gs ?? "").trim().toLowerCase();
  return s === "retired" || s === "canceled" || s === "cancelled";
}

async function predexonCount(tokenId, startMs, endMs) {
  const key = process.env.PREDEXON_API_KEY;
  if (!key) throw new Error("no key");
  let pages = 0;
  let count = 0;
  let first = null;
  let last = null;
  let paginationKey = null;
  for (;;) {
    const q = new URLSearchParams({
      token_id: tokenId,
      start_time: String(startMs),
      end_time: String(endMs),
      limit: "200",
    });
    if (paginationKey) q.set("pagination_key", paginationKey);
    const res = await fetch(`https://api.predexon.com/v2/polymarket/orderbooks?${q}`, {
      headers: { "x-api-key": key, Accept: "application/json" },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 200)}`);
    const body = JSON.parse(text);
    pages += 1;
    const snaps = body.snapshots || [];
    count += snaps.length;
    if (snaps.length) {
      if (first == null) first = snaps[0].timestamp;
      last = snaps[snaps.length - 1].timestamp;
    }
    if (!body.pagination?.has_more) break;
    paginationKey = body.pagination.pagination_key;
    if (!paginationKey || pages > 40) break;
  }
  return { count, pages, first, last };
}

const paths = openMonths();
const voids = [];

for (const path of paths) {
  const db = new Database(path, { readonly: true });
  try {
    const events = db
      .prepare(
        `SELECT id AS eventId, t AS title, gs AS gameStatus, d AS eventDate, st AS startTime,
                fa AS finishedAt, e AS ended, c AS closed
         FROM ev
         WHERE lower(coalesce(gs,'')) IN ('retired','canceled','cancelled')
         ORDER BY coalesce(fa, 0) DESC`,
      )
      .all();

    for (const ev of events) {
      const byType = db
        .prepare(
          `SELECT t.mt AS marketType,
                  COUNT(DISTINCT o.tid) AS tokens,
                  COUNT(*) AS snaps,
                  MIN(o.ts) AS firstTs,
                  MAX(o.ts) AS lastTs
           FROM ob o
           JOIN tk t ON t.id = o.tid
           WHERE o.eid = ?
           GROUP BY t.mt
           ORDER BY snaps DESC`,
        )
        .all(ev.eventId);

      const tokenSamples = db
        .prepare(
          `SELECT o.tid AS tokenId, t.mt AS marketType, COUNT(*) AS snaps,
                  MIN(o.ts) AS firstTs, MAX(o.ts) AS lastTs
           FROM ob o
           JOIN tk t ON t.id = o.tid
           WHERE o.eid = ?
           GROUP BY o.tid
           ORDER BY
             CASE t.mt
               WHEN 'moneyline' THEN 0
               WHEN 'set_winner' THEN 1
               WHEN 'completed_match' THEN 2
               ELSE 3
             END,
             snaps ASC`,
        )
        .all(ev.eventId);

      // Also count catalogued tokens with ZERO snaps
      const catalog = db
        .prepare(
          `SELECT t.mt AS marketType,
                  COUNT(*) AS tokens,
                  SUM(CASE WHEN o.n > 0 THEN 1 ELSE 0 END) AS withSnaps,
                  SUM(COALESCE(o.n, 0)) AS snaps
           FROM tk t
           LEFT JOIN (
             SELECT tid, COUNT(*) AS n FROM ob WHERE eid = ? GROUP BY tid
           ) o ON o.tid = t.id
           WHERE t.eid = ?
           GROUP BY t.mt`,
        )
        .all(ev.eventId, ev.eventId);

      const dl = db.prepare(`SELECT * FROM dl WHERE eid = ?`).get(ev.eventId);
      voids.push({
        month: path.split(/[/\\]/).pop(),
        ...ev,
        byType,
        tokenSamples,
        catalog,
        dl,
      });
    }
  } finally {
    db.close();
  }
}

console.log(`void_events=${voids.length}`);

// Aggregate ratios
const agg = {
  events: voids.length,
  withMl: 0,
  withSet: 0,
  mlMedian: [],
  setMedian: [],
  secondaryMedian: [],
  ratios: [],
};

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

for (const v of voids) {
  const ml = v.byType.find((r) => r.marketType === "moneyline");
  const set = v.byType.find((r) => r.marketType === "set_winner");
  const secondary = v.byType.filter((r) => r.marketType !== "moneyline");
  const secSnaps = secondary.reduce((n, r) => n + r.snaps, 0);
  if (ml && ml.snaps > 0) {
    agg.withMl += 1;
    agg.mlMedian.push(ml.snaps);
  }
  if (set && set.snaps > 0) {
    agg.withSet += 1;
    agg.setMedian.push(set.snaps);
  }
  if (secondary.length) agg.secondaryMedian.push(secSnaps);
  if (ml && set && ml.snaps > 0) {
    agg.ratios.push({
      id: v.eventId,
      title: v.title?.slice(0, 60),
      gs: v.gameStatus,
      ml: ml.snaps,
      set: set.snaps,
      setPct: Math.round((100 * set.snaps) / ml.snaps),
      types: Object.fromEntries(v.byType.map((r) => [r.marketType, r.snaps])),
    });
  }
}

agg.ratios.sort((a, b) => a.setPct - b.setPct);

const catalogGap = [];
for (const v of voids) {
  for (const c of v.catalog ?? []) {
    if (c.marketType === "moneyline") continue;
    const avg = c.tokens ? c.snaps / c.tokens : 0;
    catalogGap.push({
      id: v.eventId,
      title: v.title?.slice(0, 40),
      mt: c.marketType,
      tokens: c.tokens,
      withSnaps: c.withSnaps,
      snaps: c.snaps,
      avgPerToken: Math.round(avg),
    });
  }
}
catalogGap.sort((a, b) => a.avgPerToken - b.avgPerToken);

console.log(
  JSON.stringify(
    {
      summary: {
        voidEvents: agg.events,
        withMoneylineSnaps: agg.withMl,
        withSetWinnerSnaps: agg.withSet,
        medianMoneylineSnaps: median(agg.mlMedian),
        medianSetWinnerSnaps: median(agg.setMedian),
        medianSecondarySnapsTotal: median(agg.secondaryMedian),
        worstSetVsMl: agg.ratios.slice(0, 15),
        bestSetVsMl: agg.ratios.slice(-5),
        worstSecondaryAvgPerToken: catalogGap.slice(0, 20),
      },
    },
    null,
    2,
  ),
);

if (predexonN > 0) {
  const samples = agg.ratios.slice(0, predexonN);
  // Prefer events that have both moneyline + set tokens in local DB
  const checks = [];
  for (const row of samples) {
    const v = voids.find((x) => x.eventId === row.id);
    if (!v) continue;
    const mlTok = v.tokenSamples.find((t) => t.marketType === "moneyline");
    const setTok = v.tokenSamples.find((t) => t.marketType === "set_winner");
    if (!mlTok || !setTok) continue;

    // Wide window: day before event date through finished+6h
    const day = v.eventDate ? Date.parse(`${v.eventDate}T00:00:00Z`) : NaN;
    const startMs = Number.isFinite(day)
      ? day - 24 * 3600_000
      : (mlTok.firstTs ?? Date.now()) - 24 * 3600_000;
    const endMs = Math.max(
      v.finishedAt ?? 0,
      mlTok.lastTs ?? 0,
      setTok.lastTs ?? 0,
      startMs + 3600_000,
    ) + 6 * 3600_000;

    const [mlPx, setPx] = await Promise.all([
      predexonCount(mlTok.tokenId, startMs, endMs),
      predexonCount(setTok.tokenId, startMs, endMs),
    ]);
    checks.push({
      id: v.eventId,
      title: v.title?.slice(0, 50),
      local: { ml: mlTok.snaps, set: setTok.snaps },
      predexon: { ml: mlPx.count, set: setPx.count },
      window: {
        start: new Date(startMs).toISOString(),
        end: new Date(endMs).toISOString(),
      },
      capturedAllLocal:
        mlTok.snaps >= mlPx.count * 0.9 && setTok.snaps >= setPx.count * 0.9,
    });
  }
  console.log(JSON.stringify({ predexonSpotCheck: checks }, null, 2));
}

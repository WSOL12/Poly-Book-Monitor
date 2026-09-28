/**
 * Compare Predexon density: moneyline vs set_winner for finished (non-void) tennis too.
 *   node scripts/audit-secondary-density.mjs
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import Database from "better-sqlite3";

for (const line of readFileSync(resolve("D:/Poly-Book-Monitor/.env"), "utf8").split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("=");
  if (i <= 0) continue;
  const k = t.slice(0, i).trim();
  let v = t.slice(i + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  if (process.env[k] == null) process.env[k] = v;
}

const key = process.env.PREDEXON_API_KEY;
const ROOT = resolve("D:/Poly-Book-Monitor/data/tennis");

async function pxCount(tokenId, startMs, endMs) {
  let count = 0;
  let paginationKey = null;
  let pages = 0;
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
    if (!res.ok) throw new Error(await res.text());
    const body = await res.json();
    count += (body.snapshots || []).length;
    pages += 1;
    if (!body.pagination?.has_more) break;
    paginationKey = body.pagination.pagination_key;
    if (!paginationKey || pages > 30) break;
  }
  return count;
}

const dbPath = resolve(ROOT, "2026-09.db");
const db = new Database(dbPath, { readonly: true });

// High-volume finished normal matches (not retired/canceled)
const rows = db
  .prepare(
    `SELECT e.id AS eventId, e.t AS title, e.d AS eventDate, e.fa AS finishedAt, e.v AS volume
     FROM ev e
     WHERE e.e = 1 AND e.c = 1
       AND lower(coalesce(e.gs,'')) NOT IN ('retired','canceled','cancelled')
       AND e.v IS NOT NULL
     ORDER BY e.v DESC
     LIMIT 5`,
  )
  .all();

const out = [];
for (const ev of rows) {
  const ml = db
    .prepare(
      `SELECT t.id AS tokenId, COUNT(o.id) AS snaps, MIN(o.ts) AS a, MAX(o.ts) AS b
       FROM tk t LEFT JOIN ob o ON o.tid = t.id
       WHERE t.eid = ? AND t.mt = 'moneyline'
       GROUP BY t.id ORDER BY snaps DESC LIMIT 1`,
    )
    .get(ev.eventId);
  const set = db
    .prepare(
      `SELECT t.id AS tokenId, COUNT(o.id) AS snaps, MIN(o.ts) AS a, MAX(o.ts) AS b
       FROM tk t LEFT JOIN ob o ON o.tid = t.id
       WHERE t.eid = ? AND t.mt = 'set_winner'
       GROUP BY t.id ORDER BY snaps DESC LIMIT 1`,
    )
    .get(ev.eventId);
  if (!ml?.tokenId || !set?.tokenId) {
    out.push({ title: ev.title?.slice(0, 50), skip: true });
    continue;
  }
  const day = ev.eventDate ? Date.parse(`${ev.eventDate}T00:00:00Z`) : ml.a;
  const start = (Number.isFinite(day) ? day : ml.a) - 12 * 3600_000;
  const end = Math.max(ev.finishedAt ?? 0, ml.b ?? 0, set.b ?? 0) + 6 * 3600_000;
  const [mlPx, setPx] = await Promise.all([
    pxCount(ml.tokenId, start, end),
    pxCount(set.tokenId, start, end),
  ]);
  out.push({
    title: ev.title?.slice(0, 50),
    volume: ev.volume,
    local: { ml: ml.snaps, set: set.snaps },
    predexon: { ml: mlPx, set: setPx },
    setPctOfMl: mlPx ? Math.round((100 * setPx) / mlPx) : null,
  });
}
db.close();
console.log(JSON.stringify(out, null, 2));

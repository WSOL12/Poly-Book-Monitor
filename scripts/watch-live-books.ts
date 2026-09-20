/**
 * Watch live soccer orderbook capture for ~30 minutes.
 * Compares DB last-snap age vs REST TOB for Manchester City (or all live events).
 *
 *   npx tsx scripts/watch-live-books.ts
 */
import Database from "better-sqlite3";
import { mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { polyFetch } from "../src/utils/polyNet.ts";

const DURATION_MS = 30 * 60_000;
const EVERY_MS = 30_000;
const OUT_DIR = resolve("data/_watch");
const OUT = resolve(OUT_DIR, `live-books-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT, `watch start ${new Date().toISOString()}\n`);

function log(line: string) {
  const row = `[${new Date().toISOString()}] ${line}`;
  console.log(row);
  appendFileSync(OUT, row + "\n");
}

function openSoccer() {
  return new Database(resolve("data/soccer/2026-09-20.db"), { readonly: true, fileMustExist: true });
}

async function restTob(tokenId: string) {
  const res = await polyFetch(
    `https://clob.polymarket.com/book?token_id=${encodeURIComponent(tokenId)}`,
    8_000
  );
  if (!res.ok) return null;
  const body = (await res.json()) as {
    bids?: Array<{ price: string; size: string }>;
    asks?: Array<{ price: string; size: string }>;
  };
  let bb: number | null = null;
  let ba: number | null = null;
  for (const b of body.bids ?? []) {
    const p = Number(b.price);
    const s = Number(b.size);
    if (!Number.isFinite(p) || !Number.isFinite(s) || s <= 0) continue;
    if (bb == null || p > bb) bb = p;
  }
  for (const a of body.asks ?? []) {
    const p = Number(a.price);
    const s = Number(a.size);
    if (!Number.isFinite(p) || !Number.isFinite(s) || s <= 0) continue;
    if (ba == null || p < ba) ba = p;
  }
  return { bb, ba };
}

async function tick() {
  const db = openSoccer();
  try {
    const live = db
      .prepare(`SELECT id, t FROM ev WHERE e = 0 AND l = 1 ORDER BY t`)
      .all() as Array<{ id: string; t: string }>;
    const now = Date.now();
    let maxAge = 0;
    let staleN = 0;
    const rows: string[] = [];
    for (const ev of live) {
      const hi = db.prepare(`SELECT MAX(ts) AS hi FROM ob WHERE eid = ?`).get(ev.id) as {
        hi: number | null;
      };
      const age = hi.hi != null ? Math.round((now - hi.hi) / 1000) : null;
      if (age != null) maxAge = Math.max(maxAge, age);
      if (age == null || age > 20) staleN++;
      if (/Manchester City/i.test(ev.t) || rows.length < 3) {
        const tok = db
          .prepare(`SELECT id, lb FROM tk WHERE eid = ? ORDER BY lb LIMIT 1`)
          .get(ev.id) as { id: string; lb: string } | undefined;
        let rest = "";
        if (tok) {
          const tob = await restTob(tok.id);
          const dbTob = db
            .prepare(`SELECT bb, ba FROM ob WHERE tid = ? ORDER BY ts DESC LIMIT 1`)
            .get(tok.id) as { bb: number | null; ba: number | null } | undefined;
          rest = ` db=${dbTob?.bb ?? "-"}/${dbTob?.ba ?? "-"} rest=${tob?.bb ?? "-"}/${tob?.ba ?? "-"}`;
        }
        rows.push(`${ev.t.slice(0, 36)} age=${age ?? "none"}s${rest}`);
      }
    }
    log(
      `live=${live.length} stale>20s=${staleN} maxAge=${maxAge}s | ${rows.join(" || ")}`
    );
  } finally {
    db.close();
  }
}

log(`logging to ${OUT}`);
await tick();
const started = Date.now();
const timer = setInterval(() => {
  void tick().then(() => {
    if (Date.now() - started >= DURATION_MS) {
      clearInterval(timer);
      log("watch done");
      process.exit(0);
    }
  });
}, EVERY_MS);

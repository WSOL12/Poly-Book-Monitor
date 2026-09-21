/**
 * 30-minute all-sports capture health watch.
 * Compares DB last-snap age vs REST TOB for live events across soccer/football/mlb/tennis/weather.
 *
 *   npx tsx scripts/watch-all-sports.ts
 */
import Database from "better-sqlite3";
import { mkdirSync, appendFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { polyFetch } from "../src/utils/polyNet.ts";

const SPORTS = ["soccer", "football", "mlb", "tennis", "weather"] as const;
const DURATION_MS = 30 * 60_000;
const EVERY_MS = 30_000;
const OUT_DIR = resolve("data/_watch");
const OUT = resolve(OUT_DIR, `all-sports-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT, `watch start ${new Date().toISOString()}\n`);

function log(line: string) {
  const row = `[${new Date().toISOString()}] ${line}`;
  console.log(row);
  appendFileSync(OUT, row + "\n");
}

function latestDay(sport: string): string | null {
  const dir = resolve("data", sport);
  try {
    const days = readdirSync(dir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.db$/.test(f))
      .sort()
      .reverse();
    return days[0] ? days[0].replace(/\.db$/, "") : null;
  } catch {
    return null;
  }
}

async function restTob(tokenId: string) {
  try {
    const res = await polyFetch(
      `https://clob.polymarket.com/book?token_id=${encodeURIComponent(tokenId)}`,
      5_000
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
  } catch {
    return null;
  }
}

type Row = {
  sport: string;
  id: string;
  title: string;
  age: number | null;
  snaps: number;
  drift: number | null;
};

async function tick() {
  const now = Date.now();
  const rows: Row[] = [];
  for (const sport of SPORTS) {
    const day = latestDay(sport);
    if (!day) continue;
    const db = new Database(resolve("data", sport, `${day}.db`), {
      readonly: true,
      fileMustExist: true,
    });
    try {
      const live = db
        .prepare(`SELECT id, t FROM ev WHERE e = 0 ORDER BY t LIMIT 40`)
        .all() as Array<{ id: string; t: string }>;
      for (const ev of live) {
        const hi = db.prepare(`SELECT COUNT(*) n, MAX(ts) hi FROM ob WHERE eid = ?`).get(ev.id) as {
          n: number;
          hi: number | null;
        };
        const age = hi.hi != null ? Math.round((now - hi.hi) / 1000) : null;
        let drift: number | null = null;
        if (rows.filter((r) => r.sport === sport).length < 2) {
          const tok = db
            .prepare(
              `SELECT id FROM tk WHERE eid = ? AND (mt = 'moneyline' OR mt = 'weather') ORDER BY lb LIMIT 1`
            )
            .get(ev.id) as { id: string } | undefined;
          if (tok) {
            const dbTob = db
              .prepare(`SELECT bb, ba FROM ob WHERE tid = ? ORDER BY ts DESC LIMIT 1`)
              .get(tok.id) as { bb: number | null; ba: number | null } | undefined;
            const rest = await restTob(tok.id);
            if (dbTob && rest) {
              const dAsk =
                dbTob.ba != null && rest.ba != null ? Math.abs(dbTob.ba - rest.ba) : null;
              const dBid =
                dbTob.bb != null && rest.bb != null ? Math.abs(dbTob.bb - rest.bb) : null;
              drift = Math.max(dAsk ?? 0, dBid ?? 0);
            }
          }
        }
        rows.push({
          sport,
          id: ev.id,
          title: ev.t.slice(0, 36),
          age,
          snaps: hi.n,
          drift,
        });
      }
    } finally {
      db.close();
    }
  }

  const bySport: Record<string, { n: number; stale: number; maxAge: number; maxDrift: number }> = {};
  for (const r of rows) {
    const b = (bySport[r.sport] ??= { n: 0, stale: 0, maxAge: 0, maxDrift: 0 });
    b.n++;
    if (r.age == null || r.age > 20) b.stale++;
    if (r.age != null) b.maxAge = Math.max(b.maxAge, r.age);
    if (r.drift != null) b.maxDrift = Math.max(b.maxDrift, r.drift);
  }
  const summary = SPORTS.map((s) => {
    const b = bySport[s];
    if (!b) return `${s}:0`;
    return `${s}:${b.n} stale>${20}=${b.stale} maxAge=${b.maxAge}s drift=${(b.maxDrift * 100).toFixed(1)}c`;
  }).join(" | ");
  log(summary);

  const worst = [...rows]
    .filter((r) => r.age != null)
    .sort((a, b) => (b.age ?? 0) - (a.age ?? 0))
    .slice(0, 5);
  if (worst.length) {
    log(
      "worst " +
        worst.map((r) => `${r.sport}/${r.title} age=${r.age}s snaps=${r.snaps}`).join(" || ")
    );
  }
}

log(`logging to ${OUT}`);
await tick();
const started = Date.now();
const timer = setInterval(() => {
  void tick()
    .catch((err) => log(`tick err: ${err instanceof Error ? err.message : String(err)}`))
    .then(() => {
      if (Date.now() - started >= DURATION_MS) {
        clearInterval(timer);
        log("watch done");
        process.exit(0);
      }
    });
}, EVERY_MS);

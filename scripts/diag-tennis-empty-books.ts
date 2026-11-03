/**
 * Diagnose tennis Poly events with catalog but 0 orderbooks.
 */
import Database from "better-sqlite3";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { listEvents, getEvent } from "../web/lib/db.ts";

const eid = "1097396";
const ev = getEvent(eid);
console.log("EVENT", {
  id: ev?.eventId,
  title: ev?.title,
  sport: ev?.sport,
  start: ev?.startTime,
  date: ev?.eventDate,
  ended: ev?.ended,
  markets: ev?.markets?.length,
  tokens: ev?.markets?.flatMap((m) => m.tokens).length,
  lastSnap: ev?.lastSnapshotAt,
});

for (const f of readdirSync("data/tennis").filter((x) => x.endsWith(".db") && !x.startsWith("_"))) {
  const db = new Database(join("data/tennis", f), { readonly: true });
  const row = db.prepare("SELECT id, t, d, st, e, c FROM ev WHERE id = ?").get(eid) as
    | Record<string, unknown>
    | undefined;
  if (row) {
    const ob = (db.prepare("SELECT COUNT(*) AS n FROM ob WHERE eid = ?").get(eid) as { n: number }).n;
    const dl = db.prepare("SELECT * FROM dl WHERE eid = ?").get(eid);
    const tk = (db.prepare("SELECT COUNT(*) AS n FROM tk WHERE eid = ?").get(eid) as { n: number }).n;
    console.log(`\n${f}:`, row);
    console.log("  tk", tk, "ob", ob, "dl", dl);
  }
  db.close();
}

// Overall tennis health
const tennis = listEvents("tennis");
let withOb = 0;
let noOb = 0;
let openNoOb = 0;
let liveNoOb = 0;
const emptySamples: string[] = [];

for (const f of readdirSync("data/tennis").filter((x) => /^\d{4}-\d{2}\.db$/.test(x))) {
  const db = new Database(join("data/tennis", f), { readonly: true });
  const rows = db
    .prepare(
      `SELECT e.id, e.t, e.e AS ended, e.l AS live, e.gs,
              (SELECT COUNT(*) FROM ob o WHERE o.eid = e.id) AS ob,
              d.complete, d.snapshots, d.from_ms, d.to_ms, d.note
       FROM ev e LEFT JOIN dl d ON d.eid = e.id`,
    )
    .all() as Array<{
    id: string;
    t: string;
    ended: number;
    live: number;
    gs: string | null;
    ob: number;
    complete: number | null;
    snapshots: number | null;
    from_ms: number | null;
    to_ms: number | null;
    note: string | null;
  }>;
  for (const r of rows) {
    if (r.ob > 0) withOb++;
    else {
      noOb++;
      if (!r.ended) openNoOb++;
      if (r.live || r.gs === "live" || /live/i.test(r.gs ?? "")) liveNoOb++;
      if (emptySamples.length < 15) {
        emptySamples.push(
          `${r.id} ob=0 complete=${r.complete} snaps=${r.snapshots} ended=${r.ended} live=${r.live} | ${r.t.slice(0, 50)}`,
        );
      }
    }
  }
  db.close();
}

console.log(`\nTENNIS listEvents=${tennis.length} withOb≈${withOb} noOb≈${noOb} openNoOb≈${openNoOb}`);
console.log("empty samples:");
for (const s of emptySamples) console.log(" ", s);

// China Open empty ratio
const china = tennis.filter((e) => /china open/i.test(e.title));
const chinaEmpty = china.filter((e) => !e.lastSnapshotAt);
console.log(`\nChina Open events=${china.length} with lastSnapshot=${china.length - chinaEmpty.length} empty=${chinaEmpty.length}`);

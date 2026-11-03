import { listEvents, getEvent, getTokenHistory } from "../web/lib/db.ts";
import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { idxPathForSport, dbPathForMonth } from "../web/lib/paths.ts";

const pf = listEvents("predictfun").filter(
  (e) => /khachanov/i.test(e.title) && /blockx/i.test(e.title),
);
console.log(
  "pf events",
  pf.map((e) => `${e.eventId} | ${e.title} | last=${e.lastSnapshotAt}`),
);
const id = pf[0]?.eventId;
if (!id) {
  console.log("no khachanov/blockx — sample PF", listEvents("predictfun").slice(0, 5).map((e) => e.title));
  process.exit(0);
}

let t0 = Date.now();
const ev = getEvent(id);
console.log(
  "getEvent",
  Date.now() - t0,
  "ms markets",
  ev?.markets?.length,
  "tokens",
  ev?.markets?.flatMap((m) => m.tokens).length,
);

const tok = ev?.markets?.[0]?.tokens?.[0]?.tokenId;
console.log("token", tok);

const idxPath = idxPathForSport("predictfun");
console.log("idx exists", existsSync(idxPath), idxPath);
if (existsSync(idxPath)) {
  const idx = new Database(idxPath, { readonly: true });
  console.log("idx loc", idx.prepare(`SELECT * FROM loc WHERE eid = ?`).get(id));
  if (tok) console.log("idx tok", idx.prepare(`SELECT * FROM tok WHERE tid = ?`).get(tok));
  console.log("idx tok count", (idx.prepare(`SELECT COUNT(*) c FROM tok`).get() as { c: number }).c);
  idx.close();
}

if (tok) {
  t0 = Date.now();
  const h = getTokenHistory(tok);
  console.log(
    "getTokenHistory",
    Date.now() - t0,
    "ms snaps",
    h.totalSnapshots,
    "timeline",
    h.timeline.at.length,
  );
}

// quotes series timing
t0 = Date.now();
const { getEventQuoteSeries } = await import("../web/lib/db.ts");
const series = getEventQuoteSeries(id);
const keys = Object.keys(series);
console.log(
  "quoteSeries",
  Date.now() - t0,
  "ms tokens",
  keys.length,
  "points",
  keys.reduce((n, k) => n + (series[k]?.length ?? 0), 0),
);

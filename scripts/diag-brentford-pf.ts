/**
 * Diagnose why Brentford vs Chelsea PF twin has no orderbooks in UI.
 */
import Database from "better-sqlite3";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { listEvents, findPredictTwins, getEvent, getEventQuoteSeries } from "../web/lib/db.ts";

const title = "Brentford FC vs. Chelsea FC";
const soccer = listEvents("soccer");
const poly = soccer.find((e) => e.title === title);
console.log("POLY", poly);

if (!poly) {
  console.log("poly not found");
  process.exit(1);
}

const twins = findPredictTwins(poly.title, 5, {
  anchorMs: poly.eventDate ? Date.parse(`${poly.eventDate}T12:00:00Z`) : null,
});
console.log("\nTWINS");
for (const t of twins) {
  console.log(`  ${t.score.toFixed(2)} ${t.eventId} | ${t.title} | vol=${t.volume}`);
}

const best = twins[0];
if (!best) {
  console.log("no twin");
  process.exit(1);
}

const pfEvent = getEvent(best.eventId);
console.log("\nPF EVENT", {
  eventId: pfEvent?.eventId,
  title: pfEvent?.title,
  sport: pfEvent?.sport,
  markets: pfEvent?.markets?.length,
  tokens: pfEvent?.markets?.flatMap((m) => m.tokens).length,
});
for (const m of pfEvent?.markets ?? []) {
  console.log(`  mk ${m.marketType} ${m.question} tokens=${m.tokens.length}`);
  for (const tok of m.tokens) console.log(`    tok ${tok.side} ${tok.tokenId.slice(0, 40)}…`);
}

// Raw sqlite snapshot counts
const dir = join("data", "predictfun");
const files = readdirSync(dir).filter((f) => f.endsWith(".db") && !f.startsWith("_"));
let totalOb = 0;
for (const f of files) {
  const db = new Database(join(dir, f), { readonly: true });
  const n = (db.prepare(`SELECT COUNT(*) AS n FROM ob WHERE eid = ?`).get(best.eventId) as { n: number }).n;
  const toks = db.prepare(`SELECT id, sd, lb FROM tk WHERE eid = ?`).all(best.eventId) as Array<{
    id: string;
    sd: string;
    lb: string;
  }>;
  const mks = db.prepare(`SELECT id, q, mt FROM mk WHERE eid = ?`).all(best.eventId) as Array<{
    id: string;
    q: string;
    mt: string;
  }>;
  if (n || toks.length || mks.length) {
    console.log(`\n${f}: ob=${n} tk=${toks.length} mk=${mks.length}`);
    for (const m of mks) console.log(`  mk ${m.mt} ${m.q}`);
    for (const t of toks.slice(0, 10)) console.log(`  tk ${t.sd} ${t.lb} ${t.id.slice(0, 48)}`);
    if (n) {
      const sample = db
        .prepare(`SELECT tid, ts, bb, ba FROM ob WHERE eid = ? ORDER BY ts LIMIT 3`)
        .all(best.eventId);
      console.log("  first snaps", sample);
      const last = db
        .prepare(`SELECT tid, ts, bb, ba FROM ob WHERE eid = ? ORDER BY ts DESC LIMIT 3`)
        .all(best.eventId);
      console.log("  last snaps", last);
    }
  }
  totalOb += n;
  db.close();
}
console.log("\nTOTAL OB for twin", totalOb);

try {
  const quotes = getEventQuoteSeries(best.eventId);
  console.log("quote series points", quotes?.series?.length ?? quotes?.length ?? quotes);
} catch (e) {
  console.log("quote series error", e);
}

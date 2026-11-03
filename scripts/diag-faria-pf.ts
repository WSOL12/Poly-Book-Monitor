/**
 * Diagnose US Open Faria vs Alcaraz PF twin + empty books.
 */
import Database from "better-sqlite3";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { listEvents, findPredictTwins, getEvent } from "../web/lib/db.ts";

const polyId = "870115"; // from URL in prior context if wrong we'll search
const tennis = listEvents("tennis");
const poly =
  tennis.find((e) => /faria/i.test(e.title) && /alcaraz/i.test(e.title)) ??
  tennis.find((e) => e.eventId === polyId);

console.log("POLY", poly && {
  id: poly.eventId,
  title: poly.title,
  date: poly.eventDate,
  lastSnap: poly.lastSnapshotAt,
});

if (!poly) {
  console.log("poly not found");
  process.exit(1);
}

const twins = findPredictTwins(poly.title, 5, {
  anchorMs: poly.eventDate ? Date.parse(`${poly.eventDate}T12:00:00Z`) : poly.finishedAt,
});
console.log("\nTWINS");
for (const t of twins) {
  console.log(`  ${t.score.toFixed(2)} ${t.eventId} | ${t.title}`);
}

const best = twins[0];
if (!best) {
  console.log("no twin");
  process.exit(1);
}

const pf = getEvent(best.eventId);
console.log("\nPF EVENT", {
  id: pf?.eventId,
  title: pf?.title,
  markets: pf?.markets?.length,
  tokens: pf?.markets?.flatMap((m) => m.tokens).length,
  lastSnap: pf?.lastSnapshotAt,
});

for (const f of readdirSync("data/predictfun").filter((x) => /^\d{4}-\d{2}\.db$/.test(x))) {
  const db = new Database(join("data/predictfun", f), { readonly: true });
  const ev = db.prepare("SELECT id, t, d FROM ev WHERE id = ?").get(best.eventId) as
    | { id: string; t: string; d: string }
    | undefined;
  if (!ev) {
    db.close();
    continue;
  }
  const ob = (db.prepare("SELECT COUNT(*) AS n FROM ob WHERE eid = ?").get(best.eventId) as { n: number }).n;
  const mk = (db.prepare("SELECT COUNT(*) AS n FROM mk WHERE eid = ?").get(best.eventId) as { n: number }).n;
  const dl = db.prepare("SELECT * FROM dl WHERE eid = ?").get(best.eventId);
  console.log(`\n${f}:`, ev.t, "mk=", mk, "ob=", ob);
  console.log("  dl", dl);
  const mks = db.prepare("SELECT q, mt FROM mk WHERE eid = ? LIMIT 10").all(best.eventId);
  for (const m of mks) console.log("  mk", m);
  db.close();
}

// How many tennis PF twins have 0 books?
const pfAll = listEvents("predictfun").filter((e) => /\bvs\.?\b/i.test(e.title) || e.eventId.includes("atp") || e.eventId.includes("wta") || e.eventId.includes("us-open"));
let twinEmpty = 0;
let twinOk = 0;
for (const p of tennis.slice(0, 500)) {
  const tw = findPredictTwins(p.title, 1, {
    anchorMs: p.eventDate ? Date.parse(`${p.eventDate}T12:00:00Z`) : null,
  })[0];
  if (!tw || tw.score < 0.55) continue;
  const g = getEvent(tw.eventId);
  if (!g) continue;
  if (!g.lastSnapshotAt) twinEmpty++;
  else twinOk++;
}
console.log(`\nSample twin coverage (first 500 tennis): withBooks=${twinOk} emptyBooks=${twinEmpty}`);

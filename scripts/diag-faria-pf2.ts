import Database from "better-sqlite3";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { findPredictTwins, getEvent, listEvents } from "../web/lib/db.ts";

for (const sport of ["tennis", "predictfun"] as const) {
  for (const f of readdirSync(join("data", sport)).filter((x) => /^\d{4}-\d{2}\.db$/.test(x))) {
    const db = new Database(join("data", sport, f), { readonly: true });
    const rows = db
      .prepare(
        `SELECT id, t, d FROM ev
         WHERE t LIKE '%Faria%' OR t LIKE '%Alcaraz%'
            OR id LIKE '%faria%' OR id LIKE '%alcaraz%'`,
      )
      .all() as Array<{ id: string; t: string; d: string }>;
    if (rows.length) {
      console.log(sport, f, rows.length);
      for (const r of rows.slice(0, 30)) console.log(" ", r.id, r.d, r.t.slice(0, 90));
    }
    db.close();
  }
}

const tennis = listEvents("tennis");
const poly = tennis.find((e) => /faria/i.test(e.title) && /alcaraz/i.test(e.title));
console.log("\nlistEvents poly", poly?.eventId, poly?.title);
if (poly) {
  const twins = findPredictTwins(poly.title, 5, {
    anchorMs: poly.eventDate ? Date.parse(`${poly.eventDate}T12:00:00Z`) : null,
  });
  for (const t of twins) console.log(" twin", t.score.toFixed(2), t.eventId, t.title);
  const best = twins[0];
  if (best) {
    const pf = getEvent(best.eventId);
    console.log(" pf getEvent markets", pf?.markets?.length, "lastSnap", pf?.lastSnapshotAt);
  }
}

// Count PF tennis events with/without books
let pfTennis = 0;
let pfTennisEmpty = 0;
for (const f of readdirSync("data/predictfun").filter((x) => /^\d{4}-\d{2}\.db$/.test(x))) {
  const db = new Database(join("data/predictfun", f), { readonly: true });
  const rows = db
    .prepare(
      `SELECT e.id, e.t,
              (SELECT COUNT(*) FROM ob o WHERE o.eid = e.id) AS ob
       FROM ev e
       WHERE e.id LIKE 'pf:atp-%' OR e.id LIKE 'pf:wta-%' OR e.id LIKE 'pf:us-open%'
          OR e.t LIKE '%Open:%' OR e.t LIKE '%Open ATP%' OR e.t LIKE '%Open WTA%'`,
    )
    .all() as Array<{ id: string; t: string; ob: number }>;
  for (const r of rows) {
    pfTennis++;
    if (r.ob === 0) pfTennisEmpty++;
  }
  db.close();
}
console.log(`\nPF tennis-ish events=${pfTennis} emptyOb=${pfTennisEmpty}`);

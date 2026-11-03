import { listEvents } from "../web/lib/db.ts";
import Database from "better-sqlite3";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { pickPredictEventTitle } from "../src/predexon/predictfun.ts";

const pf = listEvents("predictfun");
const atp = pf.filter((e) => /^(pf:)?(atp|wta)-/i.test(e.eventId) || /^(atp|wta)-/i.test(e.slug ?? ""));
console.log("PF tennis-ish events:", atp.length);
const withVs = atp.filter((e) => /\bvs\.?\b/i.test(e.title));
const noVs = atp.filter((e) => !/\bvs\.?\b/i.test(e.title));
console.log("  with vs title:", withVs.length);
console.log("  without vs title:", noVs.length);
console.log("  no-vs samples:");
for (const e of noVs.slice(0, 30)) {
  console.log(`    ${e.title.slice(0, 50)} | ${e.eventId}`);
}

// Recompute ideal titles from mk for no-vs tennis PF events
console.log("\nIdeal titles from markets for no-vs tennis (sample 20):");
const dir = "data/predictfun";
const dbs = readdirSync(dir)
  .filter((f) => /^\d{4}-\d{2}\.db$/.test(f))
  .map((f) => new Database(join(dir, f), { readonly: true }));

let shown = 0;
for (const e of noVs) {
  for (const db of dbs) {
    const qs = (db.prepare(`SELECT q FROM mk WHERE eid = ?`).all(e.eventId) as Array<{ q: string }>).map(
      (r) => r.q,
    );
    if (!qs.length) continue;
    const slug = e.eventId.startsWith("pf:") ? e.eventId.slice(3) : e.slug;
    const ideal = pickPredictEventTitle(
      qs.map((q) => ({ title: q })),
      slug,
    );
    if (ideal !== e.title || /\bvs\.?\b/i.test(ideal) || qs.some((q) => /\bvs\.?\b/i.test(q))) {
      console.log(`  stored: ${e.title}`);
      console.log(`  ideal:  ${ideal}`);
      console.log(`  mk:     ${qs.slice(0, 5).join(" || ")}`);
      console.log("");
      shown++;
    }
    break;
  }
  if (shown >= 20) break;
}
for (const db of dbs) db.close();

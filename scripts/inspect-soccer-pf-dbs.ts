/**
 * Direct sqlite inspection of soccer + predictfun DBs (table = ev).
 */
import Database from "better-sqlite3";
import { readdirSync } from "node:fs";
import { join } from "node:path";

function openShards(sport: string): Database.Database[] {
  const dir = join("data", sport);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".db") && !f.startsWith("_"))
    .map((f) => new Database(join(dir, f), { readonly: true }));
}

function qAll(dbs: Database.Database[], sql: string, params: unknown[] = []) {
  const out: Record<string, unknown>[] = [];
  for (const db of dbs) {
    out.push(...(db.prepare(sql).all(...params) as Record<string, unknown>[]));
  }
  return out;
}

const soccer = openShards("soccer");
const pf = openShards("predictfun");

console.log("=== soccer schema ===");
console.log(qAll(soccer.slice(0, 1), "SELECT sql FROM sqlite_master WHERE type='table' AND name='ev'")[0]);

const soccerN = qAll(soccer, "SELECT COUNT(*) AS n FROM ev").reduce((a, r) => a + Number(r.n), 0);
const pfN = qAll(pf, "SELECT COUNT(*) AS n FROM ev").reduce((a, r) => a + Number(r.n), 0);
console.log("soccer events", soccerN);
console.log("pf events", pfN);

const eplPoly = qAll(
  soccer,
  `SELECT id, t AS title, d AS event_date, s AS slug FROM ev
   WHERE t LIKE '%Arsenal%' OR t LIKE '%Aston Villa%' OR t LIKE '%Liverpool FC%'
   ORDER BY d DESC LIMIT 30`,
);
console.log("\n=== Poly soccer Arsenal/Villa/Liverpool ===", eplPoly.length);
for (const r of eplPoly.slice(0, 20)) {
  console.log(`  ${r.event_date} | ${r.title}`);
}

const eplPf = qAll(
  pf,
  `SELECT id, t AS title, d AS event_date, s AS slug FROM ev
   WHERE t LIKE '%Arsenal%' OR t LIKE '%Aston Villa%' OR t LIKE '%Liverpool%'
      OR t LIKE '%Chelsea%' OR t LIKE '%Everton%' OR t LIKE '%Premier%'
      OR t LIKE '%EPL%' OR id LIKE '%epl-%' OR s LIKE 'epl-%'
      OR id LIKE '%lal-%' OR id LIKE '%ucl-%' OR id LIKE '%mls-%'
      OR id LIKE '%fl1-%' OR id LIKE '%ser-%' OR id LIKE '%bun-%'
   ORDER BY d DESC LIMIT 100`,
);
console.log("\n=== PF football-related ===", eplPf.length);
for (const r of eplPf.slice(0, 50)) {
  console.log(`  ${r.event_date} | ${r.id} | ${String(r.title).slice(0, 85)}`);
}

const pfVs = qAll(pf, `SELECT COUNT(*) AS n FROM ev WHERE t LIKE '% vs %' OR t LIKE '% vs. %'`).reduce(
  (a, r) => a + Number(r.n),
  0,
);
console.log("\nPF titles with vs:", pfVs);

const footPf = qAll(
  pf,
  `SELECT id, t AS title, d AS event_date FROM ev
   WHERE id LIKE 'pf:epl-%' OR id LIKE 'pf:lal-%' OR id LIKE 'pf:ucl-%'
      OR id LIKE 'pf:mls-%' OR id LIKE 'pf:fl1-%' OR id LIKE 'pf:ser-%'
      OR id LIKE 'pf:bun-%' OR id LIKE 'pf:clf-%'`,
);
console.log("\n=== ALL PF football-slug events ===", footPf.length);
for (const r of footPf) {
  console.log(`  ${r.event_date} | ${r.id} | ${String(r.title).slice(0, 90)}`);
}

// Prefix histogram over all PF events
const allPf = qAll(pf, "SELECT id, t AS title FROM ev");
const buckets = new Map<string, number>();
for (const r of allPf) {
  const id = String(r.id);
  const m = /^pf:([a-z0-9]+)-/.exec(id);
  const key = m?.[1] ?? "other";
  buckets.set(key, (buckets.get(key) ?? 0) + 1);
}
console.log("\n=== ALL PF event_id league prefixes ===");
for (const [k, n] of [...buckets.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k}: ${n}`);
}

for (const db of [...soccer, ...pf]) db.close();

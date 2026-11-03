/**
 * Prove Poly↔PF soccer overlap exists; inspect mk.q for better titles.
 */
import Database from "better-sqlite3";
import { readdirSync } from "node:fs";
import { join } from "node:path";

function openShards(sport: string) {
  const dir = join("data", sport);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".db") && !f.startsWith("_"))
    .map((f) => new Database(join(dir, f), { readonly: true }));
}

const soccer = openShards("soccer");
const pf = openShards("predictfun");

const pairs: Array<{ poly: string; pfId: string; date: string }> = [
  { poly: "AFC Bournemouth vs. Liverpool FC", pfId: "pf:epl-bou-liv-2026-09-20", date: "2026-09-20" },
  { poly: "Brighton & Hove Albion FC vs. Arsenal FC", pfId: "pf:epl-bri-ars-2026-09-19", date: "2026-09-19" },
  { poly: "Brentford FC vs. Chelsea FC", pfId: "pf:epl-bre-che-2026-09-18", date: "2026-09-18" },
  { poly: "Fulham FC vs. Manchester United FC", pfId: "pf:epl-ful-mun-2026-09-20", date: "2026-09-20" },
];

for (const p of pairs) {
  console.log(`\n=== ${p.poly} <=> ${p.pfId} ===`);
  for (const db of soccer) {
    const ev = db.prepare("SELECT id, t, d FROM ev WHERE t = ?").get(p.poly) as
      | { id: string; t: string; d: string }
      | undefined;
    if (ev) console.log("  POLY", ev.id, ev.d, ev.t);
  }
  for (const db of pf) {
    const ev = db.prepare("SELECT id, t, d, s FROM ev WHERE id = ?").get(p.pfId) as
      | { id: string; t: string; d: string; s: string }
      | undefined;
    if (!ev) continue;
    console.log("  PF ev", ev.t, "date", ev.d, "slug", ev.s);
    const mks = db.prepare("SELECT id, q, mt FROM mk WHERE eid = ? LIMIT 15").all(p.pfId) as Array<{
      id: string;
      q: string;
      mt: string;
    }>;
    for (const m of mks) console.log(`    mk[${m.mt}] ${m.q.slice(0, 100)}`);
  }
}

// Count how many epl/lal/fl1/bun/mls PF events have a same-date poly soccer candidate
const foot = [] as Array<{ id: string; t: string; d: string }>;
for (const db of pf) {
  foot.push(
    ...(db
      .prepare(
        `SELECT id, t, d FROM ev WHERE id LIKE 'pf:epl-%' OR id LIKE 'pf:lal-%' OR id LIKE 'pf:fl1-%'
          OR id LIKE 'pf:bun-%' OR id LIKE 'pf:mls-%' OR id LIKE 'pf:ucl-%' OR id LIKE 'pf:uel-%'`,
      )
      .all() as Array<{ id: string; t: string; d: string }>),
  );
}
console.log("\nFootball PF events", foot.length);

let dateHits = 0;
for (const f of foot) {
  // date in slug often more accurate than d
  const slugDate = /-(\d{4}-\d{2}-\d{2})$/.exec(f.id)?.[1];
  const day = slugDate ?? f.d;
  for (const db of soccer) {
    const n = (
      db.prepare(`SELECT COUNT(*) AS n FROM ev WHERE d = ? OR d = ?`).get(day, f.d) as { n: number }
    ).n;
    if (n > 0) {
      dateHits++;
      break;
    }
  }
}
console.log("PF football events with any poly soccer on same calendar day:", dateHits);

for (const db of [...soccer, ...pf]) db.close();

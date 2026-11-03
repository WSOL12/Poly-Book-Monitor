/**
 * Fix Predict.fun event titles that were stored as prop names
 * ("Map 2 Winner", "EST", …) instead of match names.
 *
 * Usage: npx tsx scripts/repair-pf-titles.ts
 */
import Database from "better-sqlite3";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { pickPredictEventTitle } from "../src/predexon/predictfun.ts";

const DIR = join(process.cwd(), "data", "predictfun");

function repairDb(path: string): { updated: number; total: number; samples: string[] } {
  const db = new Database(path);
  const events = db.prepare(`SELECT id, t, s FROM ev`).all() as Array<{
    id: string;
    t: string;
    s: string | null;
  }>;
  const mkStmt = db.prepare(`SELECT q FROM mk WHERE eid = ?`);
  const upd = db.prepare(`UPDATE ev SET t = ?, u = ? WHERE id = ?`);
  let updated = 0;
  const samples: string[] = [];
  const now = Date.now();
  const tx = db.transaction(() => {
    for (const ev of events) {
      const qs = (mkStmt.all(ev.id) as Array<{ q: string }>).map((r) => r.q);
      const markets = qs.map((q) => ({ title: q }));
      let eventSlug: string | null = null;
      if (ev.id.startsWith("pf:") && !ev.id.startsWith("pf:m:")) {
        eventSlug = ev.id.slice(3);
      } else if (ev.s && !ev.s.startsWith("pf:")) {
        eventSlug = ev.s;
      }
      const next = pickPredictEventTitle(markets, eventSlug);
      if (next && next !== ev.t) {
        upd.run(next, now, ev.id);
        updated++;
        if (samples.length < 8) samples.push(`${ev.t}  =>  ${next}`);
      }
    }
  });
  tx();
  db.close();
  return { updated, total: events.length, samples };
}

const files = readdirSync(DIR).filter((f) => /^\d{4}-\d{2}\.db$/.test(f));
let u = 0;
let t = 0;
for (const f of files) {
  console.log(`repairing ${f}…`);
  const r = repairDb(join(DIR, f));
  console.log(`  updated ${r.updated}/${r.total}`);
  for (const s of r.samples) console.log(`  · ${s}`);
  u += r.updated;
  t += r.total;
}
console.log(`done: updated ${u}/${t}`);

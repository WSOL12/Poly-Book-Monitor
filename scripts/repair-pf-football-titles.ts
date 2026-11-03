/**
 * Re-apply PF football titles from Poly twins using slug-code matching only.
 * Clears previously wrong title repairs (ARG→Argyle etc.).
 */
import Database from "better-sqlite3";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { listEvents, findPredictTwins, twinMatchedIds } from "../web/lib/db.ts";
import {
  footballCodesMatchTitle,
  footballDisplayTitle,
  parseFootballSlug,
} from "../web/lib/footballSlugs.ts";

const DIR = join(process.cwd(), "data", "predictfun");
const soccer = listEvents("soccer");

/** Best poly title per PF football event. */
const repairs = new Map<string, string>();
for (const poly of soccer) {
  const twins = findPredictTwins(poly.title, 3, {
    anchorMs: poly.eventDate ? Date.parse(`${poly.eventDate}T12:00:00Z`) : poly.finishedAt,
  });
  for (const best of twins) {
    const parts = parseFootballSlug(best.eventId);
    if (!parts) continue;
    if (!footballCodesMatchTitle(parts.home, parts.away, poly.title, parts.league)) continue;
    const title = footballDisplayTitle(parts.home, parts.away, poly.title);
    const prev = repairs.get(best.eventId);
    // Prefer higher volume poly if collision
    if (!prev || (poly.volume ?? 0) > 0) repairs.set(best.eventId, title);
    break;
  }
}

console.log(`valid football repairs: ${repairs.size}`);

let updated = 0;
let cleared = 0;
for (const f of readdirSync(DIR).filter((x) => /^\d{4}-\d{2}\.db$/.test(x))) {
  const db = new Database(join(DIR, f));
  const rows = db
    .prepare(
      `SELECT id, t, s FROM ev WHERE id LIKE 'pf:epl-%' OR id LIKE 'pf:lal-%' OR id LIKE 'pf:fl1-%'
        OR id LIKE 'pf:bun-%' OR id LIKE 'pf:mls-%' OR id LIKE 'pf:ucl-%' OR id LIKE 'pf:uel-%'
        OR id LIKE 'pf:clf-%' OR id LIKE 'pf:fif-%' OR id LIKE 'pf:unl-%' OR id LIKE 'pf:efl-%'
        OR id LIKE 'pf:ser-%' OR id LIKE 'pf:acle-%'`,
    )
    .all() as Array<{ id: string; t: string; s: string }>;
  const upd = db.prepare(`UPDATE ev SET t = ?, u = ? WHERE id = ?`);
  const now = Date.now();
  const tx = db.transaction(() => {
    for (const row of rows) {
      const next = repairs.get(row.id);
      if (next) {
        if (row.t !== next) {
          upd.run(next, now, row.id);
          updated++;
        }
        continue;
      }
      // No valid twin — reset garbage/wrong titles back to slug humanization placeholder
      const parts = parseFootballSlug(row.id);
      if (!parts) continue;
      const placeholder = `${parts.league.toUpperCase()} ${parts.home.toUpperCase()} vs ${parts.away.toUpperCase()}`;
      // Only clear if current title looks like a mistaken full team name that fails code check
      if (/\bvs\.?\b/i.test(row.t) && !footballCodesMatchTitle(parts.home, parts.away, row.t, parts.league)) {
        upd.run(placeholder, now, row.id);
        cleared++;
        console.log(`  cleared bad ${row.id}: ${row.t} => ${placeholder}`);
      }
    }
  });
  tx();
  db.close();
}
console.log(`updated=${updated} cleared=${cleared}`);

const ids = twinMatchedIds();
const soccerWith = soccer.filter((e) => ids.has(e.eventId));
console.log(`soccer twins: ${soccerWith.length}/${soccer.length}`);
const epl = soccerWith.filter((e) =>
  /Bournemouth|Brighton|Brentford|Fulham FC vs\. Manchester|Arsenal FC|Chelsea FC vs/i.test(e.title),
);
console.log("sample EPL twins:");
for (const e of epl.slice(0, 15)) console.log(" ", e.title);
console.log("has Argyle twin?", soccerWith.some((e) => /Argyle/i.test(e.title)));

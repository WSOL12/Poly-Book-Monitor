/**
 * Rewrite PF tennis Yes/No token labels to player surnames in local DBs.
 */
import Database from "better-sqlite3";
import { readdirSync } from "node:fs";
import { join } from "node:path";

function playersFromMatchTitle(title: string): [string, string] | null {
  const raw = title.replace(/^[^:]+:\s*/, " ").trim();
  const parts = raw.split(/\s+vs\.?\s+|\s+versus\s+/i);
  if (parts.length !== 2) return null;
  const name = (s: string) => {
    const words = s.replace(/[^a-zA-Z0-9\s]/g, " ").replace(/\s+/g, " ").trim().split(" ");
    const last = words[words.length - 1] ?? s;
    return last ? last.charAt(0).toUpperCase() + last.slice(1) : s;
  };
  const a = name(parts[0]!);
  const b = name(parts[1]!);
  if (!a || !b) return null;
  return [a, b];
}

let updated = 0;
for (const f of readdirSync("data/predictfun").filter((x) => /^\d{4}-\d{2}\.db$/.test(x))) {
  const path = join("data/predictfun", f);
  let db: Database.Database;
  try {
    db = new Database(path);
  } catch {
    continue;
  }
  const rows = db
    .prepare(
      `SELECT t.id AS tid, t.sd AS side, t.lb AS label, m.q AS question
       FROM tk t JOIN mk m ON m.id = t.mid
       WHERE (t.eid LIKE 'pf:atp-%' OR t.eid LIKE 'pf:wta-%')
         AND lower(t.lb) IN ('yes','no')`,
    )
    .all() as Array<{ tid: string; side: string; label: string; question: string }>;
  const upd = db.prepare("UPDATE tk SET lb = ? WHERE id = ?");
  const tx = db.transaction(() => {
    for (const r of rows) {
      const players = playersFromMatchTitle(r.question ?? "");
      if (!players) continue;
      const next = r.side === "no" || r.side === "away" ? players[1] : players[0];
      if (next === r.label) continue;
      upd.run(next, r.tid);
      updated++;
    }
  });
  tx();
  db.close();
  console.log(f, "rows scanned", rows.length);
}
console.log("updated labels", updated);

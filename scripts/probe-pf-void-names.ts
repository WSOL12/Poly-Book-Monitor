import Database from "better-sqlite3";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const dir = "data/predictfun";
const needles = [
  "mayot",
  "cassone",
  "khachanov",
  "blockx",
  "kostyuk",
  "townsend",
  "djere",
  "mikrut",
  "prozorova",
  "gibson",
  "cerundolo",
  "ruud",
  "rennes",
  "us-open",
  "usopen",
];

for (const f of readdirSync(dir).filter((x) => /^\d{4}-\d{2}\.db$/.test(x))) {
  const db = new Database(join(dir, f), { readonly: true });
  console.log("===", f, "===");
  for (const n of needles) {
    const rows = db
      .prepare(
        `SELECT id, t, s, gs, e, c FROM ev
         WHERE lower(id) LIKE ? OR lower(t) LIKE ? OR lower(COALESCE(s,'')) LIKE ?
         LIMIT 5`,
      )
      .all(`%${n}%`, `%${n}%`, `%${n}%`) as Array<{
      id: string;
      t: string;
      s: string;
      gs: string | null;
      e: number;
      c: number;
    }>;
    if (rows.length) {
      console.log(`  ${n}:`);
      for (const r of rows) console.log(`    ${JSON.stringify(r)}`);
    }
  }
  // Also count PF by gameStatus-ish
  const gs = db.prepare(`SELECT gs, COUNT(*) c FROM ev GROUP BY gs`).all();
  console.log("  gs buckets", gs);
  db.close();
}

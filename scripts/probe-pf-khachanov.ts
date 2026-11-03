import Database from "better-sqlite3";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";

const dir = resolve("data/predictfun");
for (const f of readdirSync(dir).filter((n) => n.endsWith(".db") && !n.includes("_idx"))) {
  const db = new Database(resolve(dir, f), { readonly: true, fileMustExist: true });
  try {
    const n = (db.prepare("SELECT COUNT(*) AS c FROM ev").get() as { c: number }).c;
    const hits = db
      .prepare(
        `SELECT id, t, d FROM ev
         WHERE t LIKE '%Khachanov%' OR t LIKE '%Blockx%' OR t LIKE '%US Open%'
         LIMIT 30`,
      )
      .all() as Array<{ id: string; t: string; d: string }>;
    console.log(f, "events=", n, "hits=", hits.length);
    for (const h of hits.slice(0, 15)) console.log(" ", h.d, h.t.slice(0, 90));
  } catch (e) {
    console.log(f, e instanceof Error ? e.message : e);
  } finally {
    db.close();
  }
}

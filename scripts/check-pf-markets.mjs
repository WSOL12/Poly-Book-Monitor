import Database from "better-sqlite3";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

const root = "D:/Poly-Book-Monitor/data/predictfun";
if (!existsSync(root)) {
  console.log("no pf data dir");
  process.exit(0);
}
const months = readdirSync(root).filter((f) => f.endsWith(".db"));
console.log("pf months", months);
for (const m of months.slice(-4)) {
  const db = new Database(path.join(root, m), { readonly: true });
  const types = db.prepare("SELECT mt AS type, COUNT(*) AS c FROM tk GROUP BY mt ORDER BY c DESC").all();
  const events = db.prepare("SELECT COUNT(*) AS c FROM ev").get();
  const sample = db
    .prepare(
      `SELECT e.t AS title, COUNT(DISTINCT t.mid) AS markets
       FROM ev e JOIN tk t ON t.eid = e.id
       GROUP BY e.id
       HAVING markets > 1
       ORDER BY markets DESC
       LIMIT 5`,
    )
    .all();
  const one = db
    .prepare(
      `SELECT COUNT(*) AS c FROM (
         SELECT e.id FROM ev e JOIN tk t ON t.eid = e.id GROUP BY e.id HAVING COUNT(DISTINCT t.mid) = 1
       )`,
    )
    .get();
  console.log("\n", m, "events", events, "tokenTypes", types, "singleMarketEvents", one, "multiSample", sample);
  db.close();
}

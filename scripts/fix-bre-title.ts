import Database from "better-sqlite3";
const db = new Database("data/predictfun/2026-09.db");
db.prepare("UPDATE ev SET t = ?, u = ? WHERE id = ?").run(
  "Brentford FC vs Chelsea FC",
  Date.now(),
  "pf:epl-bre-che-2026-09-18",
);
console.log(db.prepare("SELECT t FROM ev WHERE id = ?").get("pf:epl-bre-che-2026-09-18"));
db.close();

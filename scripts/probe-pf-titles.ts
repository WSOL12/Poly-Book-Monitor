import Database from "better-sqlite3";

const db = new Database("data/predictfun/2026-09.db", { readonly: true });
const vs = db.prepare(`SELECT COUNT(*) AS c FROM ev WHERE t LIKE '% vs %'`).get() as { c: number };
const novs = db.prepare(`SELECT COUNT(*) AS c FROM ev WHERE t NOT LIKE '% vs %'`).get() as { c: number };
console.log({ withVs: vs.c, withoutVs: novs.c });

console.log("\nGOOD samples:");
for (const r of db
  .prepare(`SELECT id, t FROM ev WHERE t LIKE '% vs %' LIMIT 15`)
  .all() as Array<{ id: string; t: string }>) {
  console.log(r.t.slice(0, 90), "|", r.id.slice(0, 60));
}

console.log("\nBAD samples:");
for (const r of db
  .prepare(`SELECT id, t, s FROM ev WHERE t NOT LIKE '% vs %' LIMIT 20`)
  .all() as Array<{ id: string; t: string; s: string }>) {
  console.log(JSON.stringify(r));
}

console.log("\nslug with -vs- but title without:");
for (const r of db
  .prepare(
    `SELECT id, t FROM ev WHERE id LIKE '%-vs-%' AND t NOT LIKE '% vs %' LIMIT 15`,
  )
  .all() as Array<{ id: string; t: string }>) {
  console.log(r.id, "=>", r.t);
}

db.close();

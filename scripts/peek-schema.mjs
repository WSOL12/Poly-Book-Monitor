import Database from "better-sqlite3";
const db = new Database("D:/Poly-Book-Monitor/data/tennis/2026-08.db", { readonly: true });
for (const name of ["ob", "tk", "mk", "ev", "dl"]) {
  console.log(name, db.prepare(`SELECT sql FROM sqlite_master WHERE name=?`).get(name)?.sql);
}
db.close();

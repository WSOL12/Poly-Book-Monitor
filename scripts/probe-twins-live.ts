import { listEvents, findPredictTwins, findPolyTwins } from "../web/lib/db.ts";
import { DATA_DIR, listMonthFiles, dbPathForMonth, sportDir } from "../web/lib/paths.ts";
import { existsSync, readdirSync } from "node:fs";
import Database from "better-sqlite3";

console.log("DATA_DIR", DATA_DIR);
console.log("cwd", process.cwd());
console.log("pf dir", sportDir("predictfun"), existsSync(sportDir("predictfun")));
console.log("month files", listMonthFiles("predictfun"));
console.log("dir listing", existsSync(sportDir("predictfun")) ? readdirSync(sportDir("predictfun")).slice(0, 20) : null);

for (const month of listMonthFiles("predictfun")) {
  const path = dbPathForMonth("predictfun", month);
  console.log("open", path, existsSync(path));
  try {
    const db = new Database(path, { readonly: true, fileMustExist: true });
    const n = (db.prepare("SELECT COUNT(*) AS c FROM ev").get() as { c: number }).c;
    const sample = db.prepare("SELECT t, d FROM ev LIMIT 3").all();
    console.log("  ev count", n, sample);
    db.close();
  } catch (e) {
    console.log("  ERR", e instanceof Error ? e.message : e);
  }
}

const pf = listEvents("predictfun");
const tennis = listEvents("tennis");
console.log("listEvents predictfun", pf.length);
console.log("listEvents tennis", tennis.length);
console.log("PF sample", pf.slice(0, 5).map((e) => `${e.eventDate} ${e.title}`));

let hits = 0;
for (const ev of pf.slice(0, 80)) {
  const twins = findPolyTwins(ev.title, 3, {
    anchorMs: ev.startTime ? Date.parse(ev.startTime) : ev.eventDate ? Date.parse(ev.eventDate) : null,
  });
  if (twins[0] && twins[0].score >= 0.55) {
    hits++;
    if (hits <= 15) {
      console.log(
        `HIT ${twins[0].score.toFixed(2)} | ${ev.title} <=> ${twins[0].title} (${twins[0].sport})`,
      );
    }
  }
}
console.log(`PF→Poly hits in first 80: ${hits}`);

// Reverse: tennis → PF
let th = 0;
for (const ev of tennis.slice(0, 80)) {
  const twins = findPredictTwins(ev.title, 3, {
    anchorMs: ev.startTime ? Date.parse(ev.startTime) : ev.eventDate ? Date.parse(ev.eventDate) : null,
  });
  if (twins[0] && twins[0].score >= 0.55) {
    th++;
    if (th <= 15) {
      console.log(`REV ${twins[0].score.toFixed(2)} | ${ev.title} <=> ${twins[0].title}`);
    }
  }
}
console.log(`Tennis→PF hits in first 80: ${th}`);

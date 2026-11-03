import "../src/config/env.ts";
import { listEvents, findPredictTwins, findPolyTwins } from "../web/lib/db";
import { titleSimilarity } from "../web/lib/matchTitles";

const cases = [
  ["China Open: Alexander Bublik vs Jakub Mensik", "US Open ATP: Jakub Mensik vs Learner Tien"],
  ["China Open: Alexander Bublik vs Jakub Mensik", "China Open: Alexander Bublik vs Jakub Mensik"],
  ["Philadelphia Phillies vs. Atlanta Braves", "Atlanta Braves vs. Philadelphia Phillies"],
  ["Chicago Cubs vs. San Diego Padres", "San Diego Padres vs. San Francisco Giants"],
  ["China Open: Paula Badosa vs Daria Kasatkina", "US Open WTA: Daria Kasatkina vs Paula Badosa"],
];
for (const [a, b] of cases) {
  console.log(titleSimilarity(a, b).toFixed(3), "|", a, "<=>", b);
}

const pf = listEvents("predictfun");
let hits = 0;
for (const ev of pf) {
  const anchor =
    (ev.startTime ? Date.parse(ev.startTime) : NaN) ||
    (ev.eventDate ? Date.parse(ev.eventDate) : NaN) ||
    ev.lastSnapshotAt ||
    null;
  const twins = findPolyTwins(ev.title, 3, {
    anchorMs: typeof anchor === "number" && Number.isFinite(anchor) ? anchor : null,
  });
  if (twins[0]) {
    hits++;
    if (hits <= 12) console.log("HIT", twins[0].score.toFixed(2), ev.title, "<=>", twins[0].title, twins[0].sport);
  }
}
console.log("PF with poly twin", hits, "/", pf.length);

const mlb = listEvents("mlb").filter((e) => /phillies.*braves|braves.*phillies/i.test(e.title));
for (const ev of mlb.slice(0, 3)) {
  const twins = findPredictTwins(ev.title, 3, {
    anchorMs: ev.startTime ? Date.parse(ev.startTime) : null,
  });
  console.log("MLB->PF", ev.title, "->", twins.map((t) => `${t.score.toFixed(2)} ${t.title}`));
}

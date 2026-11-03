import "../src/config/env.ts";
import { listEvents, findPredictTwins, findPolyTwins } from "../web/lib/db";
import { titleSimilarity } from "../web/lib/matchTitles";

console.log(
  "badosa rematch",
  titleSimilarity(
    "China Open: Paula Badosa vs Daria Kasatkina",
    "US Open WTA: Daria Kasatkina vs Paula Badosa"
  )
);

const mlbPoly = listEvents("mlb").filter((e) => /phillies.*braves|braves.*phillies/i.test(e.title));
const mlbPf = listEvents("predictfun").filter((e) => /phillies.*braves|braves.*phillies/i.test(e.title));
console.log("mlb poly", mlbPoly.map((e) => e.title));
console.log("mlb pf", mlbPf.map((e) => e.title));
for (const ev of mlbPf.slice(0, 2)) {
  console.log(
    "PF->Poly",
    findPolyTwins(ev.title, 3).map((t) => `${t.score.toFixed(2)} ${t.title}`)
  );
}
for (const ev of mlbPoly.slice(0, 2)) {
  console.log(
    "Poly->PF",
    findPredictTwins(ev.title, 3).map((t) => `${t.score.toFixed(2)} ${t.title}`)
  );
}

// Count real twins across PF
let n = 0;
for (const ev of listEvents("predictfun")) {
  const t = findPolyTwins(ev.title, 1)[0];
  if (t) {
    n++;
    if (n <= 15) console.log("TWIN", t.score.toFixed(2), ev.title, "<=>", t.title, t.sport);
  }
}
console.log("total PF with twin", n);

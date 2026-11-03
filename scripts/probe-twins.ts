import "../src/config/env.ts";
import { listEvents, findPredictTwins, findPolyTwins } from "../web/lib/db";

const pf = listEvents("predictfun");
console.log("PF events:", pf.length);
console.log(
  "sample PF:",
  pf.slice(0, 8).map((e) => e.title)
);

const tennis = listEvents("tennis").filter(
  (e) =>
    (e.title || "").toLowerCase().includes("bublik") ||
    (e.title || "").toLowerCase().includes("mensik") ||
    (e.title || "").toLowerCase().includes("china open")
);
console.log(
  "Poly China/Bublik/Mensik:",
  tennis.slice(0, 10).map((e) => e.title)
);

for (const ev of tennis.slice(0, 8)) {
  const twins = findPredictTwins(ev.title, 3);
  console.log(
    "POLY",
    ev.title,
    "->",
    twins.map((t) => `${t.score.toFixed(2)}|${t.title}`)
  );
}

const pfHit = pf.filter(
  (e) =>
    (e.title || "").toLowerCase().includes("bublik") ||
    (e.title || "").toLowerCase().includes("mensik") ||
    (e.title || "").toLowerCase().includes("china")
);
console.log("PF China/Bublik hits:", pfHit.length, pfHit.slice(0, 5).map((e) => e.title));
for (const ev of pfHit.slice(0, 5)) {
  const twins = findPolyTwins(ev.title, 3);
  console.log(
    "PF",
    ev.title,
    "->",
    twins.map((t) => `${t.score.toFixed(2)}|${t.title}|${t.sport}`)
  );
}

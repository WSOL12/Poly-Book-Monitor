import "../src/config/env.ts";
import { listEvents, findPolyTwins, findPredictTwins } from "../web/lib/db";

const pf = listEvents("predictfun").find((e) => /bublik.*mensik/i.test(e.title));
const poly = listEvents("tennis").find((e) => /china open: alexander bublik vs jakub mensik/i.test(e.title));
console.log("PF", pf?.title, pf?.eventId, "snaps?", pf?.lastSnapshotAt);
console.log("Poly", poly?.title, poly?.eventId, "snaps?", poly?.lastSnapshotAt);
if (pf) {
  console.log(
    "PF->Poly",
    findPolyTwins(pf.title, 3).map((t) => `${t.score.toFixed(2)} ${t.title} ${t.eventId}`)
  );
}
if (poly) {
  console.log(
    "Poly->PF",
    findPredictTwins(poly.title, 3).map((t) => `${t.score.toFixed(2)} ${t.title} ${t.eventId}`)
  );
}

let n = 0;
for (const ev of listEvents("predictfun")) {
  const t = findPolyTwins(ev.title, 1)[0];
  if (t && t.score >= 0.7) {
    n++;
    if (n <= 20) console.log("OK", t.score.toFixed(2), ev.title, "<=>", t.title);
  }
}
console.log("strong twins", n);

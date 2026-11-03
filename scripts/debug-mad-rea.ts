import { listEvents, findPredictTwins } from "../web/lib/db.ts";
import { footballCodesMatchTitle, abbrevScore, parseFootballSlug } from "../web/lib/footballSlugs.ts";

const soccer = listEvents("soccer");
const hits = soccer.filter((e) => /Atletico|Atlético/i.test(e.title) && /Real Madrid/i.test(e.title));
console.log(
  "poly atleti-real",
  hits.map((e) => `${e.eventDate} ${e.title}`),
);
const p = parseFootballSlug("pf:lal-mad-rea-2026-09-20")!;
for (const h of hits) {
  console.log("match?", footballCodesMatchTitle(p.home, p.away, h.title, p.league), h.title);
  const parts = h.title.split(/\s+vs\.?\s+/i);
  console.log(
    " scores mad/rea",
    abbrevScore("mad", parts[0] ?? "", "lal"),
    abbrevScore("rea", parts[1] ?? "", "lal"),
    abbrevScore("mad", parts[1] ?? "", "lal"),
    abbrevScore("rea", parts[0] ?? "", "lal"),
  );
}
const t = findPredictTwins("Club Atlético de Madrid vs. Real Madrid CF", 3, {
  anchorMs: Date.parse("2026-09-20T12:00:00Z"),
});
console.log(
  "twins",
  t.map((x) => `${x.score} ${x.eventId} ${x.title}`),
);

// Why Aston Villa vs Arsenal miss?
const villa = soccer.find((e) => e.title === "Aston Villa FC vs. Arsenal FC");
console.log("villa event", villa?.eventDate, villa?.eventId);
const pf = listEvents("predictfun").filter((e) => /epl-.*ars|epl-ast|epl-avl/i.test(e.eventId));
console.log(
  "pf villa/ars candidates",
  pf.map((e) => `${e.eventId} ${e.title}`),
);

import { listEvents, findPredictTwins, twinMatchedIds } from "../web/lib/db.ts";
import { titleSimilarity } from "../web/lib/matchTitles.ts";

const soccer = listEvents("soccer");
const pf = listEvents("predictfun").filter((e) => /\bvs\.?\b/i.test(e.title));

console.log("soccer events", soccer.length);
console.log("PF vs-title events", pf.length);

const pfSoccerish = pf.filter(
  (e) =>
    /premier|champions|laliga|serie|bundesliga|mls|epl|uefa|soccer|football| vs /i.test(e.title) ||
    /^[a-z]{2,4}-/.test(e.eventId) && /fl1|epl|ucl|mls|lal|ser|bun/i.test(e.eventId),
);
console.log("PF maybe soccer sample", pfSoccerish.slice(0, 25).map((e) => e.title.slice(0, 70)));

let hits = 0;
const examples: string[] = [];
for (const ev of soccer.slice(0, 200)) {
  const twins = findPredictTwins(ev.title, 1, {
    anchorMs: ev.eventDate ? Date.parse(ev.eventDate) : ev.finishedAt,
  });
  const best = twins[0];
  if (best && best.score >= 0.55) {
    hits++;
    if (examples.length < 20) {
      examples.push(`${best.score.toFixed(2)} | ${ev.title.slice(0, 55)} <=> ${best.title.slice(0, 55)}`);
    }
  }
}
console.log(`\nSoccer→PF hits (first 200): ${hits}/200`);
for (const e of examples) console.log(" ", e);

const ids = twinMatchedIds();
const soccerWithFlag = soccer.filter((e) => ids.has(e.eventId));
console.log(`\nSoccer with twin flag: ${soccerWithFlag.length}/${soccer.length}`);
for (const e of soccerWithFlag.slice(0, 15)) {
  console.log(" ", e.title.slice(0, 65));
}

// Brute: any PF title that scores vs any soccer
let brute = 0;
for (const p of pf.slice(0, 500)) {
  for (const s of soccer.slice(0, 500)) {
    const sc = titleSimilarity(s.title, p.title);
    if (sc >= 0.55) {
      brute++;
      if (brute <= 10) console.log("BRUTE", sc.toFixed(2), s.title.slice(0, 40), "<=>", p.title.slice(0, 40));
    }
  }
}
console.log("brute pairs in 500x500 sample", brute);

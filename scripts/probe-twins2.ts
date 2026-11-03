import "../src/config/env.ts";
import { listEvents, findPredictTwins, findPolyTwins } from "../web/lib/db";
import { titleSimilarity, normalizeMatchTitle } from "../web/lib/matchTitles";

const pf = listEvents("predictfun");
const tennis = listEvents("tennis");
const soccer = listEvents("soccer");
const mlb = listEvents("mlb");

console.log({
  pf: pf.length,
  tennis: tennis.length,
  soccer: soccer.length,
  mlb: mlb.length,
  polyChina: tennis.filter((e) => /china/i.test(e.title)).length,
  pfChina: pf.filter((e) => /china/i.test(e.title)).length,
});

function sides(title: string): [string, string] | null {
  const n = normalizeMatchTitle(title);
  const parts = n.split(/\s+vs\s+/);
  if (parts.length !== 2) return null;
  return [parts[0]!.trim(), parts[1]!.trim()];
}

// Better score: both last-name sets must largely overlap
function pairScore(a: string, b: string): number {
  const sa = sides(a);
  const sb = sides(b);
  if (!sa || !sb) return titleSimilarity(a, b);
  const last = (s: string) =>
    s
      .split(/\s+/)
      .filter((t) => t.length >= 3)
      .map((t) => t.replace(/[^a-z]/g, ""))
      .filter(Boolean);
  const a0 = new Set(last(sa[0]));
  const a1 = new Set(last(sa[1]));
  const b0 = new Set(last(sb[0]));
  const b1 = new Set(last(sb[1]));
  const hit = (x: Set<string>, y: Set<string>) => {
    let n = 0;
    for (const t of x) if (y.has(t)) n++;
    return n;
  };
  // same order or swapped
  const same = hit(a0, b0) > 0 && hit(a1, b1) > 0;
  const swap = hit(a0, b1) > 0 && hit(a1, b0) > 0;
  if (!same && !swap) return 0;
  return titleSimilarity(a, b);
}

let good = 0;
let checked = 0;
for (const ev of pf.slice(0, 200)) {
  if (!/vs/i.test(ev.title)) continue;
  checked++;
  const twins = findPolyTwins(ev.title, 5);
  const best = twins[0];
  if (!best) continue;
  const ps = pairScore(ev.title, best.title);
  if (ps >= 0.5) {
    good++;
    if (good <= 15) console.log("GOOD", ps.toFixed(2), "|", ev.title, "<=>", best.title, best.sport);
  }
}
console.log({ checked, goodPairsApprox: good });

// Also scan poly tennis for any china open
console.log(
  "sample tennis recent",
  tennis
    .slice(0, 15)
    .map((e) => e.title)
);

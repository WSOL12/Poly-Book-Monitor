import { listEvents } from "../web/lib/db.ts";
import { titleSimilarity as sim } from "../web/lib/matchTitles.ts";

const pf = listEvents("predictfun");
const tennis = listEvents("tennis");

function phase(e: { gameStatus?: string | null; ended?: boolean; closed?: boolean; polyLive?: boolean; sport?: string | null }) {
  const gs = e.gameStatus?.trim().toLowerCase() ?? "";
  if (gs === "retired") return "retired";
  if (gs === "canceled" || gs === "cancelled") return "canceled";
  if (e.ended || e.closed) return "finished";
  if (e.polyLive) return "live";
  return "open";
}

const voids = tennis.filter((e) => {
  const p = phase(e);
  return p === "retired" || p === "canceled";
});

const needles = [
  "Khachanov",
  "Blockx",
  "Mayot",
  "Cassone",
  "Kostyuk",
  "Townsend",
  "Djere",
  "Mikrut",
  "Prozorova",
  "Gibson",
  "Bublik",
];

console.log("PF titles containing void-player needles:");
for (const n of needles) {
  const hits = pf.filter((e) => e.title.toLowerCase().includes(n.toLowerCase()) || e.slug?.toLowerCase().includes(n.toLowerCase()) || e.eventId.toLowerCase().includes(n.toLowerCase()));
  console.log(`  ${n}: ${hits.length}`);
  for (const h of hits.slice(0, 3)) console.log(`    · ${h.title} | ${h.eventId}`);
}

// For each void poly, brute force best PF title score ignoring twinable filter
console.log("\nBrute PF scan for first 25 voids (any PF title, score>=0.4):");
let any = 0;
for (const e of voids.slice(0, 25)) {
  let best: { score: number; title: string; id: string } | null = null;
  for (const p of pf) {
    const score = sim(e.title, p.title);
    if (score < 0.4) continue;
    if (!best || score > best.score) best = { score, title: p.title, id: p.eventId };
  }
  if (best) {
    any++;
    console.log(`  HIT ${best.score.toFixed(2)} | ${e.title.slice(0, 55)} <=> ${best.title.slice(0, 55)}`);
  } else {
    // also try slug humanized among PF ids
    console.log(`  NONE     | ${e.title.slice(0, 70)}`);
  }
}
console.log(`brute hits: ${any}/25`);

// How many PF china/us open style titles?
const goodPf = pf.filter((e) => /\bvs\.?\b/i.test(e.title));
console.log("\nPF with vs:", goodPf.length);
console.log("sample PF vs titles:", goodPf.slice(0, 10).map((e) => e.title));

// Cross: voids that share surnames with any good PF
console.log("\nSurname overlap voids↔PF:");
function surnames(title: string): string[] {
  const m = title.toLowerCase().replace(/^[^:]+:\s*/, "").split(/\s+vs\.?\s+/i);
  if (m.length !== 2) return [];
  return m.flatMap((side) => {
    const parts = side.replace(/[^a-z\s]/g, " ").trim().split(/\s+/).filter(Boolean);
    return parts.length ? [parts[parts.length - 1]!] : [];
  });
}
let surnameHits = 0;
for (const e of voids) {
  const sn = new Set(surnames(e.title));
  if (sn.size < 2) continue;
  const match = goodPf.find((p) => {
    const ps = surnames(p.title);
    return ps.filter((x) => sn.has(x)).length >= 2;
  });
  if (match) {
    surnameHits++;
    if (surnameHits <= 20) {
      console.log(`  ${e.gameStatus} | ${e.title.slice(0, 55)} <=> ${match.title.slice(0, 55)} score=${sim(e.title, match.title).toFixed(2)}`);
    }
  }
}
console.log(`surname both-side hits: ${surnameHits}/${voids.length}`);

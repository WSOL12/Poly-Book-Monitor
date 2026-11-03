import { listEvents, findPredictTwins, twinMatchedIds } from "../web/lib/db.ts";

function phase(gs: string | null | undefined) {
  const g = gs?.trim().toLowerCase() ?? "";
  if (g === "retired") return "retired";
  if (g === "canceled" || g === "cancelled") return "canceled";
  return "other";
}

const tennis = listEvents("tennis");
const voids = tennis.filter((e) => phase(e.gameStatus) !== "other");
const ids = twinMatchedIds();

let hits = 0;
const hitRows: string[] = [];
const missUs: string[] = [];
for (const e of voids) {
  const twins = findPredictTwins(e.title, 2, {
    anchorMs: e.eventDate ? Date.parse(e.eventDate) : e.finishedAt,
  });
  const best = twins[0];
  if (best && best.score >= 0.55) {
    hits++;
    hitRows.push(
      `${e.gameStatus} ${best.score.toFixed(2)} | ${e.title.slice(0, 55)} <=> ${best.title.slice(0, 55)} flag=${ids.has(e.eventId)}`,
    );
  } else if (/us open/i.test(e.title)) {
    missUs.push(`${e.gameStatus} ${e.title}`);
  }
}
console.log(`void twin hits: ${hits}/${voids.length}`);
console.log("\nHITS:");
for (const r of hitRows) console.log(" ", r);
console.log(`\nUS Open voids still missing: ${missUs.length}`);
for (const r of missUs.slice(0, 30)) console.log(" ", r);

// Check PF has Kostyuk etc
const pf = listEvents("predictfun");
for (const n of ["Kostyuk", "Cerundolo", "Cilic", "Blockx", "Jodar", "Sweeny", "Moutet"]) {
  const rows = pf.filter((e) => e.title.includes(n));
  console.log(`PF ${n}: ${rows.length}`, rows.slice(0, 2).map((e) => e.title));
}

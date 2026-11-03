import { listEvents, findPolyTwins, findPredictTwins } from "../web/lib/db.ts";

function phase(e: {
  sport?: string | null;
  ended?: boolean;
  closed?: boolean;
  polyLive?: boolean;
  gameStatus?: string | null;
}) {
  const gs = e.gameStatus?.trim().toLowerCase() ?? "";
  if (e.sport === "tennis") {
    if (gs === "retired") return "retired";
    if (gs === "canceled" || gs === "cancelled") return "canceled";
    if ((e.ended || e.closed) && gs === "started") return "finished";
    if (gs === "started" || e.polyLive) return "live";
    if (e.ended || e.closed) return "finished";
    return "open";
  }
  if (e.ended || e.closed) return "finished";
  return e.polyLive ? "live" : "open";
}

const pf = listEvents("predictfun").filter((e) => /\bvs\.?\b/i.test(e.title));
const byPhase: Record<string, number> = {};
const examples: Record<string, string[]> = {};

for (const p of pf) {
  const best = findPolyTwins(p.title, 1, {
    anchorMs: p.startTime
      ? Date.parse(p.startTime)
      : p.eventDate
        ? Date.parse(p.eventDate)
        : p.finishedAt,
  })[0];
  if (!best || best.score < 0.55) continue;
  const ph = phase(best);
  byPhase[ph] = (byPhase[ph] ?? 0) + 1;
  const list = (examples[ph] ??= []);
  if (list.length < 10) {
    list.push(
      `${best.score.toFixed(2)} PF:${p.title.slice(0, 42)} => POLY[${ph}|${best.gameStatus}] ${best.title.slice(0, 42)}`,
    );
  }
}

console.log("PF→Poly twin phase distribution:", byPhase);
for (const [ph, rows] of Object.entries(examples)) {
  console.log(`\n=== ${ph} ===`);
  for (const r of rows) console.log(" ", r);
}

const tennis = listEvents("tennis");
const voids = tennis.filter((e) => {
  const p = phase(e);
  return p === "retired" || p === "canceled";
});
console.log("\nPoly voids (China/US/Laver) twin lookup:");
for (const e of voids.filter((x) => /china open|us open|laver/i.test(x.title))) {
  const t = findPredictTwins(e.title, 3, {
    anchorMs: e.eventDate ? Date.parse(e.eventDate) : null,
  });
  console.log(
    `  ${e.gameStatus} ${e.title.slice(0, 65)}\n    =>`,
    t.map((x) => `${x.score.toFixed(2)} ${x.title.slice(0, 45)}`).join(" | ") || "none",
  );
}

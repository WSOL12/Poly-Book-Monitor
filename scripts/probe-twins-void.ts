/**
 * Probe twin hits among tennis retired/canceled vs open/done.
 */
import { listEvents, findPredictTwins, twinMatchedIds } from "../web/lib/db.ts";

function phase(e: { sport?: string | null; ended?: boolean; closed?: boolean; polyLive?: boolean; gameStatus?: string | null }) {
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
  return "live";
}

const tennis = listEvents("tennis");
const buckets: Record<string, typeof tennis> = {
  open: [],
  live: [],
  retired: [],
  canceled: [],
  finished: [],
};
for (const e of tennis) buckets[phase(e)]!.push(e);

const twinIds = twinMatchedIds();

for (const [p, rows] of Object.entries(buckets)) {
  const withTwin = rows.filter((e) => twinIds.has(e.eventId));
  console.log(
    `${p}: ${withTwin.length}/${rows.length} have twin flag (${((100 * withTwin.length) / Math.max(1, rows.length)).toFixed(1)}%)`,
  );
}

function look(label: string, rows: typeof tennis) {
  console.log(`\n${label} sample (first 20) twin lookup:`);
  for (const e of rows.slice(0, 20)) {
    const twins = findPredictTwins(e.title, 2, {
      anchorMs: e.startTime
        ? Date.parse(e.startTime)
        : e.eventDate
          ? Date.parse(e.eventDate)
          : e.finishedAt,
    });
    const best = twins[0];
    console.log(
      best
        ? `  HIT ${best.score.toFixed(2)} | ${e.title.slice(0, 70)} <=> ${best.title.slice(0, 55)}`
        : `  MISS     | ${e.title.slice(0, 70)} gs=${e.gameStatus} d=${e.eventDate}`,
    );
  }
}

look("Retired", buckets.retired!);
look("Canceled", buckets.canceled!);

const pf = listEvents("predictfun").filter((e) => /\bvs\.?\b/i.test(e.title));
console.log("\nPF twinable titles:", pf.length);
console.log("twinMatchedIds size:", twinIds.size);

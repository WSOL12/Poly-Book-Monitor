import { listEvents, findPredictTwins, twinMatchedIds } from "../web/lib/db.ts";
import { parseFootballSlug, footballCodesMatchTitle } from "../web/lib/footballSlugs.ts";

const soccer = listEvents("soccer");
const epl = [
  "AFC Bournemouth vs. Liverpool FC",
  "Brighton & Hove Albion FC vs. Arsenal FC",
  "Brentford FC vs. Chelsea FC",
  "Fulham FC vs. Manchester United FC",
  "Aston Villa FC vs. Arsenal FC",
];
for (const t of epl) {
  const twins = findPredictTwins(t, 3, {
    anchorMs: Date.parse((soccer.find((e) => e.title === t)?.eventDate ?? "2026-09-20") + "T12:00:00Z"),
  });
  console.log(t);
  for (const tw of twins) console.log(`  ${tw.score.toFixed(2)} ${tw.eventId} | ${tw.title}`);
  if (!twins.length) console.log("  MISS");
}

console.log("\nFalse-positive checks:");
const bad = [
  ["pf:fif-arg-bur-2026-10-03", "Plymouth Argyle FC vs. Burton Albion FC"],
  ["pf:fl1-olm-psg-2026-09-20", "Olympique de Marseille vs. Paris FC"],
];
for (const [id, title] of bad) {
  const p = parseFootballSlug(id)!;
  console.log(id, title, "→", footballCodesMatchTitle(p.home, p.away, title, p.league));
}

const ids = twinMatchedIds();
const withTwin = soccer.filter((e) => ids.has(e.eventId));
console.log(`\nsoccer twins: ${withTwin.length}`);
const eplTwins = withTwin.filter((e) => /Arsenal|Liverpool|Chelsea|Manchester United|Bournemouth|Brentford|Brighton/i.test(e.title));
console.log("EPL-ish twins:");
for (const e of eplTwins) console.log(" ", e.title);

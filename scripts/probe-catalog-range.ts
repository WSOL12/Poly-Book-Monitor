/**
 * Probe how far back Gamma catalog goes for each sport (no Predexon downloads).
 *   npx tsx scripts/probe-catalog-range.ts
 *   npx tsx scripts/probe-catalog-range.ts --days 30
 */
import "../src/config/env.ts";
import { fetchSportCatalog, SPORT_TAGS } from "../src/catalog/gamma.ts";
import { parseHistorySportEvents } from "../src/catalog/parsers.ts";
import type { MonitorSport } from "../src/types/monitoring.ts";

const days = Number(process.argv.includes("--days") ? process.argv[process.argv.indexOf("--days") + 1] : 30);
const toMs = Date.now();
const fromMs = toMs - days * 86_400_000;
const sports: MonitorSport[] = ["soccer", "football", "mlb", "tennis", "weather"];

console.log(`window ${new Date(fromMs).toISOString()} → ${new Date(toMs).toISOString()} (${days}d)\n`);

for (const sport of sports) {
  const raw = await fetchSportCatalog({
    sport,
    status: "both",
    fromMs,
    toMs,
  });
  const parsed = parseHistorySportEvents(sport, raw);
  const byDay = new Map<string, number>();
  for (const ev of parsed) {
    const d = (ev.eventDate ?? ev.startTime?.slice(0, 10) ?? "?").slice(0, 10);
    byDay.set(d, (byDay.get(d) ?? 0) + 1);
  }
  const daysSorted = [...byDay.keys()].sort();
  console.log(
    `${sport} tags=${SPORT_TAGS[sport].join(",")} raw=${raw.length} parsed=${parsed.length} ` +
      `span=${daysSorted[0] ?? "-"}..${daysSorted[daysSorted.length - 1] ?? "-"} (${daysSorted.length} days)`,
  );
}

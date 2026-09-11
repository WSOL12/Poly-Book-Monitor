import { fetchEventsByTags, SPORT_TAGS } from "../src/catalog/gamma.ts";
import { parseLiveSportEvents } from "../src/catalog/parsers.ts";

for (const sport of ["soccer", "football", "mlb"] as const) {
  const events = await fetchEventsByTags(SPORT_TAGS[sport]);
  const parsed = parseLiveSportEvents(sport, events);
  console.log(`\n${sport}: ${parsed.length} matches`);
  for (const match of parsed) {
    const ml = match.markets.filter((m) => m.marketType === "moneyline").length;
    const ou = match.markets.filter((m) => m.marketType === "total").length;
    const tok = match.markets.reduce((n, m) => n + m.tokens.length, 0);
    console.log(`  ${match.title}  ML:${ml} O/U:${ou} tokens:${tok}`);
  }
}

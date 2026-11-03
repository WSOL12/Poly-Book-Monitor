import "../src/config/env.ts";
import { parseApiKeysFromEnv } from "../src/predexon/client.ts";
import { listPredictMarkets, groupPredictEvents, titleFromEventSlug } from "../src/predexon/predictfun.ts";
import { listEvents } from "../web/lib/db.ts";
import { titleSimilarity } from "../web/lib/matchTitles.ts";

const client = { apiKeys: parseApiKeysFromEnv(), requestDelayMs: 40 };

const markets = await listPredictMarkets(client, {
  status: "closed",
  search: "lal-",
  maxPages: 20,
  sort: "created",
});
console.log("lal- markets", markets.length);

const slugs = new Map<string, (typeof markets)[number][]>();
for (const m of markets) {
  const slug = m.eventSlug ?? "none";
  const list = slugs.get(slug) ?? [];
  list.push(m);
  slugs.set(slug, list);
}

const baseSlugs = [...slugs.keys()].filter((s) => /^(lal|epl|ucl|fl1|ser|bun|mls)-/.test(s) && !/-more-markets|-total-|-exact-score|-corners/i.test(s));
console.log("base match slugs sample", baseSlugs.slice(0, 30));

for (const slug of baseSlugs.slice(0, 15)) {
  const list = slugs.get(slug)!;
  console.log(`\n${slug}`);
  for (const m of list.slice(0, 5)) console.log(`  [${m.marketVariant}] ${m.title}`);
  const g = groupPredictEvents(list)[0];
  console.log(`  grouped title: ${g?.title ?? "?"}`);
  console.log(`  slug title: ${titleFromEventSlug(slug)}`);
}

// Poly sample vs PF slug search
const poly = listEvents("soccer").filter((e) => / vs\.? /i.test(e.title)).slice(0, 5);
console.log("\n--- try event_slug lookup for poly samples ---");
for (const p of poly) {
  const q = p.title.replace(/\./g, "").split(/\s+vs\.?\s+/i)[0]?.split(" ").slice(-2).join(" ") ?? p.title.slice(0, 15);
  const found = await listPredictMarkets(client, { status: "closed", search: q, maxPages: 2 });
  const groups = groupPredictEvents(found).filter((g) => g.eventSlug?.startsWith("lal-") || g.eventSlug?.startsWith("epl-"));
  let best = { score: 0, title: "" };
  for (const g of groups) {
    const sc = titleSimilarity(p.title, g.title);
    if (sc > best.score) best = { score: sc, title: g.title };
    const fromSlug = titleFromEventSlug(g.eventSlug);
    if (fromSlug) {
      const sc2 = titleSimilarity(p.title, fromSlug);
      if (sc2 > best.score) best = { score: sc2, title: fromSlug };
    }
  }
  console.log(p.title.slice(0, 55), "→", best.score.toFixed(2), best.title.slice(0, 55));
}

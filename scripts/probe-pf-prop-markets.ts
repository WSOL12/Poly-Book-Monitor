/**
 * Probe: what markets exist on Predexon for a PF soccer fixture beyond moneyline?
 */
import "../src/config/env.ts";
import { parseApiKeysFromEnv } from "../src/predexon/client.ts";
import { listPredictMarkets, groupPredictEvents } from "../src/predexon/predictfun.ts";
import Database from "better-sqlite3";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const client = { apiKeys: parseApiKeysFromEnv(), requestDelayMs: 40 };

const slugs = [
  "epl-bri-ars-2026-09-19",
  "epl-mac-sun-2026-09-20",
  "epl-bre-che-2026-09-18",
];

for (const base of slugs) {
  console.log(`\n======== ${base} ========`);
  // Local DB
  for (const f of readdirSync("data/predictfun").filter((x) => /^\d{4}-\d{2}\.db$/.test(x))) {
    const db = new Database(join("data/predictfun", f), { readonly: true });
    const ev = db.prepare("SELECT id, t FROM ev WHERE id = ?").get(`pf:${base}`) as
      | { id: string; t: string }
      | undefined;
    if (ev) {
      const ob = (db.prepare("SELECT COUNT(*) AS n FROM ob WHERE eid = ?").get(ev.id) as { n: number }).n;
      const mk = db.prepare("SELECT q, mt FROM mk WHERE eid = ?").all(ev.id) as Array<{ q: string; mt: string }>;
      console.log(`  LOCAL ${f}: title=${ev.t} ob=${ob} markets=${mk.length}`);
      for (const m of mk) console.log(`    [${m.mt}] ${m.q}`);
    }
    // Related slug events
    const related = db
      .prepare("SELECT id, t FROM ev WHERE id LIKE ?")
      .all(`pf:${base}%`) as Array<{ id: string; t: string }>;
    if (related.length > 1) {
      console.log(`  LOCAL related slugs:`, related.map((r) => r.id));
    }
    db.close();
  }

  // Live Predexon: base + suffix searches
  const suffixes = ["", "-exact-score", "-more-markets", "-total-corners", "-corners"];
  const all: Awaited<ReturnType<typeof listPredictMarkets>> = [];
  for (const suf of suffixes) {
    const slug = `${base}${suf}`;
    for (const status of ["closed", "open"] as const) {
      const page = await listPredictMarkets(client, { eventSlug: slug, status, maxPages: 3 });
      if (page.length) {
        console.log(`  API ${slug} ${status}: ${page.length} markets`);
        for (const m of page.slice(0, 8)) {
          console.log(`    [${m.marketVariant}] ${m.title} id=${m.marketId} slug=${m.eventSlug}`);
        }
        all.push(...page);
      }
    }
  }
  // Also search by team code fragment
  const search = await listPredictMarkets(client, {
    status: "closed",
    search: base.slice(0, 11),
    maxPages: 5,
  });
  const relatedSearch = search.filter((m) => (m.eventSlug ?? "").startsWith(base));
  console.log(`  API search related to base: ${relatedSearch.length}`);
  const bySlug = new Map<string, number>();
  for (const m of relatedSearch) {
    const s = m.eventSlug ?? "?";
    bySlug.set(s, (bySlug.get(s) ?? 0) + 1);
  }
  for (const [s, n] of [...bySlug.entries()].sort()) console.log(`    ${s}: ${n}`);

  const groups = groupPredictEvents(all);
  console.log(`  grouped from suffix fetch: ${groups.length}`);
}

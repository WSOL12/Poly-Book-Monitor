/**
 * Live Predexon search: do voided Poly tennis matches exist on Predict.fun?
 */
import "../src/config/env.ts";
import { parseApiKeysFromEnv } from "../src/predexon/client.ts";
import { listPredictMarkets, groupPredictEvents } from "../src/predexon/predictfun.ts";
import { listEvents } from "../web/lib/db.ts";
import { titleSimilarity } from "../web/lib/matchTitles.ts";

function phase(e: { gameStatus?: string | null }) {
  const gs = e.gameStatus?.trim().toLowerCase() ?? "";
  if (gs === "retired") return "retired";
  if (gs === "canceled" || gs === "cancelled") return "canceled";
  return "other";
}

const keys = parseApiKeysFromEnv();
const client = { apiKeys: keys, requestDelayMs: 50 };

const tennis = listEvents("tennis");
const voids = tennis.filter((e) => phase(e) !== "other").slice(0, 12);

console.log("Searching Predexon PF for", voids.length, "void poly matches…");

for (const e of voids) {
  const parts = e.title.replace(/^[^:]+:\s*/, "").split(/\s+vs\.?\s+/i);
  const side = parts[0]?.trim().split(/\s+/).filter(Boolean) ?? [];
  const q = (side[side.length - 1] ?? e.title.slice(0, 20)).replace(/[^a-zA-Z]/g, "");
  if (q.length < 3) continue;
  try {
    const markets: Awaited<ReturnType<typeof listPredictMarkets>> = [];
    for (const status of ["closed", "open"] as const) {
      markets.push(
        ...(await listPredictMarkets(client, {
          status,
          search: q.slice(0, 40),
          limit: 50,
        })),
      );
    }
    const groups = groupPredictEvents(markets);
    let best: { score: number; title: string; status: string } | null = null;
    for (const g of groups) {
      const score = titleSimilarity(e.title, g.title);
      if (!best || score > best.score) best = { score, title: g.title, status: g.status };
    }
    console.log(
      `${e.gameStatus} ${e.title.slice(0, 55)}\n  search=${q} markets=${markets.length} groups=${groups.length}` +
        (best ? ` best=${best.score.toFixed(2)} [${best.status}] ${best.title.slice(0, 55)}` : " best=none"),
    );
  } catch (err) {
    console.log(`ERR ${q}`, err instanceof Error ? err.message : err);
  }
}

import "../src/config/env.ts";
import { parseApiKeysFromEnv, predexonGet, asRecord, asString, asNumber } from "../src/predexon/client.ts";
import { fetchPolyOrderbooks } from "../src/predexon/orderbooks.ts";

const client = { apiKeys: parseApiKeysFromEnv(), requestDelayMs: 40 };

// 1) Predexon games tag — recent closed match events
{
  const q = new URLSearchParams({
    status: "closed",
    sort: "end_date_desc",
    limit: "20",
    tag: "games",
    include_markets: "true",
    markets_per_event: "10",
  });
  const body = asRecord(await predexonGet(client, `/v2/polymarket/events/keyset?${q}`, "games"));
  const events = Array.isArray(body?.events) ? body.events : [];
  console.log("\n## Predexon tag=games closed", events.length);
  for (const item of events.slice(0, 15)) {
    const row = asRecord(item);
    const title = asString(row?.title) ?? "";
    const markets = Array.isArray(row?.markets) ? row.markets : [];
    const m0 = asRecord(markets[0]);
    const outcomes = Array.isArray(m0?.outcomes) ? m0.outcomes : [];
    const tok = asString(asRecord(outcomes[0])?.token_id);
    console.log(`${asString(row?.end_date) ?? "-"} | mkts=${markets.length} | ${title.slice(0, 80)}`);
    if (tok) {
      // try a short orderbook pull
      const end = Date.parse(asString(row?.end_date) ?? "") || Date.now();
      const start = end - 2 * 3600_000;
      try {
        const snaps = await fetchPolyOrderbooks(client, tok, start, end);
        console.log(`   → orderbook snaps=${snaps.length} token=${tok.slice(0, 20)}…`);
      } catch (e) {
        console.log(`   → orderbook ERR ${e instanceof Error ? e.message : e}`);
      }
      break; // one probe is enough
    }
  }
}

// 2) Gamma live soccer → take token → Predexon orderbooks
{
  const url =
    "https://gamma-api.polymarket.com/events?closed=false&active=true&live=true&limit=3&tag_slug=soccer";
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  const data = (await res.json()) as Array<{
    id?: string;
    title?: string;
    slug?: string;
    startTime?: string;
    markets?: Array<{ question?: string; clobTokenIds?: string; outcomes?: string }>;
  }>;
  console.log("\n## Gamma live → Predexon books");
  for (const ev of data.slice(0, 2)) {
    console.log(ev.title);
    const market = (ev.markets ?? []).find((m) => {
      const q = m.question ?? "";
      return / vs\.? /i.test(q) && !/halftime|exact score|corners|more markets/i.test(q);
    }) ?? ev.markets?.[0];
    let tokens: string[] = [];
    try {
      tokens = JSON.parse(market?.clobTokenIds ?? "[]");
    } catch {
      tokens = [];
    }
    const token = tokens[0];
    console.log("  market", market?.question?.slice(0, 80), "token", token?.slice(0, 24));
    if (!token) continue;
    const start = Date.parse(ev.startTime ?? "") || Date.now() - 3600_000;
    const end = Date.now();
    const snaps = await fetchPolyOrderbooks(client, token, start, end);
    console.log(`  → Predexon orderbook snaps=${snaps.length}`);
  }
}

// 3) Resolve Gamma slug via Predexon
{
  const url = "https://gamma-api.polymarket.com/events?closed=false&active=true&live=true&limit=1&tag_slug=soccer";
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  const data = (await res.json()) as Array<{ slug?: string; title?: string }>;
  const slug = data[0]?.slug;
  console.log("\n## Predexon by slug", slug, data[0]?.title);
  if (slug) {
    const q = new URLSearchParams({ slug, include_markets: "true", markets_per_event: "50", limit: "5" });
    // slug is array param
    const q2 = new URLSearchParams({ include_markets: "true", markets_per_event: "50", limit: "5" });
    q2.append("slug", slug);
    const body = asRecord(await predexonGet(client, `/v2/polymarket/events/keyset?${q2}`, "slug"));
    const events = Array.isArray(body?.events) ? body.events : [];
    console.log("  found", events.length, events[0] ? asString(asRecord(events[0])?.title) : null);
  }
}

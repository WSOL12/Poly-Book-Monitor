import "../src/config/env.ts";
import { parseApiKeysFromEnv, predexonGet, asRecord, asString } from "../src/predexon/client.ts";

const client = { apiKeys: parseApiKeysFromEnv(), requestDelayMs: 40 };

async function peek(label: string, path: string) {
  const body = asRecord(await predexonGet(client, path, "peek2"));
  console.log(`\n## ${label}`);
  const events = Array.isArray(body?.events) ? body.events : Array.isArray(body?.markets) ? body.markets : Array.isArray(body?.tags) ? body.tags : null;
  if (!events) {
    console.log(JSON.stringify(body, null, 2).slice(0, 800));
    return;
  }
  console.log("count", events.length);
  for (const item of events.slice(0, 12)) {
    const row = asRecord(item);
    const title = asString(row?.title) ?? asString(row?.label) ?? asString(row?.slug) ?? "";
    const slug = asString(row?.slug) ?? "";
    console.log(`${asString(row?.status) ?? "-"} | ${asString(row?.start_date) ?? asString(row?.end_date) ?? "-"} | ${title.slice(0, 100)}`);
  }
}

// Search for match-like events
await peek("search ' vs ' closed", `/v2/polymarket/events/keyset?${new URLSearchParams({ status: "closed", search: " vs ", sort: "end_date_desc", limit: "15", include_markets: "true", markets_per_event: "3" })}`);
await peek("search ' vs ' open", `/v2/polymarket/events/keyset?${new URLSearchParams({ status: "open", search: " vs ", sort: "volume_1d", limit: "15", include_markets: "true", markets_per_event: "3" })}`);
await peek("search 'Match Winner' closed", `/v2/polymarket/events/keyset?${new URLSearchParams({ status: "closed", search: "Match Winner", sort: "end_date_desc", limit: "10" })}`);


// Tags discovery
await peek("tags", `/v2/polymarket/tags?limit=50`);

// Try epl / nba / games tags
for (const tag of ["epl", "nba", "games", "games", "cbb", "nhl", "ufc", "soccer", "football"]) {
  const q = new URLSearchParams({ status: "closed", sort: "end_date_desc", limit: "5", tag, include_markets: "false" });
  await peek(`closed tag=${tag}`, `/v2/polymarket/events/keyset?${q}`);
}

// Gamma live soccer for comparison (no key needed)
{
  const url = "https://gamma-api.polymarket.com/events?closed=false&active=true&live=true&limit=10&tag_slug=soccer";
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  const data = (await res.json()) as Array<{ title?: string; startTime?: string; live?: boolean }>;
  console.log("\n## Gamma live soccer", Array.isArray(data) ? data.length : data);
  if (Array.isArray(data)) {
    for (const e of data.slice(0, 10)) {
      console.log(`${e.live ? "LIVE" : "-"} | ${e.startTime ?? "-"} | ${(e.title ?? "").slice(0, 100)}`);
    }
  }
}

import "../src/config/env.ts";
import { parseApiKeysFromEnv, predexonGet, asRecord, asString } from "../src/predexon/client.ts";

const client = { apiKeys: parseApiKeysFromEnv(), requestDelayMs: 40 };

async function peek(label: string, params: Record<string, string>, tags: string[]) {
  const q = new URLSearchParams({ limit: "10", include_markets: "true", markets_per_event: "5", ...params });
  for (const t of tags) q.append("tag", t);
  const body = asRecord(await predexonGet(client, `/v2/polymarket/events/keyset?${q}`, "peek"));
  const events = Array.isArray(body?.events) ? body.events : [];
  console.log(`\n## ${label} → ${events.length}`);
  for (const item of events.slice(0, 8)) {
    const row = asRecord(item);
    const title = asString(row?.title) ?? "";
    const hasVs = / vs\.? /i.test(title);
    console.log(
      `${hasVs ? "MATCH" : "other"} | ${asString(row?.status)} | ${asString(row?.start_date) ?? "-"} | ${title.slice(0, 90)}`,
    );
  }
}

await peek("soccer open start_date", { status: "open", sort: "start_date" }, ["soccer"]);
await peek("soccer open volume", { status: "open", sort: "volume_1d" }, ["soccer"]);
await peek("soccer closed end_date_desc", { status: "closed", sort: "end_date_desc" }, ["soccer"]);
await peek("nfl open volume", { status: "open", sort: "volume_1d" }, ["nfl"]);
await peek("mlb open volume", { status: "open", sort: "volume_1d" }, ["mlb"]);
await peek("tennis open volume", { status: "open", sort: "volume_1d" }, ["tennis"]);
await peek("weather open", { status: "open", sort: "start_date" }, ["highest-temperature"]);
await peek("category Sports open", { status: "open", sort: "volume_1d", category: "Sports" }, []);

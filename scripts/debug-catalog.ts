import "../src/config/env.ts";
import { parseApiKeysFromEnv, predexonGet, asRecord, asString } from "../src/predexon/client.ts";
import { listSportEvents, hydrateEventMarkets } from "../src/predexon/catalog.ts";
import { parseHistorySportEvents } from "../src/catalog/parsers.ts";

const client = { apiKeys: parseApiKeysFromEnv(), requestDelayMs: 50 };
const fromMs = Date.now() - 7 * 86400000;
const toMs = Date.now();

console.log("keys", client.apiKeys.length, "window", new Date(fromMs).toISOString(), "→", new Date(toMs).toISOString());

// Raw API peek for soccer open
{
  const q = new URLSearchParams({
    status: "open",
    sort: "start_date",
    limit: "5",
    include_markets: "true",
    markets_per_event: "50",
  });
  q.append("tag", "soccer");
  const body = asRecord(await predexonGet(client, `/v2/polymarket/events/keyset?${q}`, "debug"));
  const events = Array.isArray(body?.events) ? body.events : [];
  console.log("\nRAW soccer open count=", events.length);
  for (const item of events.slice(0, 3)) {
    const row = asRecord(item);
    console.log(
      JSON.stringify(
        {
          id: asString(row?.id),
          title: asString(row?.title),
          slug: asString(row?.slug),
          status: asString(row?.status),
          start_date: asString(row?.start_date),
          end_date: asString(row?.end_date),
          market_count: row?.market_count,
          nested: Array.isArray(row?.markets) ? row.markets.length : 0,
          first:
            Array.isArray(row?.markets) && row.markets[0]
              ? {
                  title: asString(asRecord(row.markets[0])?.title),
                  outcomes: asRecord(row.markets[0])?.outcomes,
                }
              : null,
        },
        null,
        2,
      ),
    );
  }
}

for (const sport of ["soccer", "tennis", "mlb", "football", "weather"] as const) {
  let events = await listSportEvents(client, { sport, status: "both", fromMs, toMs, limit: 8 });
  events = await Promise.all(
    events.map(async (ev) => {
      if ((ev.markets?.length ?? 0) === 0 && ev.slug) return hydrateEventMarkets(client, ev);
      return ev;
    }),
  );
  console.log(`\n==== ${sport} raw=${events.length}`);
  for (const ev of events.slice(0, 2)) {
    console.log({
      title: ev.title,
      slug: ev.slug,
      closed: ev.closed,
      startTime: ev.startTime,
      eventDate: ev.eventDate,
      markets: ev.markets?.length ?? 0,
      sample: ev.markets?.[0]
        ? {
            q: ev.markets[0].question?.slice(0, 100),
            outcomes: ev.markets[0].outcomes,
            tokens: String(ev.markets[0].clobTokenIds).slice(0, 80),
            closed: ev.markets[0].closed,
          }
        : null,
    });
  }
  const parsed = parseHistorySportEvents(sport, events);
  console.log(
    "parsed=",
    parsed.length,
    parsed[0]
      ? {
          title: parsed[0].title,
          markets: parsed[0].markets.length,
          tokens: parsed[0].markets.reduce((n, m) => n + m.tokens.length, 0),
        }
      : null,
  );
}

import "../src/config/env.ts";
import { parseApiKeysFromEnv } from "../src/predexon/client.ts";
import { listPredictMarkets, groupPredictEvents } from "../src/predexon/predictfun.ts";

const client = { apiKeys: parseApiKeysFromEnv(), requestDelayMs: 40 };

for (const q of ["Khachanov", "China", "Bublik", "Mayot", "Blockx"]) {
  for (const status of ["open", "closed"] as const) {
    const markets = await listPredictMarkets(client, {
      status,
      search: q,
      limit: 20,
      maxPages: 2,
    });
    const groups = groupPredictEvents(markets);
    console.log(
      `${q} ${status}: markets=${markets.length} events=${groups.length}`,
      groups.slice(0, 5).map((g) => g.title.slice(0, 50)),
    );
  }
}

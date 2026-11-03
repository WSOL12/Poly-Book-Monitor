import "../src/config/env.ts";
import { parseApiKeysFromEnv } from "../src/predexon/client.ts";
import { fetchPolyOrderbooks } from "../src/predexon/orderbooks.ts";
import Database from "better-sqlite3";

const eid = "1097396";
const db10 = new Database("data/tennis/2026-10.db", { readonly: true });
const toks = db10.prepare("SELECT id FROM tk WHERE eid = ? LIMIT 2").all(eid) as Array<{ id: string }>;
console.log("oct toks", toks.length, toks[0]?.id?.slice(0, 24));
const dl = db10.prepare("SELECT * FROM dl WHERE eid = ?").get(eid) as {
  from_ms: number;
  to_ms: number;
};
console.log("oct window", new Date(dl.from_ms).toISOString(), "→", new Date(dl.to_ms).toISOString(), "valid", dl.to_ms > dl.from_ms);
db10.close();

const db9 = new Database("data/tennis/2026-09.db", { readonly: true });
const ob = db9.prepare("SELECT MIN(ts) a, MAX(ts) b, COUNT(*) n FROM ob WHERE eid = ?").get(eid) as {
  a: number;
  b: number;
  n: number;
};
console.log("sep ob", ob.n, new Date(ob.a).toISOString(), "→", new Date(ob.b).toISOString());
db9.close();

const client = { apiKeys: parseApiKeysFromEnv(), requestDelayMs: 40 };
const tid = toks[0]?.id;
if (tid) {
  const snaps = await fetchPolyOrderbooks(
    client,
    tid,
    Date.parse("2026-09-28T00:00:00Z"),
    Date.now(),
  );
  console.log(
    "predexon",
    snaps.length,
    snaps[0] ? new Date(snaps[0].ts).toISOString() : "-",
    snaps.at(-1) ? new Date(snaps.at(-1)!.ts).toISOString() : "-",
  );
}

import Database from "better-sqlite3";
import { join } from "node:path";
import { getEvent, findPredictTwins, listEvents } from "../web/lib/db.ts";
import { parseApiKeysFromEnv } from "../src/predexon/client.ts";
import { listPredictMarkets, fetchPredictOrderbooks } from "../src/predexon/predictfun.ts";

const polyId = "944683";
const pfId = "pf:atp-faria-alcaraz-2026-09-02";

const poly = getEvent(polyId);
console.log("poly getEvent", poly?.title, "lastSnap", poly?.lastSnapshotAt, "markets", poly?.markets?.length);

const pf = getEvent(pfId);
console.log("pf getEvent", pf?.title, "lastSnap", pf?.lastSnapshotAt, "markets", pf?.markets?.length);

const db = new Database(join("data/predictfun/2026-09.db"), { readonly: true });
const ob = (db.prepare("SELECT COUNT(*) n FROM ob WHERE eid=?").get(pfId) as { n: number }).n;
const mk = db.prepare("SELECT id,q,mt FROM mk WHERE eid=?").all(pfId);
const dl = db.prepare("SELECT * FROM dl WHERE eid=?").get(pfId);
const tk = db.prepare("SELECT id,sd,lb FROM tk WHERE eid=? LIMIT 6").all(pfId);
console.log("pf local ob=", ob, "mk=", mk.length, "dl=", dl);
for (const m of mk) console.log(" ", m);
console.log("tokens", tk);
db.close();

if (poly) {
  const twins = findPredictTwins(poly.title, 3, {
    anchorMs: poly.eventDate ? Date.parse(`${poly.eventDate}T12:00:00Z`) : null,
  });
  console.log("twins", twins.map((t) => `${t.score} ${t.eventId}`));
}

// Predexon has books?
const client = { apiKeys: parseApiKeysFromEnv(), requestDelayMs: 40 };
const markets = await listPredictMarkets(client, {
  eventSlug: "atp-faria-alcaraz-2026-09-02",
  status: "closed",
  maxPages: 5,
});
console.log("predexon markets", markets.length);
for (const m of markets.slice(0, 5)) {
  console.log(" ", m.marketId, m.title, m.createdTime);
}
if (markets[0]) {
  const from = Date.parse("2026-08-28T00:00:00Z");
  const to = Date.parse("2026-09-05T00:00:00Z");
  const snaps = await fetchPredictOrderbooks(client, markets[0].marketId, from, to);
  console.log("predexon snaps market0", snaps.length, snaps[0] ? new Date(snaps[0].ts).toISOString() : "");
}

// How many PF atp/wta have 0 ob
const tennis = listEvents("tennis");
console.log("tennis listEvents count", tennis.length);
console.log(
  "faria-alcaraz in list?",
  tennis.some((e) => e.eventId === polyId),
  tennis.filter((e) => /faria/i.test(e.title)).map((e) => e.eventId + " " + e.title.slice(0, 50)),
);

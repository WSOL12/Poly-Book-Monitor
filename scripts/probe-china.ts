import "../src/config/env.ts";
import { listEvents } from "../web/lib/db";

const tennis = listEvents("tennis");
const pf = listEvents("predictfun");
const chinaPoly = tennis.filter((e) => /china/i.test(e.title));
const chinaPf = pf.filter((e) => /china open/i.test(e.title));
console.log("POLY CHINA:");
for (const e of chinaPoly) console.log(" ", e.title, e.eventId, "ended=", e.ended);
console.log("PF CHINA (first 20):");
for (const e of chinaPf.slice(0, 20)) console.log(" ", e.title, e.eventId);

// MLB overlaps
const mlb = listEvents("mlb");
const pfMlb = pf.filter((e) => /phillies|braves|cubs|padres|yankees|dodgers/i.test(e.title));
console.log("PF MLB-ish", pfMlb.map((e) => e.title));
console.log(
  "Poly MLB sample",
  mlb.filter((e) => /phillies|braves/i.test(e.title)).map((e) => e.title)
);

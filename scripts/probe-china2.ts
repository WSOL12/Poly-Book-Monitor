import "../src/config/env.ts";
import { listEvents, findPolyTwins } from "../web/lib/db";

const china = listEvents("tennis").filter((e) => /china open/i.test(e.title));
console.log("China Open poly count", china.length);
for (const e of china.slice(0, 40)) console.log(" ", e.title);

const stars = listEvents("tennis").filter((e) =>
  /bublik|mensik|djokovic|zverev.*norrie|borges.*djokovic/i.test(e.title)
);
console.log("star matches", stars.length);
for (const e of stars.slice(0, 20)) console.log(" *", e.title);

const pf = listEvents("predictfun").find((e) => /bublik.*mensik/i.test(e.title));
if (pf) {
  const twins = findPolyTwins(pf.title, 5, {
    anchorMs: Date.parse(pf.startTime || pf.eventDate || "") || null,
  });
  console.log(
    "PF",
    pf.title,
    "->",
    twins.map((x) => `${x.score.toFixed(2)} ${x.title}`)
  );
}

const mlb = listEvents("mlb").find((e) => /phillies.*braves|braves.*phillies/i.test(e.title));
if (mlb) {
  const twins = findPolyTwins
    ? null
    : null;
  const { findPredictTwins } = await import("../web/lib/db");
  const t = findPredictTwins(mlb.title, 3, {
    anchorMs: mlb.startTime ? Date.parse(mlb.startTime) : null,
  });
  console.log("MLB", mlb.title, "->", t.map((x) => `${x.score.toFixed(2)} ${x.title}`));
}

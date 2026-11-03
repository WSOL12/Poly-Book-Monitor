import {
  titleSimilarity,
  matchSides,
  normalizeMatchTitle,
} from "../web/lib/matchTitles";

const a = "China Open: Paula Badosa vs Daria Kasatkina";
const b = "US Open WTA: Daria Kasatkina vs Paula Badosa";
const ha = /^([^:]+):/.exec(a)?.[1];
const hb = /^([^:]+):/.exec(b)?.[1];
console.log({ ha, hb, score: titleSimilarity(a, b), sidesA: matchSides(a), sidesB: matchSides(b) });
console.log("norm", normalizeMatchTitle(a), "|", normalizeMatchTitle(b));

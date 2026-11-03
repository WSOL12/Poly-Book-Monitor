import { readFileSync } from "node:fs";
import { titleSimilarity } from "../web/lib/matchTitles";

const src = readFileSync(new URL("../web/lib/matchTitles.ts", import.meta.url), "utf8");
console.log("has tournamentConflict", src.includes("tournamentConflict"));
console.log("has return 0 comment", src.includes("same players, different tournament"));
console.log("score", titleSimilarity(
  "China Open: Paula Badosa vs Daria Kasatkina",
  "US Open WTA: Daria Kasatkina vs Paula Badosa"
));

// Inline reimplementation
const STOP = new Set(["open", "cup", "tour", "atp", "wta"]);
function conflict(a: string, b: string): boolean {
  const ha = /^([^:]+):/.exec(a)?.[1]?.toLowerCase().trim() ?? "";
  const hb = /^([^:]+):/.exec(b)?.[1]?.toLowerCase().trim() ?? "";
  if (!ha || !hb) return false;
  const na = ha.replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  const nb = hb.replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  if (!na || !nb || na === nb) return false;
  const ta = new Set(na.split(" ").filter((t) => t.length >= 3 && !STOP.has(t)));
  const tb = new Set(nb.split(" ").filter((t) => t.length >= 3 && !STOP.has(t)));
  console.log({ na, nb, ta: [...ta], tb: [...tb] });
  if (!ta.size || !tb.size) return false;
  let hit = 0;
  for (const t of ta) if (tb.has(t)) hit++;
  return hit === 0;
}
const a = "China Open: Paula Badosa vs Daria Kasatkina";
const b = "US Open WTA: Daria Kasatkina vs Paula Badosa";
console.log("inline conflict", conflict(a, b));

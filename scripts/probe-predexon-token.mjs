import { readFileSync } from "node:fs";
import { resolve } from "node:path";

for (const line of readFileSync(resolve("D:/Poly-Book-Monitor/.env"), "utf8").split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("=");
  if (i <= 0) continue;
  const k = t.slice(0, i).trim();
  let v = t.slice(i + 1).trim();
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    v = v.slice(1, -1);
  }
  if (process.env[k] == null) process.env[k] = v;
}

const key = process.env.PREDEXON_API_KEY;
if (!key) throw new Error("missing PREDEXON_API_KEY");

const token =
  process.argv[2] ||
  "98159878840721528307795414696569187800759660540281926020900004833282112315997";
const start = Date.parse(process.argv[3] || "2026-08-27T00:00:00Z");
const end = Date.parse(process.argv[4] || "2026-08-29T00:00:00Z");

async function page(paginationKey = null) {
  const q = new URLSearchParams({
    token_id: token,
    start_time: String(start),
    end_time: String(end),
    limit: "200",
  });
  if (paginationKey) q.set("pagination_key", paginationKey);
  const res = await fetch(`https://api.predexon.com/v2/polymarket/orderbooks?${q}`, {
    headers: { "x-api-key": key, Accept: "application/json" },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

const all = [];
let keyp = null;
let pages = 0;
for (;;) {
  const body = await page(keyp);
  pages += 1;
  all.push(...(body.snapshots || []));
  if (!body.pagination?.has_more) break;
  keyp = body.pagination.pagination_key;
  if (!keyp) break;
  if (pages > 80) break;
}

all.sort((a, b) => a.timestamp - b.timestamp);
const tip = (s) => ({
  at: new Date(s.timestamp).toISOString(),
  bb: s.bids?.[0]?.price ?? null,
  ba: s.asks?.[0]?.price ?? null,
});
console.log(
  JSON.stringify(
    {
      token: token.slice(0, 12) + "…",
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      pages,
      count: all.length,
      first: all[0] ? tip(all[0]) : null,
      last: all.length ? tip(all[all.length - 1]) : null,
      mid: all.length > 2 ? tip(all[Math.floor(all.length / 2)]) : null,
    },
    null,
    2,
  ),
);

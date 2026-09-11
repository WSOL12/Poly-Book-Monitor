const fs = require("fs");
const html = [1, 2, 3, 4, 5].map((n) => fs.readFileSync(`.tmp/ph${n}.html`, "utf8")).join("\n");

// Unescape common JSON-in-HTML fragments
const unesc = html.replace(/\\"/g, '"').replace(/\\\\n/g, "\n");

const rows = [];
const seen = new Set();
const re =
  /"name"\s*:\s*\{\s*"en"\s*:\s*"([^"]+)"\s*,\s*"default"\s*:\s*"([^"]+)"\s*\}\s*,\s*"start(?:ed)?"\s*:\s*("null"|"[^"]+")\s*,\s*"resolved"\s*:\s*("null"|"[^"]+")\s*,\s*"status"\s*:\s*"([^"]+)"\s*,\s*"impact"\s*:\s*"([^"]+)"/g;

let m;
while ((m = re.exec(unesc))) {
  const name = m[1] || m[2];
  const start = m[3] === '"null"' ? null : JSON.parse(m[3]);
  const resolved = m[4] === '"null"' ? null : JSON.parse(m[4]);
  const status = m[5];
  const impact = m[6];
  const key = `${name}|${(start || "").slice(0, 16)}`;
  if (seen.has(key)) continue;
  seen.add(key);
  rows.push({ name, start, resolved, status, impact });
}

function isPerps(n) {
  return /perp/i.test(n) && !/clob/i.test(n);
}
function isTrading(n) {
  const t = n.toLowerCase();
  if (isPerps(n)) return false;
  return (
    /clob|trading api|trading outage|trading is paused|trading paused|trading disabled|trading maintenance|trading degraded|degraded trading|order submission|issues with clob|scheduled trading/.test(
      t,
    ) || (/\btrading\b/.test(t) && !/price-history|chart|markets page|gamma|web app|rtds/.test(t))
  );
}

const trading = rows.filter((r) => isTrading(r.name));
const perps = rows.filter((r) => isPerps(r.name));
console.log("parsed notices:", rows.length, "trading:", trading.length, "perps:", perps.length);

for (const r of trading.sort((a, b) => String(a.start).localeCompare(String(b.start)))) {
  let mins = null;
  if (r.start && r.resolved) mins = Math.round((Date.parse(r.resolved) - Date.parse(r.start)) / 60000);
  console.log(
    String(r.start || "?").slice(0, 19).padEnd(20),
    String(mins != null ? `${mins}m` : r.status).padStart(12),
    r.impact.padEnd(18),
    r.name,
  );
}

const months = {};
for (const r of trading) {
  if (!r.start) continue;
  months[r.start.slice(0, 7)] = (months[r.start.slice(0, 7)] || 0) + 1;
}
console.log("\nby month:", months);
const keys = Object.keys(months).sort();
const total = Object.values(months).reduce((a, b) => a + b, 0);
if (keys.length) {
  console.log(`~${(total / keys.length).toFixed(1)} CLOB/trading blocks per month (${keys[0]} → ${keys.at(-1)})`);
}

const durs = trading
  .map((r) => (r.start && r.resolved ? (Date.parse(r.resolved) - Date.parse(r.start)) / 60000 : null))
  .filter((n) => n != null && n > 0 && n < 24 * 60);
if (durs.length) {
  durs.sort((a, b) => a - b);
  const avg = durs.reduce((a, b) => a + b, 0) / durs.length;
  console.log(
    `length: median ${durs[Math.floor(durs.length / 2)].toFixed(0)}m, avg ${avg.toFixed(0)}m, min ${durs[0].toFixed(0)}m, max ${durs.at(-1).toFixed(0)}m`,
  );
}

// CLOB uptime from page
const up = unesc.match(/Trading API \(CLOB\)[\s\S]{0,400}?([0-9.]+)% uptime/);
console.log("CLOB uptime label:", up ? up[1] + "%" : "n/a");

// Count downtime bars from aria-labels if present
const downs = [...unesc.matchAll(/aria-label="([^"]*downtime[^"]*Trading[^"]*|[^"]*downtime[^"]*CLOB[^"]*|[^"]*Monday[^"]*2026[^"]*)"/gi)].length;
const clobBars = [...unesc.matchAll(/aria-label="([^"]+)"/g)]
  .map((x) => x[1])
  .filter((s) => /downtime|Under maintenance|Major outage|Partial outage|Degraded/i.test(s));
console.log("aria downtime-ish labels:", clobBars.length);
console.log([...new Set(clobBars)].slice(0, 15).join("\n"));

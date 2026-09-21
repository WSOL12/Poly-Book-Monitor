/**
 * 30-minute WSS-only stream watch across all sports/markets.
 * Opens market sockets for every live token in the day DBs and logs gaps/errors.
 *
 *   npx tsx scripts/watch-wss-30m.ts
 */
import Database from "better-sqlite3";
import { mkdirSync, appendFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import WebSocket from "ws";

const SPORTS = ["soccer", "football", "mlb", "tennis", "weather"] as const;
const DURATION_MS = 30 * 60_000;
const EVERY_MS = 30_000;
const MAX_ASSETS = 32;
const STALE_MS = 45_000;
const URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const OUT_DIR = resolve("data/_watch");
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const OUT = resolve(OUT_DIR, `wss-30m-${STAMP}.log`);

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT, `wss watch start ${new Date().toISOString()}\n`);

function log(line: string) {
  const row = `[${new Date().toISOString()}] ${line}`;
  console.log(row);
  appendFileSync(OUT, row + "\n");
}

function latestDay(sport: string): string | null {
  try {
    const days = readdirSync(resolve("data", sport))
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.db$/.test(f))
      .sort()
      .reverse();
    return days[0]?.replace(/\.db$/, "") ?? null;
  } catch {
    return null;
  }
}

type Tok = { id: string; sport: string; eventId: string; title: string; mt: string };

function loadTokens(): Tok[] {
  const out: Tok[] = [];
  for (const sport of SPORTS) {
    const day = latestDay(sport);
    if (!day) continue;
    const db = new Database(resolve("data", sport, `${day}.db`), {
      readonly: true,
      fileMustExist: true,
    });
    try {
      const rows = db
        .prepare(
          `SELECT tk.id AS id, tk.eid AS eventId, tk.mt AS mt, ev.t AS title
           FROM tk JOIN ev ON ev.id = tk.eid
           WHERE ev.e = 0
           ORDER BY tk.mt, tk.lb`
        )
        .all() as Array<{ id: string; eventId: string; mt: string; title: string }>;
      for (const r of rows) {
        out.push({ id: r.id, sport, eventId: r.eventId, title: r.title, mt: r.mt });
      }
    } finally {
      db.close();
    }
  }
  return out;
}

type Shard = {
  index: number;
  tokens: string[];
  ws: WebSocket | null;
  lastMsgAt: number;
  messages: number;
  books: number;
  priceChanges: number;
  reconnects: number;
  errors: string[];
  open: boolean;
};

const tokens = loadTokens();
const byId = new Map(tokens.map((t) => [t.id, t]));
const lastBookAt = new Map<string, number>();
const bookCounts = new Map<string, number>();
const issues: string[] = [];

function noteIssue(msg: string) {
  issues.push(`[${new Date().toISOString()}] ${msg}`);
  log(`ISSUE ${msg}`);
}

const groups: string[][] = [];
for (let i = 0; i < tokens.length; i += MAX_ASSETS) {
  groups.push(tokens.slice(i, i + MAX_ASSETS).map((t) => t.id));
}

const shards: Shard[] = groups.map((ids, index) => ({
  index,
  tokens: ids,
  ws: null,
  lastMsgAt: 0,
  messages: 0,
  books: 0,
  priceChanges: 0,
  reconnects: 0,
  errors: [],
  open: false,
}));

log(
  `tokens=${tokens.length} events=${new Set(tokens.map((t) => t.eventId)).size} shards=${shards.length} sports=${SPORTS.map((s) => `${s}:${tokens.filter((t) => t.sport === s).length}`).join(",")}`
);

function subscribe(ids: string[]) {
  return JSON.stringify({
    assets_ids: ids,
    type: "market",
    initial_dump: true,
    level: 2,
    custom_feature_enabled: true,
  });
}

function connectShard(shard: Shard) {
  if (shard.ws) {
    try {
      shard.ws.removeAllListeners();
      shard.ws.terminate();
    } catch {
      /* ignore */
    }
  }
  const ws = new WebSocket(URL);
  shard.ws = ws;
  shard.open = false;
  const connectStarted = Date.now();
  const timeout = setTimeout(() => {
    if (ws.readyState !== WebSocket.OPEN) {
      noteIssue(`WSS#${shard.index} connect timeout after ${Date.now() - connectStarted}ms`);
      shard.reconnects++;
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
      setTimeout(() => connectShard(shard), 1000 + shard.index * 200);
    }
  }, 20_000);

  ws.on("open", () => {
    clearTimeout(timeout);
    shard.open = true;
    shard.lastMsgAt = Date.now();
    ws.send(subscribe(shard.tokens));
    log(`WSS#${shard.index} up (${shard.tokens.length} tok)`);
    const ping = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        clearInterval(ping);
        return;
      }
      try {
        ws.send("PING");
        ws.ping();
      } catch {
        /* ignore */
      }
    }, 5_000);
    (ws as WebSocket & { __ping?: ReturnType<typeof setInterval> }).__ping = ping;
  });

  ws.on("message", (raw) => {
    shard.lastMsgAt = Date.now();
    shard.messages++;
    const text = raw.toString().trim();
    if (text === "PONG" || text === "NO NEW ASSETS") return;
    try {
      const payload = JSON.parse(text) as unknown;
      const events = Array.isArray(payload) ? payload : [payload];
      for (const event of events) {
        const e = event as {
          event_type?: string;
          asset_id?: string;
          price_changes?: Array<{ asset_id?: string }>;
        };
        if (e.event_type === "book" && e.asset_id) {
          shard.books++;
          lastBookAt.set(e.asset_id, Date.now());
          bookCounts.set(e.asset_id, (bookCounts.get(e.asset_id) ?? 0) + 1);
        } else if (e.event_type === "price_change") {
          shard.priceChanges++;
          for (const c of e.price_changes ?? []) {
            if (c.asset_id) lastBookAt.set(c.asset_id, Date.now());
          }
        } else if (e.event_type === "best_bid_ask" && e.asset_id) {
          lastBookAt.set(e.asset_id, Date.now());
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      shard.errors.push(msg);
      if (shard.errors.length <= 3) noteIssue(`WSS#${shard.index} parse: ${msg}`);
    }
  });

  ws.on("error", (err) => {
    const msg = err.message;
    shard.errors.push(msg);
    noteIssue(`WSS#${shard.index} error: ${msg}`);
  });

  ws.on("close", () => {
    clearTimeout(timeout);
    const ping = (ws as WebSocket & { __ping?: ReturnType<typeof setInterval> }).__ping;
    if (ping) clearInterval(ping);
    shard.open = false;
    shard.ws = null;
    shard.reconnects++;
    noteIssue(`WSS#${shard.index} closed — reconnecting (n=${shard.reconnects})`);
    setTimeout(() => connectShard(shard), Math.min(15_000, 400 * 2 ** Math.min(shard.reconnects, 5)));
  });
}

for (let i = 0; i < shards.length; i++) {
  setTimeout(() => connectShard(shards[i]!), i * 400);
}

function dbFreshness() {
  const now = Date.now();
  const parts: string[] = [];
  for (const sport of SPORTS) {
    const day = latestDay(sport);
    if (!day) {
      parts.push(`${sport}:nodb`);
      continue;
    }
    const db = new Database(resolve("data", sport, `${day}.db`), {
      readonly: true,
      fileMustExist: true,
    });
    try {
      const live = db.prepare(`SELECT id, t FROM ev WHERE e = 0`).all() as Array<{
        id: string;
        t: string;
      }>;
      let fresh = 0;
      let stale = 0;
      let maxAge = 0;
      let worst = "";
      for (const ev of live) {
        const hi = db.prepare(`SELECT MAX(ts) hi FROM ob WHERE eid = ?`).get(ev.id) as {
          hi: number | null;
        };
        const age = hi.hi != null ? Math.round((now - hi.hi) / 1000) : 99999;
        if (age <= 30) fresh++;
        else stale++;
        if (age > maxAge) {
          maxAge = age;
          worst = ev.t.slice(0, 28);
        }
      }
      parts.push(`${sport}:${live.length} fresh=${fresh} stale=${stale} maxAge=${maxAge}s`);
      if (stale > 0 && live.length > 0 && stale === live.length && maxAge > 60) {
        noteIssue(`DB ${sport} all ${live.length} events stale maxAge=${maxAge}s worst=${worst}`);
      }
    } finally {
      db.close();
    }
  }
  return parts.join(" | ");
}

function tick() {
  const now = Date.now();
  const live = shards.filter((s) => s.open && now - s.lastMsgAt < STALE_MS).length;
  const open = shards.filter((s) => s.open).length;
  const msgs = shards.reduce((a, s) => a + s.messages, 0);
  const books = shards.reduce((a, s) => a + s.books, 0);
  const pcs = shards.reduce((a, s) => a + s.priceChanges, 0);
  const reconnects = shards.reduce((a, s) => a + s.reconnects, 0);

  let silent = 0;
  let never = 0;
  const silentSamples: string[] = [];
  for (const t of tokens) {
    const at = lastBookAt.get(t.id);
    if (at == null) {
      never++;
      if (silentSamples.length < 5) silentSamples.push(`${t.sport}/${t.title.slice(0, 24)} (${t.mt})`);
    } else if (now - at > 60_000) {
      silent++;
    }
  }

  for (const s of shards) {
    if (s.open && now - s.lastMsgAt >= STALE_MS) {
      noteIssue(`WSS#${s.index} open but silent ${Math.round((now - s.lastMsgAt) / 1000)}s`);
    }
  }

  log(
    `wss live=${live}/${shards.length} open=${open} msgs=${msgs} books=${books} pc=${pcs} reconnects=${reconnects} neverBook=${never} silent>60s=${silent}`
  );
  if (silentSamples.length) log(`neverBook sample: ${silentSamples.join(" || ")}`);
  log(`db ${dbFreshness()}`);
}

log(`logging to ${OUT}`);
const started = Date.now();
const timer = setInterval(() => {
  try {
    tick();
  } catch (err) {
    noteIssue(`tick: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (Date.now() - started >= DURATION_MS) {
    clearInterval(timer);
    tick();
    log("--- summary ---");
    log(`duration_s=${Math.round((Date.now() - started) / 1000)}`);
    log(`issues=${issues.length}`);
    for (const line of issues.slice(0, 40)) log(`  ${line}`);
    if (issues.length > 40) log(`  … +${issues.length - 40} more`);
    for (const s of shards) {
      try {
        s.ws?.terminate();
      } catch {
        /* ignore */
      }
    }
    log("watch done");
    process.exit(0);
  }
}, EVERY_MS);

setTimeout(() => {
  try {
    tick();
  } catch (err) {
    noteIssue(`tick: ${err instanceof Error ? err.message : String(err)}`);
  }
}, 8_000);

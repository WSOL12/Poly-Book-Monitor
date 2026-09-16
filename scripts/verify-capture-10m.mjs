/**
 * Post-fix verify: WSS + REST live changes vs DB for 10 minutes.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import WebSocket from "ws";

const DURATION_MS = Number(process.env.COMPARE_MS ?? 10 * 60 * 1000);
const REST_MS = Number(process.env.REST_MS ?? 400);
const MATCH_TOL_MS = Number(process.env.MATCH_TOL_MS ?? 1500);
const WSS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const CLOB = "https://clob.polymarket.com/book";
const OUT = resolve("data/verify-capture-10m.json");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function openDb() {
  const db = new Database("data/monitoring.db", { readonly: true, fileMustExist: true });
  db.pragma("busy_timeout = 5000");
  return db;
}

function loadTargets(db, maxGames = 6) {
  const rows = db
    .prepare(
      `
    SELECT t.token_id AS tokenId, t.label, e.title, e.game_status AS gameStatus, e.event_id AS eventId
    FROM tokens t
    JOIN events e ON e.event_id = t.event_id
    WHERE e.sport='mlb' AND e.ended=0 AND e.poly_live=1 AND t.market_type='moneyline'
    ORDER BY e.title, t.side
  `
    )
    .all();
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    if (seen.has(r.eventId)) continue;
    seen.add(r.eventId);
    out.push(...rows.filter((x) => x.eventId === r.eventId));
    if (seen.size >= maxGames) break;
  }
  return out;
}

function bestOf(levels, side) {
  let best = null;
  for (const L of levels ?? []) {
    const p = Number(L.price);
    const s = Number(L.size);
    if (!Number.isFinite(p) || !Number.isFinite(s) || s <= 0) continue;
    if (best == null || (side === "bid" ? p > best.price : p < best.price)) {
      best = { price: p, size: s };
    }
  }
  return best;
}

function midKey(bid, ask) {
  return `${bid?.price ?? ""}|${ask?.price ?? ""}`;
}

function topKey(bid, ask) {
  return `${bid ? `${bid.price}:${bid.size}` : "-"}|${ask ? `${ask.price}:${ask.size}` : "-"}`;
}

function parseLevels(raw) {
  const out = [];
  for (const row of raw ?? []) {
    const price = Number(row.price);
    const size = Number(row.size);
    if (!Number.isFinite(price) || !Number.isFinite(size) || size <= 0) continue;
    out.push({ price, size });
  }
  return out;
}

function applyLevelUpdate(levels, price, size) {
  const next = levels.filter((l) => l.price !== price);
  if (size > 0) next.push({ price, size });
  return next;
}

function applyPriceChange(book, change) {
  let bids = [...book.bids];
  let asks = [...book.asks];
  const price = change.price != null ? Number(change.price) : NaN;
  const size = change.size != null ? Number(change.size) : NaN;
  const side = String(change.side ?? "").toUpperCase();
  if (Number.isFinite(price) && Number.isFinite(size)) {
    if (side === "BUY" || side === "BID") bids = applyLevelUpdate(bids, price, size);
    else if (side === "SELL" || side === "ASK") asks = applyLevelUpdate(asks, price, size);
  }
  return { bids, asks };
}

async function fetchBook(tokenId) {
  const res = await fetch(`${CLOB}?token_id=${encodeURIComponent(tokenId)}`, {
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function main() {
  mkdirSync("data", { recursive: true });
  let db = openDb();
  const targets = loadTargets(db, 6);
  const tokenIds = targets.map((t) => t.tokenId);
  console.log(`[verify] ${targets.length} MLB ML tokens, ${DURATION_MS / 1000}s, rest=${REST_MS}ms`);
  for (const t of targets) console.log(`  - ${t.title} | ${t.label} (${t.gameStatus ?? "?"})`);

  const state = new Map();
  for (const t of targets) {
    state.set(t.tokenId, {
      ...t,
      wssCache: null,
      wssMid: null,
      wssTop: null,
      wssBook: 0,
      wssPriceChange: 0,
      wssBestBidAsk: 0,
      wssMidChanges: [],
      wssTopChanges: [],
      restMid: null,
      restTop: null,
      restMidChanges: [],
      restTopChanges: [],
      restPolls: 0,
      restErrors: 0,
    });
  }

  let messages = 0;
  let lastMsgAt = 0;
  const ws = new WebSocket(WSS_URL);

  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("WSS connect timeout")), 15000);
    ws.on("open", () => {
      clearTimeout(t);
      ws.send(
        JSON.stringify({
          assets_ids: tokenIds,
          type: "market",
          initial_dump: true,
          level: 2,
          custom_feature_enabled: true,
        })
      );
      console.log(`[verify] WSS connected`);
      resolve();
    });
    ws.on("error", (err) => {
      clearTimeout(t);
      reject(err);
    });
  });

  const ping = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send("PING");
        ws.ping();
      } catch {
        /* ignore */
      }
    }
  }, 10000);

  function noteChange(arr, at, bid, ask, kind) {
    arr.push({
      at,
      bestBid: bid?.price ?? null,
      bestAsk: ask?.price ?? null,
      bidSize: bid?.size ?? null,
      askSize: ask?.size ?? null,
      kind,
    });
  }

  function onWssBook(tokenId, bids, asks, at) {
    const st = state.get(tokenId);
    if (!st) return;
    const bid = bestOf(bids, "bid");
    const ask = bestOf(asks, "ask");
    const mid = midKey(bid, ask);
    const top = topKey(bid, ask);
    if (st.wssMid != null && st.wssMid !== mid) noteChange(st.wssMidChanges, at, bid, ask, "mid");
    if (st.wssTop != null && st.wssTop !== top) noteChange(st.wssTopChanges, at, bid, ask, "top");
    st.wssMid = mid;
    st.wssTop = top;
    st.wssCache = { bids, asks };
  }

  ws.on("message", (raw) => {
    lastMsgAt = Date.now();
    messages++;
    const text = raw.toString().trim();
    if (text === "PONG" || text === "NO NEW ASSETS") return;
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      return;
    }
    const events = Array.isArray(payload) ? payload : [payload];
    const at = Date.now();
    for (const event of events) {
      if (event?.event_type === "book") {
        const st = state.get(event.asset_id);
        if (!st) continue;
        st.wssBook++;
        onWssBook(event.asset_id, parseLevels(event.bids), parseLevels(event.asks), at);
      } else if (event?.event_type === "price_change") {
        for (const change of event.price_changes ?? []) {
          const st = state.get(change.asset_id);
          if (!st) continue;
          st.wssPriceChange++;
          if (!st.wssCache) continue;
          const next = applyPriceChange(st.wssCache, change);
          onWssBook(change.asset_id, next.bids, next.asks, at);
        }
      } else if (event?.event_type === "best_bid_ask") {
        const st = state.get(event.asset_id);
        if (!st?.wssCache) continue;
        st.wssBestBidAsk++;
        // Size unknown — still count mid move via best fields if present
        const bid = bestOf(st.wssCache.bids, "bid");
        const ask = bestOf(st.wssCache.asks, "ask");
        const bb = event.best_bid != null ? Number(event.best_bid) : bid?.price;
        const ba = event.best_ask != null ? Number(event.best_ask) : ask?.price;
        const synBid = bb != null && Number.isFinite(bb) ? { price: bb, size: bid?.size ?? 1 } : bid;
        const synAsk = ba != null && Number.isFinite(ba) ? { price: ba, size: ask?.size ?? 1 } : ask;
        const mid = midKey(synBid, synAsk);
        const top = topKey(synBid, synAsk);
        if (st.wssMid != null && st.wssMid !== mid) noteChange(st.wssMidChanges, at, synBid, synAsk, "mid");
        if (st.wssTop != null && st.wssTop !== top) noteChange(st.wssTopChanges, at, synBid, synAsk, "top");
        st.wssMid = mid;
        st.wssTop = top;
      }
    }
  });

  const startedAt = Date.now();
  const endAt = startedAt + DURATION_MS;
  let round = 0;

  while (Date.now() < endAt) {
    round++;
    const loopStart = Date.now();
    await Promise.all(
      tokenIds.map(async (tokenId) => {
        const st = state.get(tokenId);
        try {
          const book = await fetchBook(tokenId);
          const at = Date.now();
          st.restPolls++;
          const bid = bestOf(book.bids, "bid");
          const ask = bestOf(book.asks, "ask");
          const mid = midKey(bid, ask);
          const top = topKey(bid, ask);
          if (st.restMid != null && st.restMid !== mid) noteChange(st.restMidChanges, at, bid, ask, "mid");
          if (st.restTop != null && st.restTop !== top) noteChange(st.restTopChanges, at, bid, ask, "top");
          st.restMid = mid;
          st.restTop = top;
        } catch {
          st.restErrors++;
        }
      })
    );

    if (round % 25 === 0) {
      const wssMid = [...state.values()].reduce((a, s) => a + s.wssMidChanges.length, 0);
      const restMid = [...state.values()].reduce((a, s) => a + s.restMidChanges.length, 0);
      const stale = Date.now() - lastMsgAt > 20000;
      console.log(
        `[verify] t=${((Date.now() - startedAt) / 1000).toFixed(0)}s msgs=${messages} wssMidΔ=${wssMid} restMidΔ=${restMid}${stale ? " STALE" : ""}`
      );
    }

    const wait = Math.max(0, REST_MS - (Date.now() - loopStart));
    if (wait) await sleep(wait);
  }

  const endedAt = Date.now();
  clearInterval(ping);
  try {
    ws.terminate();
  } catch {
    /* ignore */
  }

  console.log(`[verify] polling done, matching DB...`);
  try {
    db.close();
  } catch {
    /* ignore */
  }
  db = openDb();

  const snapStmt = db.prepare(`
    SELECT captured_at AS at, best_bid AS bestBid, best_ask AS bestAsk,
           json_extract(bids_json, '$[0].price') AS topBidPrice,
           json_extract(bids_json, '$[0].size') AS topBidSize,
           json_extract(asks_json, '$[0].price') AS topAskPrice,
           json_extract(asks_json, '$[0].size') AS topAskSize
    FROM book_snapshots
    WHERE token_id = ? AND captured_at BETWEEN ? AND ?
    ORDER BY captured_at
  `);

  function matchMid(snaps, change) {
    const lo = change.at - 250;
    const hi = change.at + MATCH_TOL_MS;
    for (const s of snaps) {
      if (s.at < lo || s.at > hi) continue;
      if (Number(s.bestBid) === change.bestBid && Number(s.bestAsk) === change.bestAsk) return "exact";
    }
    for (const s of snaps) {
      if (s.at >= lo && s.at <= hi) return "near";
    }
    return "miss";
  }

  function matchTop(snaps, change) {
    const lo = change.at - 250;
    const hi = change.at + MATCH_TOL_MS;
    for (const s of snaps) {
      if (s.at < lo || s.at > hi) continue;
      if (Number(s.bestBid) === change.bestBid && Number(s.bestAsk) === change.bestAsk) {
        const sizeOk =
          (s.topBidSize == null || Number(s.topBidSize) === change.bidSize) &&
          (s.topAskSize == null || Number(s.topAskSize) === change.askSize);
        return sizeOk ? "exact" : "partial";
      }
    }
    for (const s of snaps) {
      if (s.at >= lo && s.at <= hi) return "near";
    }
    return "miss";
  }

  function score(changes, snaps, kind) {
    let exact = 0;
    let partial = 0;
    let near = 0;
    let miss = 0;
    for (const c of changes) {
      const m = kind === "mid" ? matchMid(snaps, c) : matchTop(snaps, c);
      if (m === "exact") exact++;
      else if (m === "partial") partial++;
      else if (m === "near") near++;
      else miss++;
    }
    const n = changes.length;
    return {
      n,
      exact,
      partial,
      near,
      miss,
      exactPct: n ? Math.round((1000 * exact) / n) / 10 : null,
      hitPct: n ? Math.round((1000 * (exact + partial + near)) / n) / 10 : null,
    };
  }

  const perToken = [];
  const totals = {
    wssMid: { n: 0, exact: 0, near: 0, miss: 0 },
    wssTop: { n: 0, exact: 0, partial: 0, near: 0, miss: 0 },
    restMid: { n: 0, exact: 0, near: 0, miss: 0 },
    restTop: { n: 0, exact: 0, partial: 0, near: 0, miss: 0 },
    dbSnapshots: 0,
    wssBook: 0,
    wssPriceChange: 0,
    wssBestBidAsk: 0,
  };

  for (const st of state.values()) {
    const snaps = snapStmt.all(st.tokenId, startedAt - 1000, endedAt + 1000);
    const wssMid = score(st.wssMidChanges, snaps, "mid");
    const wssTop = score(st.wssTopChanges, snaps, "top");
    const restMid = score(st.restMidChanges, snaps, "mid");
    const restTop = score(st.restTopChanges, snaps, "top");

    totals.dbSnapshots += snaps.length;
    totals.wssBook += st.wssBook;
    totals.wssPriceChange += st.wssPriceChange;
    totals.wssBestBidAsk += st.wssBestBidAsk;
    for (const [k, s] of [
      ["wssMid", wssMid],
      ["wssTop", wssTop],
      ["restMid", restMid],
      ["restTop", restTop],
    ]) {
      totals[k].n += s.n;
      totals[k].exact += s.exact;
      totals[k].near += s.near;
      totals[k].miss += s.miss;
      if (s.partial != null) totals[k].partial = (totals[k].partial ?? 0) + s.partial;
    }

    const gaps = [];
    for (let i = 1; i < snaps.length; i++) gaps.push(snaps[i].at - snaps[i - 1].at);
    const avgGap = gaps.length ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length) : null;

    perToken.push({
      title: st.title,
      label: st.label,
      gameStatus: st.gameStatus,
      wssEvents: { book: st.wssBook, priceChange: st.wssPriceChange, bestBidAsk: st.wssBestBidAsk },
      rest: { polls: st.restPolls, errors: st.restErrors },
      db: { snapshots: snaps.length, avgGapMs: avgGap },
      capture: { wssMid, wssTop, restMid, restTop },
    });
  }

  function pct(exact, n) {
    return n ? Math.round((1000 * exact) / n) / 10 : null;
  }
  function hit(obj) {
    const hitN = obj.exact + (obj.partial ?? 0) + obj.near;
    return obj.n ? Math.round((1000 * hitN) / obj.n) / 10 : null;
  }

  const summary = {
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
    durationSec: Math.round((endedAt - startedAt) / 1000),
    messages,
    matchTolMs: MATCH_TOL_MS,
    totals: {
      ...totals,
      wssMidExactPct: pct(totals.wssMid.exact, totals.wssMid.n),
      wssMidHitPct: hit(totals.wssMid),
      wssTopExactPct: pct(totals.wssTop.exact + (totals.wssTop.partial ?? 0), totals.wssTop.n),
      wssTopHitPct: hit(totals.wssTop),
      restMidExactPct: pct(totals.restMid.exact, totals.restMid.n),
      restMidHitPct: hit(totals.restMid),
      restTopExactPct: pct(totals.restTop.exact + (totals.restTop.partial ?? 0), totals.restTop.n),
      restTopHitPct: hit(totals.restTop),
    },
    perToken: perToken.sort(
      (a, b) => (a.capture.wssMid.exactPct ?? 999) - (b.capture.wssMid.exactPct ?? 999)
    ),
  };

  writeFileSync(OUT, JSON.stringify(summary, null, 2));
  console.log("\n=== VERIFY 10m SUMMARY ===");
  console.log(
    JSON.stringify(
      {
        durationSec: summary.durationSec,
        messages: summary.messages,
        dbSnapshots: totals.dbSnapshots,
        wssMid: {
          n: totals.wssMid.n,
          exactPct: summary.totals.wssMidExactPct,
          hitPct: summary.totals.wssMidHitPct,
          miss: totals.wssMid.miss,
        },
        wssTop: {
          n: totals.wssTop.n,
          exactPct: summary.totals.wssTopExactPct,
          hitPct: summary.totals.wssTopHitPct,
          miss: totals.wssTop.miss,
        },
        restMid: {
          n: totals.restMid.n,
          exactPct: summary.totals.restMidExactPct,
          hitPct: summary.totals.restMidHitPct,
          miss: totals.restMid.miss,
        },
        restTop: {
          n: totals.restTop.n,
          exactPct: summary.totals.restTopExactPct,
          hitPct: summary.totals.restTopHitPct,
          miss: totals.restTop.miss,
        },
      },
      null,
      2
    )
  );
  console.log("\nPer-token wssMid hit:");
  for (const row of summary.perToken) {
    console.log(
      `  ${row.title} / ${row.label}: wssMid ${row.capture.wssMid.exactPct}% exact / ${row.capture.wssMid.hitPct}% hit (n=${row.capture.wssMid.n} miss=${row.capture.wssMid.miss}) | restMid ${row.capture.restMid.hitPct}% hit | db=${row.db.snapshots} avgGap=${row.db.avgGapMs}ms`
    );
  }
  console.log(`\nWrote ${OUT}`);
  db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

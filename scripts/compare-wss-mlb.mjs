/**
 * WSS vs REST vs DB for live MLB moneylines.
 * Answers: does Polymarket WSS deliver changes, and does our handler use them?
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import WebSocket from "ws";

const DURATION_MS = Number(process.env.COMPARE_MS ?? 5 * 60 * 1000);
const REST_MS = Number(process.env.REST_MS ?? 500);
const WSS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const CLOB = "https://clob.polymarket.com/book";
const OUT = resolve("data/compare-wss-mlb.json");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function openDb() {
  const db = new Database("data/monitoring.db", { readonly: true, fileMustExist: true });
  db.pragma("busy_timeout = 5000");
  return db;
}

function loadTargets(db, limit = 8) {
  // Prefer mid-range live moneylines + one near-settled if present
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
  if (rows.length <= limit) return rows;
  // Take first side of up to limit/2 games
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    if (seen.has(r.eventId)) continue;
    seen.add(r.eventId);
    const pair = rows.filter((x) => x.eventId === r.eventId);
    out.push(...pair);
    if (out.length >= limit) break;
  }
  return out.slice(0, limit);
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
  return `${bid ?? ""}|${ask ?? ""}`;
}

function topKey(bid, ask) {
  return `${bid ? `${bid.price}:${bid.size}` : "-"}|${ask ? `${ask.price}:${ask.size}` : "-"}`;
}

async function fetchBook(tokenId) {
  const res = await fetch(`${CLOB}?token_id=${encodeURIComponent(tokenId)}`, {
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
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

async function main() {
  mkdirSync("data", { recursive: true });
  let db = openDb();
  const targets = loadTargets(db, 8);
  const tokenIds = targets.map((t) => t.tokenId);
  console.log(`[wss-compare] ${targets.length} tokens, duration=${DURATION_MS / 1000}s`);
  for (const t of targets) console.log(`  - ${t.title} | ${t.label} (${t.gameStatus ?? "?"})`);

  /** @type {Map<string, any>} */
  const state = new Map();
  for (const t of targets) {
    state.set(t.tokenId, {
      ...t,
      // WSS raw event counts
      wssBook: 0,
      wssPriceChange: 0,
      wssBestBidAsk: 0,
      wssOther: 0,
      // Book we maintain the SAME broken way as monitor (ignore price_change payload)
      brokenCache: null,
      brokenMid: null,
      brokenMidChanges: 0,
      // Book we maintain correctly (apply price_change / best_bid_ask)
      goodCache: null,
      goodMid: null,
      goodTop: null,
      goodMidChanges: 0,
      goodTopChanges: 0,
      // REST
      restMid: null,
      restTop: null,
      restMidChanges: 0,
      restTopChanges: 0,
      restPolls: 0,
      restErrors: 0,
      // WSS mid vs REST mid mismatches (sampled)
      wssLagSamples: 0,
      wssBehindRest: 0,
      // price_change payload richness
      priceChangeWithBest: 0,
      priceChangeWithSize: 0,
      samplePriceChange: null,
    });
  }

  let messages = 0;
  let connected = false;
  let lastMsgAt = 0;

  const ws = new WebSocket(WSS_URL);

  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("WSS connect timeout")), 15000);
    ws.on("open", () => {
      clearTimeout(t);
      connected = true;
      ws.send(
        JSON.stringify({
          assets_ids: tokenIds,
          type: "market",
          initial_dump: true,
          level: 2,
          custom_feature_enabled: true,
        })
      );
      console.log(`[wss-compare] connected, subscribed ${tokenIds.length}`);
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
    for (const event of events) {
      applyWss(event);
    }
  });

  function applyWss(event) {
    const type = event?.event_type;
    if (type === "book") {
      const id = event.asset_id;
      const st = state.get(id);
      if (!st) return;
      st.wssBook++;
      const bids = parseLevels(event.bids);
      const asks = parseLevels(event.asks);
      const bid = bestOf(bids, "bid");
      const ask = bestOf(asks, "ask");
      const mid = midKey(bid?.price, ask?.price);
      const top = topKey(bid, ask);

      st.brokenCache = { bids, asks };
      st.goodCache = { bids, asks };

      if (st.brokenMid != null && st.brokenMid !== mid) st.brokenMidChanges++;
      if (st.goodMid != null && st.goodMid !== mid) st.goodMidChanges++;
      if (st.goodTop != null && st.goodTop !== top) st.goodTopChanges++;
      st.brokenMid = mid;
      st.goodMid = mid;
      st.goodTop = top;
      return;
    }

    if (type === "price_change") {
      for (const change of event.price_changes ?? []) {
        const st = state.get(change.asset_id);
        if (!st) continue;
        st.wssPriceChange++;
        if (!st.samplePriceChange) st.samplePriceChange = change;
        if (change.best_bid != null || change.best_ask != null) st.priceChangeWithBest++;
        if (change.size != null || change.price != null) st.priceChangeWithSize++;

        // BROKEN path (current monitor): ignore payload, maybe "touch" old cache
        if (st.brokenCache) {
          // mid unchanged because cache not patched — do not count as change
        }

        // GOOD path: patch best from payload when present
        if (!st.goodCache) continue;
        const bids = [...st.goodCache.bids];
        const asks = [...st.goodCache.asks];
        // If payload has best_bid/best_ask, reflect in synthetic top
        const bb = change.best_bid != null ? Number(change.best_bid) : null;
        const ba = change.best_ask != null ? Number(change.best_ask) : null;
        if (bb != null && Number.isFinite(bb)) {
          // replace/update top bid price marker via synthetic level if empty
          const existing = bestOf(bids, "bid");
          if (!existing || existing.price !== bb) {
            bids.push({ price: bb, size: Number(change.size) || existing?.size || 1 });
          } else if (change.size != null && Number.isFinite(Number(change.size))) {
            // size update at best — approximate
            const idx = bids.findIndex((l) => l.price === bb);
            if (idx >= 0) bids[idx] = { price: bb, size: Number(change.size) };
          }
        }
        if (ba != null && Number.isFinite(ba)) {
          const existing = bestOf(asks, "ask");
          if (!existing || existing.price !== ba) {
            asks.push({ price: ba, size: Number(change.size) || existing?.size || 1 });
          }
        }
        // Also apply price/size level updates if present
        if (change.price != null && change.size != null && change.side) {
          const price = Number(change.price);
          const size = Number(change.size);
          const side = String(change.side).toUpperCase();
          const arr = side === "BUY" || side === "BID" ? bids : asks;
          const idx = arr.findIndex((l) => l.price === price);
          if (size <= 0) {
            if (idx >= 0) arr.splice(idx, 1);
          } else if (idx >= 0) {
            arr[idx] = { price, size };
          } else {
            arr.push({ price, size });
          }
        }

        st.goodCache = { bids, asks };
        const bid = bestOf(bids, "bid");
        const ask = bestOf(asks, "ask");
        const mid = midKey(bid?.price, ask?.price);
        const top = topKey(bid, ask);
        if (st.goodMid != null && st.goodMid !== mid) st.goodMidChanges++;
        if (st.goodTop != null && st.goodTop !== top) st.goodTopChanges++;
        st.goodMid = mid;
        st.goodTop = top;
      }
      return;
    }

    if (type === "best_bid_ask") {
      const st = state.get(event.asset_id);
      if (!st) return;
      st.wssBestBidAsk++;
      if (!st.goodCache) return;
      const bb = event.best_bid != null ? Number(event.best_bid) : null;
      const ba = event.best_ask != null ? Number(event.best_ask) : null;
      const bids = [...st.goodCache.bids];
      const asks = [...st.goodCache.asks];
      if (bb != null && Number.isFinite(bb)) {
        const existing = bestOf(bids, "bid");
        if (!existing || existing.price !== bb) {
          bids.push({ price: bb, size: existing?.size || 1 });
        }
      }
      if (ba != null && Number.isFinite(ba)) {
        const existing = bestOf(asks, "ask");
        if (!existing || existing.price !== ba) {
          asks.push({ price: ba, size: existing?.size || 1 });
        }
      }
      st.goodCache = { bids, asks };
      const bid = bestOf(bids, "bid");
      const ask = bestOf(asks, "ask");
      const mid = midKey(bid?.price, ask?.price);
      const top = topKey(bid, ask);
      if (st.goodMid != null && st.goodMid !== mid) st.goodMidChanges++;
      if (st.goodTop != null && st.goodTop !== top) st.goodTopChanges++;
      st.goodMid = mid;
      st.goodTop = top;
      return;
    }

    // count unknowns on first token for visibility
    const first = state.values().next().value;
    if (first) first.wssOther++;
  }

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
          st.restPolls++;
          const bid = bestOf(book.bids, "bid");
          const ask = bestOf(book.asks, "ask");
          const mid = midKey(bid?.price, ask?.price);
          const top = topKey(bid, ask);
          if (st.restMid != null && st.restMid !== mid) st.restMidChanges++;
          if (st.restTop != null && st.restTop !== top) st.restTopChanges++;
          st.restMid = mid;
          st.restTop = top;

          // Compare good WSS mid vs REST
          if (st.goodMid != null && st.restMid != null) {
            st.wssLagSamples++;
            if (st.goodMid !== st.restMid) st.wssBehindRest++;
          }
        } catch {
          st.restErrors++;
        }
      })
    );

    if (round % 20 === 0) {
      const books = [...state.values()].reduce((a, s) => a + s.wssBook, 0);
      const pcs = [...state.values()].reduce((a, s) => a + s.wssPriceChange, 0);
      const bba = [...state.values()].reduce((a, s) => a + s.wssBestBidAsk, 0);
      const restMid = [...state.values()].reduce((a, s) => a + s.restMidChanges, 0);
      const goodMid = [...state.values()].reduce((a, s) => a + s.goodMidChanges, 0);
      const brokenMid = [...state.values()].reduce((a, s) => a + s.brokenMidChanges, 0);
      const stale = connected && Date.now() - lastMsgAt > 20000;
      console.log(
        `[wss-compare] t=${((Date.now() - startedAt) / 1000).toFixed(0)}s msgs=${messages} book=${books} price_change=${pcs} bba=${bba} restMidΔ=${restMid} goodWssMidΔ=${goodMid} brokenWssMidΔ=${brokenMid}${stale ? " STALE" : ""}`
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

  // DB snaps in window
  try {
    db.close();
  } catch {
    /* ignore */
  }
  db = openDb();
  const snapCount = db.prepare(
    `SELECT COUNT(*) AS n FROM book_snapshots WHERE token_id = ? AND captured_at BETWEEN ? AND ?`
  );

  const perToken = [];
  let sum = {
    wssBook: 0,
    wssPriceChange: 0,
    wssBestBidAsk: 0,
    restMidChanges: 0,
    restTopChanges: 0,
    goodMidChanges: 0,
    goodTopChanges: 0,
    brokenMidChanges: 0,
    dbSnapshots: 0,
    wssLagSamples: 0,
    wssBehindRest: 0,
  };

  for (const st of state.values()) {
    const dbSnapshots = snapCount.get(st.tokenId, startedAt, endedAt)?.n ?? 0;
    sum.wssBook += st.wssBook;
    sum.wssPriceChange += st.wssPriceChange;
    sum.wssBestBidAsk += st.wssBestBidAsk;
    sum.restMidChanges += st.restMidChanges;
    sum.restTopChanges += st.restTopChanges;
    sum.goodMidChanges += st.goodMidChanges;
    sum.goodTopChanges += st.goodTopChanges;
    sum.brokenMidChanges += st.brokenMidChanges;
    sum.dbSnapshots += dbSnapshots;
    sum.wssLagSamples += st.wssLagSamples;
    sum.wssBehindRest += st.wssBehindRest;

    perToken.push({
      title: st.title,
      label: st.label,
      gameStatus: st.gameStatus,
      wss: {
        book: st.wssBook,
        priceChange: st.wssPriceChange,
        bestBidAsk: st.wssBestBidAsk,
        goodMidChanges: st.goodMidChanges,
        goodTopChanges: st.goodTopChanges,
        brokenMidChanges: st.brokenMidChanges,
        priceChangeWithBest: st.priceChangeWithBest,
        samplePriceChange: st.samplePriceChange,
      },
      rest: {
        polls: st.restPolls,
        errors: st.restErrors,
        midChanges: st.restMidChanges,
        topChanges: st.restTopChanges,
      },
      wssVsRest: {
        samples: st.wssLagSamples,
        midMismatch: st.wssBehindRest,
        mismatchPct: st.wssLagSamples
          ? Math.round((1000 * st.wssBehindRest) / st.wssLagSamples) / 10
          : null,
      },
      dbSnapshots,
    });
  }

  const summary = {
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
    durationSec: Math.round((endedAt - startedAt) / 1000),
    messages,
    totals: {
      ...sum,
      wssMidMismatchPct: sum.wssLagSamples
        ? Math.round((1000 * sum.wssBehindRest) / sum.wssLagSamples) / 10
        : null,
      // If broken path sees ~0 mid changes but good/REST see many → handler bug
      brokenVsGoodMidRatio:
        sum.goodMidChanges > 0
          ? Math.round((1000 * sum.brokenMidChanges) / sum.goodMidChanges) / 10
          : null,
      priceChangeShareOfWss:
        sum.wssBook + sum.wssPriceChange + sum.wssBestBidAsk > 0
          ? Math.round(
              (1000 * sum.wssPriceChange) /
                (sum.wssBook + sum.wssPriceChange + sum.wssBestBidAsk)
            ) / 10
          : null,
    },
    perToken,
  };

  writeFileSync(OUT, JSON.stringify(summary, null, 2));
  console.log("\n=== WSS COMPARE SUMMARY ===");
  console.log(JSON.stringify(summary.totals, null, 2));
  console.log(`\nWrote ${OUT}`);
  db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

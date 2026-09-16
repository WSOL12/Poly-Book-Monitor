/**
 * Independent live MLB orderbook poller vs recorded DB snapshots.
 * Polls CLOB REST for moneyline tokens; counts top-of-book changes
 * and checks whether the monitor DB captured each change.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import Database from "better-sqlite3";

const DURATION_MS = Number(process.env.COMPARE_MS ?? 10 * 60 * 1000);
const POLL_MS = Number(process.env.POLL_MS ?? 250);
const MATCH_TOL_MS = Number(process.env.MATCH_TOL_MS ?? 1500);
const CLOB = "https://clob.polymarket.com/book";
const OUT = resolve("data/compare-live-mlb.json");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function bestOf(levels, side) {
  let best = null;
  for (const L of levels) {
    const p = Number(L.price);
    const s = Number(L.size);
    if (!Number.isFinite(p) || !Number.isFinite(s) || s <= 0) continue;
    if (best == null || (side === "bid" ? p > best.price : p < best.price)) {
      best = { price: p, size: s };
    }
  }
  return best;
}

function topSig(book) {
  const bid = bestOf(book.bids ?? [], "bid");
  const ask = bestOf(book.asks ?? [], "ask");
  return [
    bid ? `${bid.price}:${bid.size}` : "-",
    ask ? `${ask.price}:${ask.size}` : "-",
    (book.bids ?? []).length,
    (book.asks ?? []).length,
  ].join("|");
}

function midSig(book) {
  const bid = bestOf(book.bids ?? [], "bid");
  const ask = bestOf(book.asks ?? [], "ask");
  return `${bid?.price ?? ""}|${ask?.price ?? ""}`;
}

function depthSig(book, depth = 5) {
  const take = (arr, side) => {
    const parsed = [];
    for (const L of arr ?? []) {
      const p = Number(L.price);
      const s = Number(L.size);
      if (!Number.isFinite(p) || !Number.isFinite(s) || s <= 0) continue;
      parsed.push({ price: p, size: s });
    }
    parsed.sort((a, b) => (side === "bid" ? b.price - a.price : a.price - b.price));
    return parsed
      .slice(0, depth)
      .map((x) => `${x.price}:${x.size}`)
      .join(",");
  };
  return `B[${take(book.bids, "bid")}]A[${take(book.asks, "ask")}]`;
}

async function fetchBook(tokenId) {
  const res = await fetch(`${CLOB}?token_id=${encodeURIComponent(tokenId)}`, {
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function loadTargets(db) {
  return db
    .prepare(
      `
    SELECT t.token_id AS tokenId, t.label, t.side, e.event_id AS eventId, e.title, e.game_status AS gameStatus
    FROM tokens t
    JOIN events e ON e.event_id = t.event_id
    WHERE e.sport='mlb' AND e.ended=0 AND e.poly_live=1 AND t.market_type='moneyline'
    ORDER BY e.title, t.side
  `
    )
    .all();
}

function openDb() {
  const db = new Database("data/monitoring.db", { readonly: true, fileMustExist: true });
  db.pragma("busy_timeout = 5000");
  return db;
}

async function main() {
  mkdirSync("data", { recursive: true });
  let db = openDb();
  const targets = loadTargets(db);
  console.log(
    `[compare] ${targets.length} MLB moneyline tokens, poll=${POLL_MS}ms, duration=${DURATION_MS / 1000}s`
  );
  for (const t of targets) {
    console.log(`  - ${t.title} | ${t.label} (${t.gameStatus ?? "?"})`);
  }

  const state = new Map();
  for (const t of targets) {
    state.set(t.tokenId, {
      ...t,
      lastTop: null,
      lastMid: null,
      lastDepth: null,
      polls: 0,
      topChanges: 0,
      midChanges: 0,
      depthChanges: 0,
      liveChanges: [],
      errors: 0,
    });
  }

  const startedAt = Date.now();
  const endAt = startedAt + DURATION_MS;
  let round = 0;

  while (Date.now() < endAt) {
    round++;
    const loopStart = Date.now();
    const ids = targets.map((t) => t.tokenId);
    for (let i = 0; i < ids.length; i += 4) {
      const batch = ids.slice(i, i + 4);
      await Promise.all(
        batch.map(async (tokenId) => {
          const st = state.get(tokenId);
          try {
            const book = await fetchBook(tokenId);
            const at = Date.now();
            const top = topSig(book);
            const mid = midSig(book);
            const depth = depthSig(book, 5);
            const bid = bestOf(book.bids ?? [], "bid");
            const ask = bestOf(book.asks ?? [], "ask");
            st.polls++;
            const topChanged = st.lastTop != null && st.lastTop !== top;
            const midChanged = st.lastMid != null && st.lastMid !== mid;
            const depthChanged = st.lastDepth != null && st.lastDepth !== depth;
            if (topChanged) st.topChanges++;
            if (midChanged) st.midChanges++;
            if (depthChanged) st.depthChanges++;
            if (topChanged || midChanged || depthChanged) {
              st.liveChanges.push({
                at,
                topChanged,
                midChanged,
                depthChanged,
                top,
                mid,
                depth,
                bestBid: bid?.price ?? null,
                bestAsk: ask?.price ?? null,
                bidSize: bid?.size ?? null,
                askSize: ask?.size ?? null,
              });
            }
            st.lastTop = top;
            st.lastMid = mid;
            st.lastDepth = depth;
          } catch {
            st.errors++;
          }
        })
      );
    }

    const elapsed = Date.now() - startedAt;
    if (round % 20 === 0 || elapsed > DURATION_MS - 1000) {
      const topSum = [...state.values()].reduce((a, s) => a + s.topChanges, 0);
      const midSum = [...state.values()].reduce((a, s) => a + s.midChanges, 0);
      console.log(
        `[compare] t=${(elapsed / 1000).toFixed(0)}s rounds=${round} topChanges=${topSum} midChanges=${midSum}`
      );
    }

    const spent = Date.now() - loopStart;
    const wait = Math.max(0, POLL_MS - spent);
    if (wait) await sleep(wait);
  }

  const endedAt = Date.now();
  console.log(`[compare] polling done, matching against DB...`);

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

  const perToken = [];
  let totalLiveTop = 0;
  let totalMatchedTop = 0;
  let totalLiveMid = 0;
  let totalMatchedMid = 0;
  let totalDbSnaps = 0;
  let totalLiveDepth = 0;
  let totalMatchedDepth = 0;

  for (const st of state.values()) {
    const snaps = snapStmt.all(st.tokenId, startedAt - 1000, endedAt + 1000);
    totalDbSnaps += snaps.length;

    const matchChange = (change, kind) => {
      const lo = change.at - 250;
      const hi = change.at + MATCH_TOL_MS;
      for (const s of snaps) {
        if (s.at < lo || s.at > hi) continue;
        if (kind === "mid") {
          if (Number(s.bestBid) === change.bestBid && Number(s.bestAsk) === change.bestAsk) {
            return true;
          }
        } else if (kind === "top") {
          if (Number(s.bestBid) === change.bestBid && Number(s.bestAsk) === change.bestAsk) {
            if (
              (s.topBidSize == null || Number(s.topBidSize) === change.bidSize) &&
              (s.topAskSize == null || Number(s.topAskSize) === change.askSize)
            ) {
              return true;
            }
            return "partial";
          }
        } else if (kind === "depth") {
          if (Number(s.bestBid) === change.bestBid && Number(s.bestAsk) === change.bestAsk) {
            return true;
          }
        }
      }
      for (const s of snaps) {
        if (s.at >= lo && s.at <= hi) return "near";
      }
      return false;
    };

    let midMatched = 0;
    let midNear = 0;
    let midMiss = 0;
    let topMatched = 0;
    let topPartial = 0;
    let topNear = 0;
    let topMiss = 0;
    let depthMatched = 0;
    let depthNear = 0;
    let depthMiss = 0;

    const midChanges = st.liveChanges.filter((c) => c.midChanged);
    const topChanges = st.liveChanges.filter((c) => c.topChanged);
    const depthChanges = st.liveChanges.filter((c) => c.depthChanged);

    for (const c of midChanges) {
      const m = matchChange(c, "mid");
      if (m === true) midMatched++;
      else if (m === "near") midNear++;
      else midMiss++;
    }
    for (const c of topChanges) {
      const m = matchChange(c, "top");
      if (m === true) topMatched++;
      else if (m === "partial") topPartial++;
      else if (m === "near") topNear++;
      else topMiss++;
    }
    for (const c of depthChanges) {
      const m = matchChange(c, "depth");
      if (m === true) depthMatched++;
      else if (m === "near") depthNear++;
      else depthMiss++;
    }

    const gaps = [];
    for (let i = 1; i < snaps.length; i++) gaps.push(snaps[i].at - snaps[i - 1].at);
    gaps.sort((a, b) => a - b);
    const pct = (p) =>
      gaps.length ? gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * p))] : null;

    const midIntervals = [];
    for (let i = 1; i < midChanges.length; i++) {
      midIntervals.push(midChanges[i].at - midChanges[i - 1].at);
    }

    totalLiveTop += topChanges.length;
    totalMatchedTop += topMatched + topPartial;
    totalLiveMid += midChanges.length;
    totalMatchedMid += midMatched;
    totalLiveDepth += depthChanges.length;
    totalMatchedDepth += depthMatched;

    perToken.push({
      title: st.title,
      label: st.label,
      gameStatus: st.gameStatus,
      polls: st.polls,
      errors: st.errors,
      live: {
        midChanges: midChanges.length,
        topChanges: topChanges.length,
        depthChanges: depthChanges.length,
        avgMidIntervalMs: midIntervals.length
          ? Math.round(midIntervals.reduce((a, b) => a + b, 0) / midIntervals.length)
          : null,
      },
      db: {
        snapshots: snaps.length,
        avgGapMs: gaps.length ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length) : null,
        p50GapMs: pct(0.5),
        p95GapMs: pct(0.95),
        maxGapMs: gaps.length ? gaps[gaps.length - 1] : null,
      },
      match: {
        midMatched,
        midNear,
        midMiss,
        midCapturePct: midChanges.length
          ? Math.round((1000 * midMatched) / midChanges.length) / 10
          : null,
        topMatched,
        topPartial,
        topNear,
        topMiss,
        topCapturePct: topChanges.length
          ? Math.round((1000 * (topMatched + topPartial)) / topChanges.length) / 10
          : null,
        depthMatched,
        depthNear,
        depthMiss,
        depthCapturePct: depthChanges.length
          ? Math.round((1000 * depthMatched) / depthChanges.length) / 10
          : null,
      },
      sampleMissedMids: midChanges
        .filter((c) => matchChange(c, "mid") === false)
        .slice(0, 5)
        .map((c) => ({
          at: new Date(c.at).toISOString(),
          bestBid: c.bestBid,
          bestAsk: c.bestAsk,
        })),
    });
  }

  const summary = {
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
    durationSec: Math.round((endedAt - startedAt) / 1000),
    pollMs: POLL_MS,
    matchTolMs: MATCH_TOL_MS,
    tokens: targets.length,
    totals: {
      liveMidChanges: totalLiveMid,
      dbMatchedMid: totalMatchedMid,
      midCapturePct: totalLiveMid
        ? Math.round((1000 * totalMatchedMid) / totalLiveMid) / 10
        : null,
      liveTopChanges: totalLiveTop,
      dbMatchedTop: totalMatchedTop,
      topCapturePct: totalLiveTop
        ? Math.round((1000 * totalMatchedTop) / totalLiveTop) / 10
        : null,
      liveDepthChanges: totalLiveDepth,
      dbMatchedDepth: totalMatchedDepth,
      depthCapturePct: totalLiveDepth
        ? Math.round((1000 * totalMatchedDepth) / totalLiveDepth) / 10
        : null,
      dbSnapshotsInWindow: totalDbSnaps,
    },
    perToken: perToken.sort(
      (a, b) => (a.match.midCapturePct ?? 999) - (b.match.midCapturePct ?? 999)
    ),
  };

  writeFileSync(OUT, JSON.stringify(summary, null, 2));
  console.log("\n=== SUMMARY ===");
  console.log(JSON.stringify(summary.totals, null, 2));
  console.log("\nWorst mid-capture tokens:");
  for (const row of summary.perToken.slice(0, 8)) {
    console.log(
      `  ${row.title} / ${row.label}: liveMid=${row.live.midChanges} matched=${row.match.midMatched} miss=${row.match.midMiss} capture=${row.match.midCapturePct}% dbSnaps=${row.db.snapshots} avgDbGap=${row.db.avgGapMs}ms liveMidInterval=${row.live.avgMidIntervalMs}ms`
    );
  }
  console.log(`\nWrote ${OUT}`);
  db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

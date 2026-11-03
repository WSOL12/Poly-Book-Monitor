/**
 * Backfill PF football fixtures with moneyline + prop markets (exact score,
 * spreads/O-U/BTTS, corners) and orderbooks.
 *
 *   npx tsx scripts/backfill-pf-football-books.ts --only epl-bri-ars-2026-09-19
 *   npx tsx scripts/backfill-pf-football-books.ts --only epl-mac-sun-2026-09-20
 *   npx tsx scripts/backfill-pf-football-books.ts --limit 20 --force-props
 */
import "../src/config/env.ts";
import { ensureDataDirs } from "../src/config/env.ts";
import {
  bestOf,
  depthSum,
  MonitorHub,
  normalizeBookSide,
} from "../src/db/store.ts";
import { maskApiKey, parseApiKeysFromEnv } from "../src/predexon/client.ts";
import { fetchPredictOrderbooks, groupPredictEvents } from "../src/predexon/predictfun.ts";
import {
  extractPfLine,
  guessPfMarketType,
  listFootballFixtureMarkets,
  pfFootballBaseSlug,
  pfFootballParentEventId,
} from "../src/predexon/pfFootball.ts";
import type {
  BookSnapshot,
  MonitoredEvent,
  MonitoredMarket,
  MonitoredToken,
} from "../src/types/monitoring.ts";
import Database from "better-sqlite3";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const SPORT = "predictfun" as const;

function readArg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function sideForOutcome(label: string, index: number): string {
  const l = label.trim().toLowerCase();
  if (l === "yes" || l === "over") return l;
  if (l === "no" || l === "under") return l;
  if (index === 0) return "home";
  if (index === 1) return "away";
  return `out${index}`;
}

function toEvent(
  eventId: string,
  baseSlug: string,
  title: string,
  markets: Awaited<ReturnType<typeof listFootballFixtureMarkets>>,
  createdTime: string | null,
  status: string,
): MonitoredEvent {
  const createdMs = createdTime ? Date.parse(createdTime) : NaN;
  const mks: MonitoredMarket[] = [];
  for (const m of markets) {
    const marketType = guessPfMarketType(m.title, m.marketVariant);
    const line = extractPfLine(m.title, marketType);
    const marketId = `pf:${m.marketId}`;
    const tokens: MonitoredToken[] = m.outcomes.map((o, i) => ({
      tokenId: o.tokenId || `${marketId}:${sideForOutcome(o.label, i)}`,
      marketId,
      eventId,
      sport: SPORT,
      marketType,
      side: sideForOutcome(o.label, i),
      label: o.label,
      line,
    }));
    mks.push({
      marketId,
      eventId,
      sport: SPORT,
      marketType,
      question: m.title,
      line,
      tokens,
    });
  }
  return {
    eventId,
    sport: SPORT,
    title,
    slug: baseSlug,
    startTime: createdTime,
    eventDate: Number.isFinite(createdMs) ? new Date(createdMs).toISOString().slice(0, 10) : null,
    ended: status === "closed",
    polyLive: false,
    closed: status === "closed",
    gameStatus: status === "closed" ? "closed" : "open",
    finishedAt: status === "closed" && Number.isFinite(createdMs) ? createdMs : null,
    markets: mks,
  };
}

function listTargets(only?: string, forceProps = false): string[] {
  if (only) return [pfFootballParentEventId(only)];
  const dir = join("data", "predictfun");
  const out: string[] = [];
  for (const f of readdirSync(dir).filter((x) => /^\d{4}-\d{2}\.db$/.test(x))) {
    const db = new Database(join(dir, f), { readonly: true });
    const rows = db
      .prepare(
        `SELECT e.id AS id,
                COALESCE(d.snapshots, 0) AS snaps,
                (SELECT COUNT(*) FROM mk WHERE eid = e.id) AS mk
         FROM ev e LEFT JOIN dl d ON d.eid = e.id
         WHERE e.id LIKE 'pf:epl-%' OR e.id LIKE 'pf:lal-%' OR e.id LIKE 'pf:fl1-%'
            OR e.id LIKE 'pf:bun-%' OR e.id LIKE 'pf:mls-%' OR e.id LIKE 'pf:ucl-%'
            OR e.id LIKE 'pf:uel-%' OR e.id LIKE 'pf:clf-%' OR e.id LIKE 'pf:fif-%'
            OR e.id LIKE 'pf:unl-%' OR e.id LIKE 'pf:efl-%' OR e.id LIKE 'pf:ser-%'`,
      )
      .all() as Array<{ id: string; snaps: number; mk: number }>;
    for (const r of rows) {
      // Skip prop-only sibling rows if any leaked in
      if (/-(exact-score|more-markets|total-corners)$/.test(r.id)) continue;
      if (forceProps) {
        if (r.mk < 10 || r.snaps === 0) out.push(r.id);
      } else if (r.snaps === 0 || r.mk <= 3) {
        out.push(r.id);
      }
    }
    db.close();
  }
  return [...new Set(out)];
}

async function main() {
  ensureDataDirs();
  const argv = process.argv.slice(2);
  const only = readArg(argv, "--only");
  const limit = Number(readArg(argv, "--limit") ?? "100");
  const forceProps = argv.includes("--force-props") || Boolean(only);
  const client = {
    apiKeys: parseApiKeysFromEnv(),
    requestDelayMs: Number(process.env.PREDEXON_REQUEST_DELAY_MS ?? "50"),
  };
  const ids = listTargets(only, forceProps).slice(0, Math.max(1, limit));
  console.log(
    `backfill PF football (+props) n=${ids.length} keys=${client.apiKeys.map(maskApiKey).join(",")}` +
      (only ? ` only=${only}` : ""),
  );

  const hub = new MonitorHub();
  let ok = 0;
  let snapsTotal = 0;
  let errors = 0;

  for (const eventId of ids) {
    const base = pfFootballBaseSlug(eventId);
    const parentId = pfFootballParentEventId(base);
    try {
      hub.resetDownload(parentId);
      const markets = await listFootballFixtureMarkets(client, base, {
        statuses: ["closed", "open"],
        maxPages: 15,
      });
      if (!markets.length) {
        console.log(`  ${parentId}: no Predexon markets`);
        continue;
      }
      const groups = groupPredictEvents(markets);
      const money = groups.find((g) => g.eventSlug === base) ?? groups[0]!;
      // Preserve repaired title
      let title = money.title;
      for (const f of readdirSync(join("data", "predictfun")).filter((x) => /^\d{4}-\d{2}\.db$/.test(x))) {
        const db = new Database(join("data", "predictfun", f), { readonly: true });
        const row = db.prepare("SELECT t FROM ev WHERE id = ?").get(parentId) as { t: string } | undefined;
        db.close();
        if (row?.t && /\bvs\.?\b/i.test(row.t)) {
          title = row.t;
          break;
        }
      }
      const event = toEvent(parentId, base, title, markets, money.createdTime, money.status);
      hub.syncCatalog([event]);

      const createdMs = money.createdTime ? Date.parse(money.createdTime) : NaN;
      const slugDate = /-(\d{4}-\d{2}-\d{2})$/.exec(base)?.[1];
      const matchEnd = slugDate ? Date.parse(`${slugDate}T23:59:59Z`) : NaN;
      let startMs = Number.isFinite(createdMs) ? createdMs : Date.now() - 30 * 86_400_000;
      let endMs = Number.isFinite(matchEnd) ? matchEnd + 2 * 86_400_000 : Date.now();
      if (Number.isFinite(matchEnd)) startMs = Math.min(startMs, matchEnd - 14 * 86_400_000);

      let snaps = 0;
      let lastTs: number | null = null;
      for (const market of markets) {
        const tokenId = market.outcomes[0]?.tokenId || `pf:${market.marketId}:yes`;
        const rows = await fetchPredictOrderbooks(client, market.marketId, startMs, endMs);
        for (const snap of rows) {
          const bids = normalizeBookSide(snap.bids, "bid");
          const asks = normalizeBookSide(snap.asks, "ask");
          const row: BookSnapshot = {
            tokenId,
            eventId: parentId,
            sport: SPORT,
            capturedAt: snap.ts,
            bestBid: snap.bestBid ?? bestOf(bids, "bid"),
            bestAsk: snap.bestAsk ?? bestOf(asks, "ask"),
            bidDepth: depthSum(bids),
            askDepth: depthSum(asks),
            bids,
            asks,
            source: "rest",
          };
          hub.recordSnapshot(row);
          snaps++;
          if (lastTs == null || snap.ts > lastTs) lastTs = snap.ts;
        }
      }

      if (snaps > 0) {
        hub.markDownloadComplete(parentId, {
          tokens: event.markets.reduce((n, m) => n + m.tokens.length, 0),
          snapshots: snaps,
          lastTs,
          fromMs: startMs,
          toMs: endMs,
        });
      } else {
        hub.markDownloadIncomplete(parentId, {
          tokens: event.markets.reduce((n, m) => n + m.tokens.length, 0),
          fromMs: startMs,
          toMs: endMs,
          note: "backfill: 0 snaps",
        });
      }
      console.log(
        `  ${parentId} markets=${markets.length} snaps=${snaps} ` +
          `${new Date(startMs).toISOString().slice(0, 10)}→${new Date(endMs).toISOString().slice(0, 10)}`,
      );
      ok++;
      snapsTotal += snaps;
    } catch (e) {
      errors++;
      console.error(`  error ${parentId}:`, e instanceof Error ? e.message : e);
    }
  }

  hub.close();
  console.log(`done ok=${ok} snaps=${snapsTotal} errors=${errors}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

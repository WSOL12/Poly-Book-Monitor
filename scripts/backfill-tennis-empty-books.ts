/**
 * Backfill Poly tennis events that have catalog but empty/stale books.
 * Fixes China Open etc. after kickoff moved across month boundary.
 *
 *   npx tsx scripts/backfill-tennis-empty-books.ts
 *   npx tsx scripts/backfill-tennis-empty-books.ts --only 1097396
 *   npx tsx scripts/backfill-tennis-empty-books.ts --china --limit 40
 */
import "../src/config/env.ts";
import { ensureDataDirs } from "../src/config/env.ts";
import { allTokens } from "../src/catalog/parsers.ts";
import {
  bestOf,
  depthSum,
  MonitorHub,
  normalizeBookSide,
} from "../src/db/store.ts";
import { maskApiKey, parseApiKeysFromEnv } from "../src/predexon/client.ts";
import { fetchPolyOrderbooks } from "../src/predexon/orderbooks.ts";
import type { BookSnapshot, MonitoredEvent } from "../src/types/monitoring.ts";
import { getEvent, listEvents } from "../web/lib/db.ts";
import Database from "better-sqlite3";
import { readdirSync } from "node:fs";
import { join } from "node:path";

function readArg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function emptyTennisIds(chinaOnly: boolean): string[] {
  const out: string[] = [];
  for (const f of readdirSync("data/tennis").filter((x) => /^\d{4}-\d{2}\.db$/.test(x))) {
    const db = new Database(join("data/tennis", f), { readonly: true });
    const rows = db
      .prepare(
        `SELECT e.id AS id, e.t AS title,
                (SELECT COUNT(*) FROM ob o WHERE o.eid = e.id) AS ob
         FROM ev e`,
      )
      .all() as Array<{ id: string; title: string; ob: number }>;
    for (const r of rows) {
      if (chinaOnly && !/china open/i.test(r.title)) continue;
      if (r.ob < 50) out.push(r.id); // thin/empty
    }
    db.close();
  }
  return [...new Set(out)];
}

async function main() {
  ensureDataDirs();
  const argv = process.argv.slice(2);
  const only = readArg(argv, "--only");
  const limit = Number(readArg(argv, "--limit") ?? "60");
  const china = argv.includes("--china");
  const client = {
    apiKeys: parseApiKeysFromEnv(),
    requestDelayMs: Number(process.env.PREDEXON_REQUEST_DELAY_MS ?? "40"),
  };

  const ids = only ? [only] : emptyTennisIds(china).slice(0, Math.max(1, limit));
  console.log(
    `backfill tennis empty books n=${ids.length} keys=${client.apiKeys.map(maskApiKey).join(",")}` +
      (only ? ` only=${only}` : china ? " china" : ""),
  );

  const hub = new MonitorHub();
  let ok = 0;
  let snapsTotal = 0;
  let errors = 0;

  for (const eventId of ids) {
    try {
      const detail = getEvent(eventId);
      if (!detail) {
        console.log(`  skip ${eventId}: not found`);
        continue;
      }
      // Rebuild MonitoredEvent from stored catalog
      const event: MonitoredEvent = {
        eventId: detail.eventId,
        sport: "tennis",
        title: detail.title,
        slug: detail.slug,
        startTime: detail.startTime,
        eventDate: detail.eventDate,
        ended: detail.ended,
        polyLive: detail.polyLive,
        closed: detail.closed,
        gameStatus: detail.gameStatus,
        finishedAt: detail.finishedAt,
        markets: detail.markets.map((m) => ({
          marketId: m.marketId,
          eventId: detail.eventId,
          sport: "tennis" as const,
          marketType: m.marketType as MonitoredEvent["markets"][number]["marketType"],
          question: m.question,
          line: m.line,
          tokens: m.tokens.map((t) => ({
            tokenId: t.tokenId,
            marketId: m.marketId,
            eventId: detail.eventId,
            sport: "tennis" as const,
            marketType: m.marketType as MonitoredEvent["markets"][number]["marketType"],
            side: t.side,
            label: t.label,
            line: t.line,
          })),
        })),
      };

      hub.syncCatalog([event]);
      hub.resetDownload(eventId);
      const tokens = allTokens([event]);

      const startHint = event.startTime ? Date.parse(event.startTime) : Date.now();
      const startMs = Math.max(
        Date.parse("2026-01-01T00:00:00Z"),
        (Number.isFinite(startHint) ? startHint : Date.now()) - 3 * 86_400_000,
      );
      const endMs = Date.now() + 2 * 3600_000;

      let snaps = 0;
      let lastTs: number | null = null;
      for (const tok of tokens) {
        const rows = await fetchPolyOrderbooks(client, tok.tokenId, startMs, endMs);
        for (const snap of rows) {
          const bids = normalizeBookSide(snap.bids, "bid");
          const asks = normalizeBookSide(snap.asks, "ask");
          const row: BookSnapshot = {
            tokenId: tok.tokenId,
            eventId,
            sport: "tennis",
            capturedAt: snap.ts,
            bestBid: bestOf(bids, "bid"),
            bestAsk: bestOf(asks, "ask"),
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
        if (event.ended || event.closed) {
          hub.markDownloadComplete(eventId, {
            tokens: tokens.length,
            snapshots: snaps,
            lastTs,
            fromMs: startMs,
            toMs: endMs,
          });
        } else {
          hub.markDownloadIncomplete(eventId, {
            tokens: tokens.length,
            fromMs: startMs,
            toMs: endMs,
            note: `open; snaps=${snaps}`,
          });
        }
      }
      console.log(
        `  ${eventId} snaps=${snaps} ${event.title.slice(0, 55)}`,
      );
      ok++;
      snapsTotal += snaps;
    } catch (e) {
      errors++;
      console.error(`  error ${eventId}:`, e instanceof Error ? e.message : e);
    }
  }

  hub.close();
  // Clear list cache is process-local; web server needs refresh
  console.log(`done ok=${ok} snaps=${snapsTotal} errors=${errors}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

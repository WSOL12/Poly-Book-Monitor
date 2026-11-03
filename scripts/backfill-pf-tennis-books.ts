/**
 * Backfill Predict.fun tennis orderbooks for events that have catalog but 0/thin snaps.
 *
 *   npx tsx scripts/backfill-pf-tennis-books.ts --only atp-faria-alcaraz-2026-09-02
 *   npx tsx scripts/backfill-pf-tennis-books.ts --limit 40
 *   npx tsx scripts/backfill-pf-tennis-books.ts --us-open --limit 80
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
import {
  fetchPredictOrderbooks,
  groupPredictEvents,
  listPredictMarkets,
  type PredictMarket,
} from "../src/predexon/predictfun.ts";
import type {
  BookSnapshot,
  MarketType,
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

function guessMarketType(title: string): MarketType {
  if (/set handicap|sets? handicap/i.test(title)) return "set_handicap";
  if (/game (spread|handicap)|spread/i.test(title)) return "game_handicap";
  if (/set \d|set winner/i.test(title)) return "set_winner";
  if (/o\/u|over\/under|total/i.test(title)) return "total";
  if (/completed match|match completed/i.test(title)) return "completed_match";
  return "moneyline";
}

function sideForOutcome(label: string, index: number): string {
  const l = label.trim().toLowerCase();
  if (l === "yes" || l === "over") return l;
  if (l === "no" || l === "under") return l;
  if (index === 0) return "home";
  if (index === 1) return "away";
  return `out${index}`;
}

function playersFromMatchTitle(title: string): [string, string] | null {
  const raw = title.replace(/^[^:]+:\s*/, " ").trim();
  const parts = raw.split(/\s+vs\.?\s+|\s+versus\s+/i);
  if (parts.length !== 2) return null;
  const name = (s: string) => {
    const words = s.replace(/[^a-zA-Z0-9\s]/g, " ").replace(/\s+/g, " ").trim().split(" ");
    const last = words[words.length - 1] ?? s;
    return last ? last.charAt(0).toUpperCase() + last.slice(1) : s;
  };
  const a = name(parts[0]!);
  const b = name(parts[1]!);
  if (!a || !b) return null;
  return [a, b];
}

function outcomeLabel(raw: string, side: string, marketTitle: string): string {
  if (!/^(yes|no)$/i.test(raw.trim())) return raw;
  const players = playersFromMatchTitle(marketTitle);
  if (players) return side === "no" || side === "away" ? players[1] : players[0];
  return side === "no" ? `No ${marketTitle}` : marketTitle;
}

function toEvent(group: ReturnType<typeof groupPredictEvents>[number]): MonitoredEvent {
  const markets: MonitoredMarket[] = [];
  for (const m of group.markets) {
    const marketType = guessMarketType(m.title);
    const marketId = `pf:${m.marketId}`;
    const tokens: MonitoredToken[] = m.outcomes.map((o, i) => {
      const side = sideForOutcome(o.label, i);
      return {
        tokenId: o.tokenId || `${marketId}:${side}`,
        marketId,
        eventId: group.eventId,
        sport: SPORT,
        marketType,
        side,
        label: outcomeLabel(o.label, side, m.title),
        line: null,
      };
    });
    markets.push({
      marketId,
      eventId: group.eventId,
      sport: SPORT,
      marketType,
      question: m.title,
      line: null,
      tokens,
    });
  }
  const createdMs = group.createdTime ? Date.parse(group.createdTime) : NaN;
  return {
    eventId: group.eventId,
    sport: SPORT,
    title: group.title,
    slug: group.eventSlug ?? group.eventId,
    startTime: group.createdTime,
    eventDate: Number.isFinite(createdMs) ? new Date(createdMs).toISOString().slice(0, 10) : null,
    ended: group.status === "closed",
    polyLive: false,
    closed: group.status === "closed",
    gameStatus: group.status === "closed" ? "closed" : "open",
    finishedAt: group.status === "closed" && Number.isFinite(createdMs) ? createdMs : null,
    markets,
  };
}

function listEmptyPfTennis(usOpenOnly: boolean): string[] {
  const out: string[] = [];
  for (const f of readdirSync("data/predictfun").filter((x) => /^\d{4}-\d{2}\.db$/.test(x))) {
    const db = new Database(join("data/predictfun", f), { readonly: true });
    const rows = db
      .prepare(
        `SELECT e.id AS id, e.t AS title,
                (SELECT COUNT(*) FROM ob o WHERE o.eid = e.id) AS ob
         FROM ev e
         WHERE e.id LIKE 'pf:atp-%' OR e.id LIKE 'pf:wta-%'
            OR e.id LIKE 'pf:us-open%' OR e.t LIKE '%Open%'`,
      )
      .all() as Array<{ id: string; title: string; ob: number }>;
    for (const r of rows) {
      if (usOpenOnly && !/us open/i.test(r.title) && !/us-open/i.test(r.id)) continue;
      if (r.ob < 20) out.push(r.id);
    }
    db.close();
  }
  return [...new Set(out)];
}

async function fetchMarketsForSlug(
  client: { apiKeys: string[]; requestDelayMs: number },
  slug: string,
): Promise<PredictMarket[]> {
  const out: PredictMarket[] = [];
  const seen = new Set<number>();
  for (const status of ["closed", "open"] as const) {
    const page = await listPredictMarkets(client, {
      eventSlug: slug,
      status,
      maxPages: 10,
    });
    for (const m of page) {
      if (seen.has(m.marketId)) continue;
      seen.add(m.marketId);
      out.push(m);
    }
  }
  // Tennis sometimes also has -more-markets style props
  for (const suf of ["-more-markets", "-exact-score"]) {
    for (const status of ["closed", "open"] as const) {
      const page = await listPredictMarkets(client, {
        eventSlug: `${slug}${suf}`,
        status,
        maxPages: 8,
      });
      for (const m of page) {
        if (seen.has(m.marketId)) continue;
        seen.add(m.marketId);
        out.push(m);
      }
    }
  }
  return out;
}

async function main() {
  ensureDataDirs();
  const argv = process.argv.slice(2);
  const only = readArg(argv, "--only");
  const limit = Number(readArg(argv, "--limit") ?? "40");
  const usOpen = argv.includes("--us-open");
  const client = {
    apiKeys: parseApiKeysFromEnv(),
    requestDelayMs: Number(process.env.PREDEXON_REQUEST_DELAY_MS ?? "40"),
  };

  const ids = only
    ? [only.startsWith("pf:") ? only : `pf:${only}`]
    : listEmptyPfTennis(usOpen).slice(0, Math.max(1, limit));

  console.log(
    `backfill PF tennis books n=${ids.length} keys=${client.apiKeys.map(maskApiKey).join(",")}` +
      (only ? ` only=${only}` : usOpen ? " us-open" : ""),
  );

  const hub = new MonitorHub();
  let ok = 0;
  let snapsTotal = 0;
  let errors = 0;

  for (const eventId of ids) {
    const slug = eventId.startsWith("pf:") ? eventId.slice(3) : eventId;
    try {
      hub.resetDownload(eventId);
      const markets = await fetchMarketsForSlug(client, slug);
      if (!markets.length) {
        console.log(`  ${eventId}: no Predexon markets`);
        continue;
      }
      const group = groupPredictEvents(markets)[0]!;
      // Keep human title from DB if present
      let title = group.title;
      for (const f of readdirSync("data/predictfun").filter((x) => /^\d{4}-\d{2}\.db$/.test(x))) {
        const db = new Database(join("data/predictfun", f), { readonly: true });
        const row = db.prepare("SELECT t FROM ev WHERE id = ?").get(eventId) as { t: string } | undefined;
        db.close();
        if (row?.t && row.t.length > 8) {
          title = row.t;
          break;
        }
      }
      const event = toEvent({
        ...group,
        eventId,
        eventSlug: slug,
        title,
      });
      hub.syncCatalog([event]);

      const createdMs = group.createdTime ? Date.parse(group.createdTime) : NaN;
      const slugDate = /-(\d{4}-\d{2}-\d{2})$/.exec(slug)?.[1];
      const matchDay = slugDate ? Date.parse(`${slugDate}T23:59:59Z`) : NaN;
      let startMs = Number.isFinite(createdMs)
        ? createdMs - 2 * 86_400_000
        : Date.now() - 45 * 86_400_000;
      let endMs = Number.isFinite(matchDay) ? matchDay + 2 * 86_400_000 : Date.now();
      if (Number.isFinite(matchDay)) startMs = Math.min(startMs, matchDay - 14 * 86_400_000);
      if (endMs <= startMs) endMs = startMs + 7 * 86_400_000;

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
            eventId,
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
        hub.markDownloadComplete(eventId, {
          tokens: event.markets.reduce((n, m) => n + m.tokens.length, 0),
          snapshots: snaps,
          lastTs,
          fromMs: startMs,
          toMs: endMs,
        });
      } else {
        hub.markDownloadIncomplete(eventId, {
          tokens: event.markets.reduce((n, m) => n + m.tokens.length, 0),
          fromMs: startMs,
          toMs: endMs,
          note: "pf tennis backfill: 0 snaps",
        });
      }
      console.log(
        `  ${eventId} markets=${markets.length} snaps=${snaps} ${title.slice(0, 55)}`,
      );
      ok++;
      snapsTotal += snaps;
    } catch (e) {
      errors++;
      console.error(`  error ${eventId}:`, e instanceof Error ? e.message : e);
    }
  }

  hub.close();
  console.log(`done ok=${ok} snaps=${snapsTotal} errors=${errors}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

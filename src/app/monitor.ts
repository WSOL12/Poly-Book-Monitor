import {
  CATALOG_REFRESH_MS,
  CONSOLE_REFRESH_MS,
  POST_FINISH_GRACE_MS,
  WEATHER_ARM_PRICE,
} from "../config/env.ts";
import {
  fetchEventsByTags,
  fetchEventsByIds,
  fetchOpenEventsByTags,
  finishedAtFromGamma,
  isFinishedGammaEvent,
  tennisStopReason,
  SPORT_TAGS,
} from "../catalog/gamma.ts";
import {
  allTokens,
  streamTokens,
  parseLiveSportEvents,
  parseOpenTennisEvents,
  parseWeatherEvents,
} from "../catalog/parsers.ts";
import { MonitorHub } from "../db/store.ts";
import { OrderbookStream } from "../stream/orderbookStream.ts";
import { saveLiveLinks } from "../infra/links.ts";
import { paintConsole, restoreConsole } from "../ui/console.ts";
import type { MonitoredEvent, MonitoredToken, MonitorSport } from "../types/monitoring.ts";

/** Live boards — refresh first so soccer isn't blocked by weather/tennis dumps. */
const LIVE_SPORTS: MonitorSport[] = ["soccer", "football", "mlb"];
const OPEN_SPORTS: MonitorSport[] = ["weather", "tennis"];
/** Sports where markets keep trading after Gamma flips live=false / FINAL. */
const SETTLEMENT_GRACE_SPORTS = new Set<MonitorSport>(["soccer", "football", "mlb"]);
const eventLog: string[] = [];

function pushLog(message: string) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${message}`;
  eventLog.push(line);
  if (eventLog.length > 8) eventLog.shift();
}

function weatherReady(event: MonitoredEvent, armed: Set<string>) {
  if (armed.has(event.eventId)) return true;
  const price = event.maxYesPrice;
  return price != null && price >= WEATHER_ARM_PRICE;
}

type SportBatch = { sport: MonitorSport; events: MonitoredEvent[] };

async function fetchLiveSport(sport: MonitorSport): Promise<SportBatch> {
  const gammaEvents = await fetchEventsByTags(SPORT_TAGS[sport]);
  return { sport, events: parseLiveSportEvents(sport, gammaEvents) };
}

async function fetchOpenSport(sport: MonitorSport): Promise<SportBatch> {
  if (sport === "weather") {
    const gammaEvents = await fetchOpenEventsByTags(SPORT_TAGS.weather);
    return { sport, events: parseWeatherEvents(gammaEvents) };
  }
  const gammaEvents = await fetchOpenEventsByTags(SPORT_TAGS.tennis);
  return { sport, events: parseOpenTennisEvents(gammaEvents) };
}

export async function main() {
  const hub = new MonitorHub();
  const recovered = hub.armWeatherThatAlreadyHasBooks();
  if (recovered) pushLog(`re-arm ${recovered} weather already on disk`);
  const startedAt = Date.now();
  let events: MonitoredEvent[] = [];
  let tokens: MonitoredToken[] = [];
  let weatherWaiting = 0;
  let liveRefreshing = false;
  let openRefreshing = false;
  let lastCatalogAt = 0;
  /** Finished events still subscribed so settlement ladders land in SQLite. */
  const finishing = new Map<string, { event: MonitoredEvent; since: number }>();

  const stream = new OrderbookStream(() => tokens, hub, pushLog);

  const paint = () => {
    const stats = hub.stats();
    paintConsole({
      events,
      tokens,
      snapshots: stats.snapshots,
      wss: stream.getStats(),
      catalogAt: lastCatalogAt,
      startedAt,
      refreshing: liveRefreshing || openRefreshing,
      log: [...eventLog],
      weatherWaiting,
    });
  };

  const applyCatalog = async (
    batches: SportBatch[],
    okSports: Set<MonitorSport>,
    keepSports: MonitorSport[]
  ) => {
    const catalog: MonitoredEvent[] = [];
    for (const batch of batches) catalog.push(...batch.events);
    // Preserve sports we didn't refresh this pass (e.g. keep tennis while updating soccer).
    for (const sport of keepSports) {
      if (okSports.has(sport)) continue;
      for (const event of events) {
        if (event.sport === sport) catalog.push(event);
      }
    }

    if (!catalog.length && !okSports.size) return;

    catalog.sort(
      (a, b) => (a.eventDate ?? "").localeCompare(b.eventDate ?? "") || a.title.localeCompare(b.title)
    );

    const catalogIds = new Set(catalog.map((e) => e.eventId));
    const prevIds = new Set(events.map((e) => e.eventId));

    hub.syncCatalog(catalog);

    const armed = new Set(hub.listArmedEventIds());
    const active: MonitoredEvent[] = [];
    let waiting = 0;
    for (const event of catalog) {
      if (event.sport !== "weather") {
        active.push(event);
        continue;
      }
      const alreadyLive = prevIds.has(event.eventId);
      if (alreadyLive || weatherReady(event, armed)) {
        if (!armed.has(event.eventId)) {
          hub.armEvent(event.eventId);
          armed.add(event.eventId);
          const cents =
            event.maxYesPrice != null ? `${Math.round(event.maxYesPrice * 100)}¢` : "armed";
          pushLog(`ARM weather ${cents} ${event.title}`);
        }
        active.push(event);
      } else {
        waiting++;
      }
    }
    weatherWaiting = waiting;

    for (const event of active) {
      if (!prevIds.has(event.eventId)) pushLog(`+ ${event.sport} ${event.title}`);
    }
    for (const event of events) {
      if (catalogIds.has(event.eventId) || finishing.has(event.eventId)) continue;
      if (!okSports.has(event.sport)) continue;
      const why =
        event.sport === "tennis" && event.gameStatus ? ` (${event.gameStatus})` : "";
      pushLog(`- ${event.sport} ${event.title}${why}`);
    }

    const storedBefore = new Set([
      ...hub.listEventIds(),
      ...[...okSports].flatMap((sport) => hub.listOpenEventIds(sport)),
    ]);
    const dropped = [...storedBefore].filter((id) => {
      if (catalogIds.has(id)) return false;
      const sport = hub.getEventSport(id) ?? events.find((e) => e.eventId === id)?.sport;
      // Never finish a sport we failed to refresh this pass.
      if (sport && !okSports.has(sport as MonitorSport)) return false;
      return true;
    });
    if (dropped.length) hub.markEventsFinished(dropped);

    const activeIds = new Set(active.map((e) => e.eventId));
    for (const id of activeIds) finishing.delete(id);
    for (const prev of events) {
      if (activeIds.has(prev.eventId)) continue;
      if (!SETTLEMENT_GRACE_SPORTS.has(prev.sport)) continue;
      if (finishing.has(prev.eventId)) continue;
      if (!okSports.has(prev.sport)) continue;
      finishing.set(prev.eventId, { event: prev, since: Date.now() });
      pushLog(`grace ${prev.sport} ${prev.title}`);
    }
    const now = Date.now();
    for (const [id, row] of finishing) {
      if (now - row.since >= POST_FINISH_GRACE_MS) finishing.delete(id);
    }
    const graceEvents = [...finishing.values()].map((row) => row.event);

    const statusIds = [...new Set([...catalogIds, ...dropped.slice(0, 40)])];
    if (statusIds.length) {
      try {
        const sportById = new Map(catalog.map((e) => [e.eventId, e.sport]));
        for (const id of dropped) {
          if (!sportById.has(id)) {
            const sport = hub.getEventSport(id);
            if (sport) sportById.set(id, sport);
          }
        }
        const gammaRows = await fetchEventsByIds(statusIds);
        hub.updatePolyStatuses(
          gammaRows.map((row) => {
            const id = String(row.id);
            const sport = sportById.get(id);
            const leftCatalog = !catalogIds.has(id);
            const tennisReason = sport === "tennis" ? tennisStopReason(row) : null;
            const finished =
              sport === "tennis"
                ? tennisReason != null || leftCatalog || isFinishedGammaEvent(row, { sport })
                : isFinishedGammaEvent(row, { sport }) || leftCatalog;
            const gameStatus =
              sport === "tennis"
                ? tennisReason ?? (leftCatalog ? "started" : row.gameStatus?.trim() || null)
                : row.gameStatus?.trim() || row.period?.trim() || null;
            return {
              eventId: id,
              ended: finished,
              polyLive: row.live === true && !finished,
              closed: row.closed === true,
              gameStatus,
              finishedAt: finished ? finishedAtFromGamma(row, { sport }) ?? Date.now() : null,
              score: row.score ?? null,
              period: row.period ?? null,
              elapsed: row.elapsed ?? null,
            };
          })
        );
      } catch (err) {
        pushLog(`status: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const streaming = [...active, ...graceEvents];
    events = streaming;
    const all = allTokens(streaming);
    tokens = streamTokens(streaming, 128);
    lastCatalogAt = Date.now();
    saveLiveLinks(active);
    stream.sync();
    const soccerN = active.filter((e) => e.sport === "soccer").length;
    const tennisN = active.filter((e) => e.sport === "tennis").length;
    const graceN = graceEvents.length;
    const clipped = all.length > tokens.length ? ` · clip ${all.length}→${tokens.length}` : "";
    pushLog(
      `ok ${active.length} live · soccer ${soccerN} · tennis ${tennisN} · ${tokens.length} tok${clipped}${
        graceN ? ` · grace ${graceN}` : ""
      } · wx wait ${waiting}`
    );
  };

  const refreshLiveCatalog = async () => {
    if (liveRefreshing) return;
    liveRefreshing = true;
    paint();
    try {
      // Soccer first — never block in-play boards on nfl/mlb Gamma timeouts.
      const soccerResult = await Promise.allSettled([fetchLiveSport("soccer")]);
      const okSports = new Set<MonitorSport>();
      const batches: SportBatch[] = [];
      if (soccerResult[0]?.status === "fulfilled") {
        okSports.add("soccer");
        batches.push(soccerResult[0].value);
      } else {
        const err =
          soccerResult[0]?.status === "rejected"
            ? soccerResult[0].reason instanceof Error
              ? soccerResult[0].reason.message
              : String(soccerResult[0].reason)
            : "unknown";
        pushLog(`catalog soccer: ${err}`);
        const kept = events.filter((e) => e.sport === "soccer");
        if (kept.length) batches.push({ sport: "soccer", events: kept });
      }
      if (batches.length) await applyCatalog(batches, okSports, [...OPEN_SPORTS, "football", "mlb"]);

      const other = await Promise.allSettled(
        (["football", "mlb"] as MonitorSport[]).map((sport) => fetchLiveSport(sport))
      );
      const otherOk = new Set<MonitorSport>();
      const otherBatches: SportBatch[] = [];
      const otherSports: MonitorSport[] = ["football", "mlb"];
      for (let i = 0; i < other.length; i++) {
        const sport = otherSports[i]!;
        const result = other[i]!;
        if (result.status === "fulfilled") {
          otherOk.add(sport);
          otherBatches.push(result.value);
          continue;
        }
        const err = result.reason instanceof Error ? result.reason.message : String(result.reason);
        pushLog(`catalog ${sport}: ${err}`);
        const kept = events.filter((e) => e.sport === sport);
        if (kept.length) otherBatches.push({ sport, events: kept });
      }
      if (otherOk.size || otherBatches.length) {
        await applyCatalog(otherBatches, otherOk, [...OPEN_SPORTS, "soccer"]);
      }
    } catch (error) {
      pushLog(`catalog live: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      liveRefreshing = false;
    }
  };

  const refreshOpenCatalog = async () => {
    if (openRefreshing) return;
    openRefreshing = true;
    paint();
    try {
      // Fetch independently so tennis timeout doesn't skip weather (and vice versa).
      for (const sport of OPEN_SPORTS) {
        try {
          const batch = await fetchOpenSport(sport);
          await applyCatalog([batch], new Set<MonitorSport>([sport]), [
            ...LIVE_SPORTS,
            ...OPEN_SPORTS.filter((s) => s !== sport),
          ]);
          // Belt-and-suspenders: finish any e=0 rows still open for this sport
          // that were not in the fresh catalog (ITF / vanished / prior zombies).
          const keep = new Set(batch.events.map((e) => e.eventId));
          const orphans = hub.listOpenEventIds(sport).filter((id) => !keep.has(id));
          if (orphans.length) {
            hub.markEventsFinished(orphans);
            pushLog(`scrub ${sport} ${orphans.length} orphans`);
          }
        } catch (err) {
          pushLog(
            `catalog ${sport}: ${err instanceof Error ? err.message : String(err)}`
          );
          // Status-sweep known IDs so stopped tennis doesn't linger as e=0 forever.
          const known = events.filter((e) => e.sport === sport).map((e) => e.eventId);
          const fromHub = hub.listOpenEventIds(sport);
          const ids = [...new Set([...known, ...fromHub])].slice(0, 80);
          if (!ids.length) continue;
          try {
            const gammaRows = await fetchEventsByIds(ids);
            const seen = new Set(gammaRows.map((r) => String(r.id)));
            hub.updatePolyStatuses(
              gammaRows.map((row) => {
                const id = String(row.id);
                const tennisReason = sport === "tennis" ? tennisStopReason(row) : null;
                const finished =
                  sport === "tennis"
                    ? tennisReason != null || isFinishedGammaEvent(row, { sport })
                    : isFinishedGammaEvent(row, { sport });
                return {
                  eventId: id,
                  ended: finished,
                  polyLive: row.live === true && !finished,
                  closed: row.closed === true,
                  gameStatus:
                    sport === "tennis"
                      ? tennisReason ?? (row.gameStatus?.trim() || null)
                      : row.gameStatus?.trim() || row.period?.trim() || null,
                  finishedAt: finished ? finishedAtFromGamma(row, { sport }) ?? Date.now() : null,
                  score: row.score ?? null,
                  period: row.period ?? null,
                  elapsed: row.elapsed ?? null,
                };
              })
            );
            // Gamma no longer returns the id at all → finish it.
            const missing = ids.filter((id) => !seen.has(id));
            if (missing.length) {
              hub.markEventsFinished(missing);
              pushLog(`scrub ${sport} ${missing.length} missing`);
            }
          } catch (statusErr) {
            pushLog(
              `status ${sport}: ${statusErr instanceof Error ? statusErr.message : String(statusErr)}`
            );
          }
        }
      }
    } catch (error) {
      pushLog(`catalog open: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      openRefreshing = false;
    }
  };

  await refreshLiveCatalog();
  paint();
  // Clear silent tennis/weather zombies immediately — don't wait on Gamma.
  for (const sport of OPEN_SPORTS) {
    const n = hub.scrubSilentOpen(sport, 60 * 60_000);
    if (n) pushLog(`scrub ${sport} ${n} silent>1h`);
  }
  // Defer open catalog until WSS is up — Gamma timeouts starve handshakes.
  const openKick = setInterval(() => {
    if (!stream.isLive()) return;
    clearInterval(openKick);
    void refreshOpenCatalog().then(paint);
  }, 5_000);
  setTimeout(() => clearInterval(openKick), 120_000);

  const liveTimer = setInterval(() => {
    // Gamma catalog dumps compete with WSS handshakes — wait until sockets are live.
    if (!stream.isLive() && tokens.length > 0) return;
    void refreshLiveCatalog().then(paint);
  }, CATALOG_REFRESH_MS);

  const openTimer = setInterval(() => {
    for (const sport of OPEN_SPORTS) {
      const n = hub.scrubSilentOpen(sport, 60 * 60_000);
      if (n) pushLog(`scrub ${sport} ${n} silent>1h`);
    }
    // Don't pile Gamma open dumps on top of a dead WSS — reconnect first.
    if (!stream.isLive()) return;
    void refreshOpenCatalog().then(paint);
  }, Math.max(CATALOG_REFRESH_MS * 3, 90_000));

  const consoleTimer = setInterval(paint, CONSOLE_REFRESH_MS);

  const checkpointTimer = setInterval(() => {
    hub.checkpointAll("PASSIVE");
  }, 60_000);

  const onSignal = () => {
    clearInterval(liveTimer);
    clearInterval(openTimer);
    clearInterval(consoleTimer);
    clearInterval(checkpointTimer);
    stream.stop();
    hub.close();
    restoreConsole();
    process.exit(0);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}

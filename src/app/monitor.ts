import {
  CATALOG_REFRESH_MS,
  CONSOLE_REFRESH_MS,
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
  parseLiveSportEvents,
  parseOpenTennisEvents,
  parseWeatherEvents,
} from "../catalog/parsers.ts";
import { MonitorHub } from "../db/store.ts";
import { OrderbookStream } from "../stream/orderbookStream.ts";
import { saveLiveLinks } from "../infra/links.ts";
import { paintConsole, restoreConsole } from "../ui/console.ts";
import type { MonitoredEvent, MonitoredToken, MonitorSport } from "../types/monitoring.ts";

const SPORTS: MonitorSport[] = ["soccer", "football", "mlb", "weather", "tennis"];
const eventLog: string[] = [];

function pushLog(message: string) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${message}`;
  eventLog.push(line);
  if (eventLog.length > 4) eventLog.shift();
}

function weatherReady(event: MonitoredEvent, armed: Set<string>) {
  if (armed.has(event.eventId)) return true;
  const price = event.maxYesPrice;
  return price != null && price >= WEATHER_ARM_PRICE;
}

export async function main() {
  const hub = new MonitorHub();
  const recovered = hub.armWeatherThatAlreadyHasBooks();
  if (recovered) pushLog(`re-arm ${recovered} weather already on disk`);
  const startedAt = Date.now();
  let events: MonitoredEvent[] = [];
  let tokens: MonitoredToken[] = [];
  let weatherWaiting = 0;
  let refreshing = false;
  let lastCatalogAt = 0;

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
      refreshing,
      log: [...eventLog],
      weatherWaiting,
    });
  };

  const refreshCatalog = async () => {
    if (refreshing) return;
    refreshing = true;
    paint();
    try {
      const parts = await Promise.all(
        SPORTS.map(async (sport) => {
          if (sport === "weather") {
            const gammaEvents = await fetchOpenEventsByTags(SPORT_TAGS.weather);
            return parseWeatherEvents(gammaEvents);
          }
          if (sport === "tennis") {
            // Open prematch only — stop when started / canceled / retired (no ITF).
            const gammaEvents = await fetchOpenEventsByTags(SPORT_TAGS.tennis);
            return parseOpenTennisEvents(gammaEvents);
          }
          const gammaEvents = await fetchEventsByTags(SPORT_TAGS[sport]);
          return parseLiveSportEvents(sport, gammaEvents);
        })
      );
      const catalog = parts.flat();
      catalog.sort(
        (a, b) => (a.eventDate ?? "").localeCompare(b.eventDate ?? "") || a.title.localeCompare(b.title)
      );

      const catalogIds = new Set(catalog.map((e) => e.eventId));
      const prevIds = new Set(events.map((e) => e.eventId));

      // Keep full open catalog in DB; arm weather that crossed the price gate.
      hub.syncCatalog(catalog);

      const armed = new Set(hub.listArmedEventIds());
      const active: MonitoredEvent[] = [];
      let waiting = 0;
      for (const event of catalog) {
        if (event.sport !== "weather") {
          active.push(event);
          continue;
        }
        // Don't abandon a city we are already streaming this process, even if
        // Gamma's yes-price print is stale/below the 60¢ gate.
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
        if (!catalogIds.has(event.eventId)) {
          const why =
            event.sport === "tennis" && event.gameStatus
              ? ` (${event.gameStatus})`
              : "";
          pushLog(`- ${event.sport} ${event.title}${why}`);
        }
      }

      // Only finish events that left the open/live catalog — not weather waiting for 60¢.
      const storedBefore = hub.listEventIds();
      const dropped = storedBefore.filter((id) => !catalogIds.has(id));
      if (dropped.length) hub.markEventsFinished(dropped);

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

      events = active;
      tokens = allTokens(active);
      lastCatalogAt = Date.now();
      saveLiveLinks(active);
      stream.sync();
      const tennisN = active.filter((e) => e.sport === "tennis").length;
      pushLog(
        `ok ${active.length} live · ${tokens.length} tok · tennis ${tennisN} · weather wait ${waiting} (<${Math.round(WEATHER_ARM_PRICE * 100)}¢)`
      );
    } catch (error) {
      pushLog(`catalog: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      refreshing = false;
    }
  };

  await refreshCatalog();
  paint();

  const refreshTimer = setInterval(() => {
    void refreshCatalog().then(paint);
  }, CATALOG_REFRESH_MS);

  const consoleTimer = setInterval(paint, CONSOLE_REFRESH_MS);

  const checkpointTimer = setInterval(() => {
    hub.checkpointAll("PASSIVE");
  }, 60_000);

  const shutdown = () => {
    clearInterval(refreshTimer);
    clearInterval(consoleTimer);
    clearInterval(checkpointTimer);
    stream.stop();
    hub.checkpointAll("TRUNCATE");
    restoreConsole();
    hub.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

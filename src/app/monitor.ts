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
  SPORT_TAGS,
} from "../catalog/gamma.ts";
import { allTokens, parseLiveSportEvents, parseWeatherEvents } from "../catalog/parsers.ts";
import { MonitorStore, checkpointDb, openDb } from "../db/store.ts";
import { OrderbookStream } from "../stream/orderbookStream.ts";
import { saveLiveLinks } from "../infra/links.ts";
import { paintConsole, restoreConsole } from "../ui/console.ts";
import type { MonitoredEvent, MonitoredToken, MonitorSport } from "../types/monitoring.ts";

const SPORTS: MonitorSport[] = ["soccer", "football", "mlb", "weather"];
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
  const db = openDb();
  const store = new MonitorStore(db);
  const startedAt = Date.now();
  let events: MonitoredEvent[] = [];
  let tokens: MonitoredToken[] = [];
  let weatherWaiting = 0;
  let refreshing = false;
  let lastCatalogAt = 0;

  const stream = new OrderbookStream(() => tokens, store, pushLog);

  const paint = () => {
    const stats = store.stats();
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
      store.syncCatalog(catalog);

      const armed = new Set(store.listArmedEventIds());
      const active: MonitoredEvent[] = [];
      let waiting = 0;
      for (const event of catalog) {
        if (event.sport !== "weather") {
          active.push(event);
          continue;
        }
        if (weatherReady(event, armed)) {
          if (!armed.has(event.eventId)) {
            store.armEvent(event.eventId);
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

      const activeIds = new Set(active.map((e) => e.eventId));
      for (const event of active) {
        if (!prevIds.has(event.eventId)) pushLog(`+ ${event.sport} ${event.title}`);
      }
      for (const event of events) {
        if (!catalogIds.has(event.eventId)) pushLog(`- ${event.sport} ${event.title}`);
      }

      // Only finish events that left the open/live catalog — not weather waiting for 60¢.
      const storedBefore = store.listEventIds();
      const dropped = storedBefore.filter((id) => !catalogIds.has(id));
      if (dropped.length) store.markEventsFinished(dropped);

      const statusIds = [...new Set([...catalogIds, ...dropped.slice(0, 40)])];
      if (statusIds.length) {
        try {
          const sportById = new Map(catalog.map((e) => [e.eventId, e.sport]));
          for (const id of dropped) {
            if (!sportById.has(id)) {
              const sport = store.getEventSport(id);
              if (sport) sportById.set(id, sport);
            }
          }
          const gammaRows = await fetchEventsByIds(statusIds);
          store.updatePolyStatuses(
            gammaRows.map((row) => {
              const id = String(row.id);
              const sport = sportById.get(id);
              const finished = isFinishedGammaEvent(row, { sport }) || !catalogIds.has(id);
              return {
                eventId: id,
                ended: finished,
                polyLive: row.live === true && !finished,
                closed: row.closed === true,
                gameStatus: row.gameStatus?.trim() || row.period?.trim() || null,
                finishedAt: finished ? finishedAtFromGamma(row) : null,
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
      pushLog(
        `ok ${active.length} live · ${tokens.length} tok · weather wait ${waiting} (<${Math.round(WEATHER_ARM_PRICE * 100)}¢)`
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
    checkpointDb(db, "PASSIVE");
  }, 60_000);

  const shutdown = () => {
    clearInterval(refreshTimer);
    clearInterval(consoleTimer);
    clearInterval(checkpointTimer);
    stream.stop();
    checkpointDb(db, "TRUNCATE");
    restoreConsole();
    db.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

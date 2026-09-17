# Poly Monitor

Real-time Polymarket orderbook recorder for **live** soccer, football (NFL), MLB matches, **open** tennis (ATP/WTA), and **highest-temperature** weather markets across cities.

The monitor watches **in-play / live** ball sports (`live=true` on Polymarket), **open prematch tennis** until the match starts / cancels / retires (ITF skipped), and weather cities once a Yes bucket arms. It stores orderbook snapshots in local SQLite. A Next.js dashboard lets you review bid/ask movement later.

BC.GAME integration has been removed.

## Sports covered

| Sport | Polymarket tags | Watch mode |
|-------|-----------------|------------|
| Soccer | soccer, epl, la-liga, bundesliga, serie-a, ligue-1, mls, ucl, and more | Live only |
| Football | nfl, ncaa-football, football | Live only |
| MLB | mlb, baseball, npb, kbo | Live only |
| Tennis | tennis (ATP / WTA / doubles; **no ITF**) | Open prematch → stop on started / canceled / retired |
| Weather | highest-temperature (all cities, daily buckets) | Open; arm at 60¢ Yes |

Tennis stop reasons are written to `ev.gs` as `started`, `canceled`, or `retired`. Cancel/retire are detected via Gamma period (`CAN`) and void moneyline prices (~50/50).

## Quick start

```bash
npm install
cp .env.example .env   # optional

# Terminal 1 — start the monitor
npm run monitor

# Terminal 2 — open the dashboard
cd web && npm install && npm run dev
```

Dashboard: http://127.0.0.1:3000

## What gets recorded

- **Moneyline** tokens (home / away / draw for soccer; players for tennis)
- **All match total O/U** markets (multiple lines per game)
- Full orderbook depth (all bid/ask levels from WSS level 2)
- Best bid / ask updates between full books

Data is stored as **one SQLite file per sport per day**:

```
data/
  mlb/
    _idx.db
    2026-09-16.db
    2026-09-17.db
  soccer/
    _idx.db
    2026-09-16.db
  football/
    ...
  tennis/
    ...
  weather/
    ...
```

Day = event date (`eventDate` / kickoff day). Schema uses short columns (`ob.tid/ts/bb/ba/bj/aj`) and compact JSON `{p,s}`.

Legacy `data/monitoring.db` and flat `data/*.db` are no longer written.

Live Polymarket URLs are exported to `data/live-links.json` on every catalog refresh (~15s).

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `CATALOG_REFRESH_MS` | `15000` | How often to poll Polymarket for new markets |
| `DATA_DIR` | `./data` | Directory for per-sport `*.db` files |
| `MONITOR_ROOT` | `..` (from web/) | Project root for the dashboard |

## Dashboard pages

- `/` — all events with snapshot stats
- `/soccer`, `/football`, `/mlb`, `/tennis`, `/weather` — sport filters
- `/event/[eventId]` — markets and live quotes per match
- `/token/[tokenId]` — bid/ask chart and latest depth

## Project layout

```
src/
  app/monitor.ts      # main loop
  catalog/            # Polymarket Gamma API + parsers
  stream/             # CLOB WebSocket orderbook feed
  db/                 # SQLite schema + writes
web/                  # Next.js dashboard (reads SQLite)
data/{sport}/{YYYY-MM-DD}.db   # per-sport, per-day databases
data/{sport}/_idx.db           # event/token → day index
```

# Poly Monitor

Real-time Polymarket orderbook recorder for **live** soccer, football (NFL), MLB matches, and **highest-temperature** weather markets across cities.

The monitor watches **in-play / live** matches only (`live=true` on Polymarket), subscribes to all **moneyline** and **total over/under** tokens (including new totals that appear mid-game), and stores orderbook snapshots in a local SQLite database. A Next.js dashboard lets you review bid/ask movement later.

BC.GAME integration has been removed.

## Sports covered

| Sport | Polymarket tags |
|-------|-----------------|
| Soccer | soccer, epl, la-liga, bundesliga, serie-a, ligue-1, mls, ucl, and more |
| Football | nfl, ncaa-football, football |
| MLB | mlb, baseball, npb, kbo |
| Weather | highest-temperature (all cities, daily buckets) |

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

- **Moneyline** tokens (home / away / draw for soccer)
- **All match total O/U** markets (multiple lines per game)
- Full orderbook depth (all bid/ask levels from WSS level 2)
- Best bid / ask updates between full books

Data is stored in `data/monitoring.db`. Live Polymarket URLs are exported to `data/live-links.json` on every catalog refresh (~15s).

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `CATALOG_REFRESH_MS` | `15000` | How often to poll Polymarket for new markets |
| `BOOK_THROTTLE_MS` | `1000` | Minimum gap between snapshots per token |
| `DB_PATH` | `./data/monitoring.db` | SQLite file location |
| `MONITOR_ROOT` | `..` (from web/) | Project root for the dashboard |

## Dashboard pages

- `/` — all events with snapshot stats
- `/soccer`, `/football`, `/mlb` — sport filters
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
data/monitoring.db    # runtime database (gitignored)
```

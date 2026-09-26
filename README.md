# Poly Monitor

Downloads **recorded** Polymarket orderbook history from [Predexon](https://docs.predexon.com/) into local SQLite. No live WebSocket monitoring.

Covers soccer, football (NFL), MLB, tennis (ATP/WTA; ITF skipped), and highest-temperature weather markets. The Next.js dashboard reads the same day DBs as before.

## Quick start

1. Get an API key at [dashboard.predexon.com](https://dashboard.predexon.com).
2. Configure `.env`:

```bash
cp .env.example .env
# set PREDEXON_API_KEY=...
```

3. Download history, then open the dashboard:

```bash
npm install
npm run download
# optional: npm run download -- --sports soccer --days 2 --status closed

cd web && npm install && npm run dev
```

Dashboard: http://127.0.0.1:9000 (or the port Next prints).

## How it works

| Step | Source |
|------|--------|
| Discover match events | **Polymarket Gamma** (`/events` by sport tag) |
| Orderbook snapshots | **Predexon** [`/v2/polymarket/orderbooks`](https://docs.predexon.com/api-reference/markets/orderbooks) by `token_id` |

Predexon sport tags alone are full of futures/outrights (not live matches). Gamma is the match catalog; Predexon is the recorded book history (from 2026-01-01).

## Storage

Monthly shards (same idea as compare-poly-predict history DBs):

```
data/{soccer|football|mlb|tennis|weather}/
  _idx.db
  YYYY-MM.db    # ev / mk / tk / ob / sc / dl
```

`dl.complete=1` marks a finished download — re-runs **skip** that event unless you pass `--force`.

## CLI

```bash
npm run download -- --sports soccer,mlb --days 1
npm run download -- --from 2026-09-20 --to 2026-09-25 --status closed
npm run download -- --limit 5 --force
npm run download -- --delay-ms 1100   # free-plan friendly
```

| Flag / env | Description |
|------------|-------------|
| `--sports` / `DOWNLOAD_SPORTS` | Comma list of sports |
| `--status` / `DOWNLOAD_STATUS` | `open`, `closed`, or `both` |
| `--days` / `DOWNLOAD_DAYS` | Lookback window when `--from` unset |
| `--from` `--to` | ISO date or unix |
| `--delay-ms` / `PREDEXON_REQUEST_DELAY_MS` | Gap between requests per key lane |
| `--concurrency` / `DOWNLOAD_CONCURRENCY` | Parallel events |
| `--limit` / `DOWNLOAD_LIMIT` | Cap events per sport |
| `--force` | Wipe `ob` + ignore `dl.complete`, re-download |
| `dl.complete=1` | Auto-skip settled events on re-run (like the compare bot) |

## Project layout

```
src/
  app/download.ts     # entry: catalog → orderbooks → SQLite
  predexon/           # Predexon HTTP client + events + orderbooks
  catalog/            # market parsers (moneyline / O/U / tennis / weather)
  db/store.ts         # day DB schema + writers
web/                  # Next.js reviewer UI
```

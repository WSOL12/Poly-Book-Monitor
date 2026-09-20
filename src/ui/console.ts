import type { MonitoredEvent, MonitoredToken } from "../types/monitoring.ts";
import type { StreamStats } from "../stream/orderbookStream.ts";

const ESC = "\x1b";
const ANSI_RE = /\x1b\[[0-9;]*m/g;

function stripAnsi(s: string) {
  return s.replace(ANSI_RE, "");
}

function pad(s: string, n: number) {
  if (s.length > n) return s.slice(0, Math.max(0, n - 1)) + "~";
  return s + " ".repeat(n - s.length);
}

/** Fit one physical terminal row — wrapping is what made the UI scroll. */
function fit(s: string, cols: number) {
  const plain = stripAnsi(s);
  if (plain.length <= cols) return s + " ".repeat(cols - plain.length);
  // Truncate by visible chars; keep simple (drop colors if over).
  return plain.slice(0, cols - 1) + "~";
}

function ago(ms: number | null | undefined) {
  if (ms == null || ms <= 0) return "-";
  const sec = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  return `${Math.floor(sec / 3600)}h`;
}

function moneylineSummary(event: MonitoredEvent, quotes: StreamStats["quotes"]) {
  const ml = event.markets.find((m) => m.marketType === "moneyline");
  if (!ml) return "-";
  return ml.tokens
    .slice(0, 3)
    .map((tok) => {
      const ask = quotes.get(tok.tokenId)?.bestAsk;
      const c = ask == null || !Number.isFinite(ask) ? "-" : `${Math.round(ask * 100)}c`;
      return `${tok.label.slice(0, 10)} ${c}`;
    })
    .join(" | ");
}

export type ConsoleState = {
  events: MonitoredEvent[];
  tokens: MonitoredToken[];
  snapshots: number;
  wss: StreamStats;
  catalogAt: number;
  startedAt: number;
  refreshing?: boolean;
  log?: string[];
  weatherWaiting?: number;
};

export function renderConsole(state: ConsoleState, cols: number, maxRows: number) {
  const lines: string[] = [];
  const uptime = ago(state.startedAt);
  const wssState = state.wss.connected ? (state.wss.stale ? "STALE" : "LIVE") : "DOWN";
  const shardInfo =
    state.wss.shards != null ? ` ${state.wss.liveShards ?? 0}/${state.wss.shards}` : "";
  const rate =
    state.wss.snapshotsWritten > 0
      ? (state.wss.snapshotsWritten / Math.max(1, (Date.now() - state.startedAt) / 60000)).toFixed(0)
      : "0";
  const catalog = state.refreshing ? "refreshing..." : `${ago(state.catalogAt)} ago`;

  lines.push(`${ESC}[1;36mPOLY MONITOR${ESC}[0m  soccer / football / mlb / weather / tennis`);
  lines.push(
    `process  WSS ${wssState}${shardInfo}  |  ${state.events.length} events  |  ${state.tokens.length} tokens  |  up ${uptime}`
  );
  lines.push(
    `data     ${state.snapshots.toLocaleString()} snaps  |  ${rate}/min  |  catalog ${catalog}  |  msg ${ago(state.wss.lastMessageAt)}`
  );
  if ((state.weatherWaiting ?? 0) > 0) {
    lines.push(
      `weather  recording when a bucket hits 60c  |  waiting ${state.weatherWaiting} cities`
    );
  }
  lines.push("-".repeat(cols));

  if (!state.events.length) {
    lines.push(`${ESC}[33mNo live markets - waiting...${ESC}[0m`);
  } else {
    lines.push(`${ESC}[1mLIVE${ESC}[0m`);
    const budget = Math.max(3, maxRows - lines.length - 5);
    const show = state.events.slice(0, budget);
    for (const event of show) {
      const ml = event.markets.filter((m) => m.marketType === "moneyline").length;
      const ou = event.markets.filter((m) => m.marketType === "total").length;
      const wx = event.markets.filter((m) => m.marketType === "weather").length;
      const mk = wx ? `wx:${wx}` : `ML:${ml} O/U:${ou}`;
      const titleW = Math.min(40, Math.max(18, cols - 48));
      lines.push(
        `  ${ESC}[32m${pad(event.sport, 8)}${ESC}[0m ${pad(event.title, titleW)} ${pad(mk, 10)} ${moneylineSummary(event, state.wss.quotes)}`
      );
    }
    if (state.events.length > show.length) {
      lines.push(`  ${ESC}[90m+${state.events.length - show.length} more${ESC}[0m`);
    }
  }

  lines.push("-".repeat(cols));
  lines.push(`${ESC}[1mLOG${ESC}[0m`);
  const logs = (state.log ?? []).slice(-2);
  if (!logs.length) lines.push(`  ${ESC}[90m-${ESC}[0m`);
  else for (const row of logs) lines.push(`  ${ESC}[90m${row}${ESC}[0m`);
  lines.push("-".repeat(cols));
  lines.push(`${ESC}[90mCtrl+C to stop${ESC}[0m`);

  return lines.slice(0, maxRows).map((line) => fit(line, cols));
}

let active = false;
let altScreen = false;

function termSize() {
  // Cap width so wrapped lines cannot happen even if columns is wrong.
  const cols = Math.max(60, Math.min(process.stdout.columns || 80, 100));
  const rows = Math.max(14, Math.min(process.stdout.rows || 24, 40));
  return { cols, rows };
}

export function initConsole() {
  if (active) return;
  active = true;
  // Alternate buffer: updates stay on one page and do not flood scrollback.
  process.stdout.write(`${ESC}[?1049h${ESC}[?25l${ESC}[H${ESC}[2J`);
  altScreen = true;
}

export function paintConsole(state: ConsoleState) {
  initConsole();
  const { cols, rows } = termSize();
  const lines = renderConsole(state, cols, rows - 1);

  // Home cursor, paint fixed-width rows, erase anything below.
  let out = `${ESC}[H`;
  for (let i = 0; i < lines.length; i++) {
    out += lines[i] + `${ESC}[K\n`;
  }
  out += `${ESC}[J`;
  process.stdout.write(out);
}

export function restoreConsole() {
  if (!active) return;
  if (altScreen) process.stdout.write(`${ESC}[?25h${ESC}[?1049l`);
  else process.stdout.write(`${ESC}[?25h\n`);
  active = false;
  altScreen = false;
}

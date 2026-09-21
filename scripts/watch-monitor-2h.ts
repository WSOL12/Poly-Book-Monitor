/**
 * 2-hour monitor health watch — observes capture DB + does NOT open competing WSS.
 * Flags stale sports, orphan e=0 rows, snap stalls.
 *
 *   npx tsx scripts/watch-monitor-2h.ts
 */
import Database from "better-sqlite3";
import { mkdirSync, appendFileSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const SPORTS = ["soccer", "football", "mlb", "tennis", "weather"] as const;
const DURATION_MS = Number(process.env.WATCH_MS ?? 2 * 60 * 60_000);
const EVERY_MS = Number(process.env.EVERY_MS ?? 30_000);
const STALE_S = 45;
const OUT_DIR = resolve("data/_watch");
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const OUT = resolve(OUT_DIR, `monitor-2h-${STAMP}.log`);
const TERM_DIR = resolve(
  process.env.USERPROFILE ?? "",
  ".cursor/projects/c-Users-Administrator-Videos-Poly-Book-Monitor/terminals"
);

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT, `monitor watch start ${new Date().toISOString()} duration_ms=${DURATION_MS}\n`);

const issues: string[] = [];
let lastSnaps = 0;
let stallTicks = 0;

function log(line: string) {
  const row = `[${new Date().toISOString()}] ${line}`;
  console.log(row);
  appendFileSync(OUT, row + "\n");
}

function note(msg: string) {
  issues.push(`[${new Date().toISOString()}] ${msg}`);
  log(`ISSUE ${msg}`);
}

function latestDay(sport: string): string | null {
  try {
    const days = readdirSync(resolve("data", sport))
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.db$/.test(f))
      .sort()
      .reverse();
    return days[0]?.replace(/\.db$/, "") ?? null;
  } catch {
    return null;
  }
}

function readMonitorLine(): string {
  try {
    const files = readdirSync(TERM_DIR).filter((f) => f.endsWith(".txt"));
    let best = "";
    let bestStart = 0;
    for (const f of files) {
      const path = resolve(TERM_DIR, f);
      let text = "";
      try {
        text = readFileSync(path, "utf8");
      } catch {
        continue;
      }
      const head = text.slice(0, 800);
      if (!/npm run monitor|tsx src\/index\.ts/.test(head)) continue;
      if (/status:\s*(aborted|succeeded)/.test(head)) continue;
      if (!/status:\s*running/.test(head)) continue;
      const started = /started_at:\s*(\S+)/.exec(head)?.[1];
      const startMs = started ? Date.parse(started) : 0;
      const m = text.match(/process\s+WSS[^\n]*/g);
      if (!m?.length) continue;
      const last = m[m.length - 1]!.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").trim();
      if (startMs >= bestStart) {
        bestStart = startMs;
        best = last;
      }
    }
    return best || "monitor line not found";
  } catch {
    return "monitor line unread";
  }
}

type SportStat = {
  sport: string;
  open: number;
  fresh: number;
  stale: number;
  maxAge: number;
  worst: string;
  snaps: number;
};

function sportTick(sport: string, now: number): SportStat | null {
  const day = latestDay(sport);
  if (!day) return null;
  const db = new Database(resolve("data", sport, `${day}.db`), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const live = db.prepare(`SELECT id, t FROM ev WHERE e = 0`).all() as Array<{
      id: string;
      t: string;
    }>;
    const snaps = (db.prepare(`SELECT COUNT(*) n FROM ob`).get() as { n: number }).n;
    let fresh = 0;
    let stale = 0;
    let maxAge = 0;
    let worst = "";
    for (const ev of live) {
      const hi = db.prepare(`SELECT MAX(ts) hi FROM ob WHERE eid = ?`).get(ev.id) as {
        hi: number | null;
      };
      const age = hi.hi != null ? Math.round((now - hi.hi) / 1000) : 99999;
      if (age <= STALE_S) fresh++;
      else stale++;
      if (age > maxAge) {
        maxAge = age;
        worst = ev.t.slice(0, 36);
      }
    }
    return { sport, open: live.length, fresh, stale, maxAge, worst, snaps };
  } finally {
    db.close();
  }
}

function tick() {
  const now = Date.now();
  const stats: SportStat[] = [];
  let totalSnaps = 0;
  for (const sport of SPORTS) {
    const s = sportTick(sport, now);
    if (!s) {
      log(`${sport}: nodb`);
      continue;
    }
    stats.push(s);
    totalSnaps += s.snaps;
    log(
      `${sport}: open=${s.open} fresh=${s.fresh} stale=${s.stale} maxAge=${s.maxAge}s snaps=${s.snaps}` +
        (s.worst ? ` worst=${s.worst}` : "")
    );

    // Active live boards shouldn't all go silent.
    if (s.sport === "soccer" && s.open > 0 && s.fresh === 0 && s.maxAge > 90) {
      note(`soccer capture dead — all ${s.open} open stale maxAge=${s.maxAge}s`);
    }
    if (s.sport === "soccer" && s.stale > 0 && s.stale >= Math.ceil(s.open * 0.5) && s.maxAge > 120) {
      note(`soccer >50% stale (${s.stale}/${s.open}) maxAge=${s.maxAge}s`);
    }
    // Orphans: open tennis/weather with ancient books and no monitor interest.
    if (
      (s.sport === "tennis" || s.sport === "weather") &&
      s.open > 0 &&
      s.fresh === 0 &&
      s.maxAge > 3600
    ) {
      note(`${s.sport} ${s.open} e=0 orphans maxAge=${s.maxAge}s (not scrubbed)`);
    }
  }

  const delta = totalSnaps - lastSnaps;
  if (lastSnaps > 0 && delta === 0) {
    stallTicks++;
    if (stallTicks >= 4) note(`global snap stall — 0 new snaps for ${stallTicks * 30}s`);
  } else {
    stallTicks = 0;
  }
  lastSnaps = totalSnaps;

  const wss = readMonitorLine();
  log(`wss ${wss} | snapΔ=${delta}`);
  if (/WSS DOWN/.test(wss) && stats.some((s) => s.sport === "soccer" && s.open > 0)) {
    note(`monitor reports ${wss}`);
  }
}

log(`logging to ${OUT}`);
tick();
const started = Date.now();
const timer = setInterval(() => {
  try {
    tick();
  } catch (err) {
    note(`tick: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (Date.now() - started >= DURATION_MS) {
    clearInterval(timer);
    log("--- summary ---");
    log(`duration_s=${Math.round((Date.now() - started) / 1000)}`);
    const uniq = [...new Set(issues.map((i) => i.replace(/^\[.*?\] /, "")))];
    log(`issue_events=${issues.length} unique=${uniq.length}`);
    for (const u of uniq.slice(0, 30)) log(`  ${u}`);
    if (uniq.length > 30) log(`  … +${uniq.length - 30} more`);
    log("watch done");
    process.exit(0);
  }
}, EVERY_MS);

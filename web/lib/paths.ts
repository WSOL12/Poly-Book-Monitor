import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

export type Sport = "soccer" | "football" | "mlb" | "weather" | "tennis";

export const SPORTS: Sport[] = ["soccer", "football", "mlb", "weather", "tennis"];

export const PROJECT_ROOT = process.env.MONITOR_ROOT
  ? resolve(process.env.MONITOR_ROOT)
  : resolve(process.cwd(), "..");

export const DATA_DIR = process.env.DATA_DIR ?? resolve(PROJECT_ROOT, "data");

/** data/mlb */
export function sportDir(sport: Sport) {
  return resolve(DATA_DIR, sport);
}

/** data/mlb/2026-09.db */
export function dbPathForMonth(sport: Sport, month: string) {
  return resolve(sportDir(sport), `${month}.db`);
}

/** @deprecated alias — shard key is YYYY-MM */
export function dbPathForDay(sport: Sport, dayOrMonth: string) {
  const month = /^\d{4}-\d{2}-\d{2}$/.test(dayOrMonth) ? dayOrMonth.slice(0, 7) : dayOrMonth;
  return dbPathForMonth(sport, month);
}

/** data/mlb/_idx.db */
export function idxPathForSport(sport: Sport) {
  return resolve(sportDir(sport), "_idx.db");
}

/** List monthly shard keys (YYYY-MM), newest first. Also accepts legacy daily files. */
export function listMonthFiles(sport: Sport): string[] {
  const dir = sportDir(sport);
  if (!existsSync(dir)) return [];
  const months = new Set<string>();
  for (const name of readdirSync(dir)) {
    const monthly = /^(\d{4}-\d{2})\.db$/.exec(name);
    if (monthly) {
      months.add(monthly[1]!);
      continue;
    }
    const daily = /^(\d{4}-\d{2})-\d{2}\.db$/.exec(name);
    if (daily) months.add(daily[1]!);
  }
  return [...months].sort().reverse();
}

/** @deprecated use listMonthFiles */
export function listDayFiles(sport: Sport): string[] {
  return listMonthFiles(sport);
}

/** @deprecated */
export const DB_PATH = process.env.DB_PATH ?? resolve(DATA_DIR, "monitoring.db");

export const LINKS_PATH = process.env.LINKS_PATH ?? resolve(PROJECT_ROOT, "data", "live-links.json");

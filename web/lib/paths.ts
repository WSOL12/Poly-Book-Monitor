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

/** data/mlb/2026-09-16.db */
export function dbPathForDay(sport: Sport, day: string) {
  return resolve(sportDir(sport), `${day}.db`);
}

/** data/mlb/_idx.db */
export function idxPathForSport(sport: Sport) {
  return resolve(sportDir(sport), "_idx.db");
}

export function listDayFiles(sport: Sport): string[] {
  const dir = sportDir(sport);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.db$/.test(name))
    .map((name) => name.slice(0, 10))
    .sort()
    .reverse();
}

/** @deprecated */
export const DB_PATH = process.env.DB_PATH ?? resolve(DATA_DIR, "monitoring.db");

export const LINKS_PATH = process.env.LINKS_PATH ?? resolve(PROJECT_ROOT, "data", "live-links.json");

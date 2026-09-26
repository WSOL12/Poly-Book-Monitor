import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

function loadDotEnv() {
  const path = resolve(process.cwd(), ".env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] == null) process.env[key] = value;
  }
}

loadDotEnv();

export const SPORTS = ["soccer", "football", "mlb", "weather", "tennis"] as const;
export type EnvSport = (typeof SPORTS)[number];

export const DATA_DIR = process.env.DATA_DIR ?? resolve(process.cwd(), "data");

/** data/mlb */
export function sportDir(sport: EnvSport) {
  return resolve(DATA_DIR, sport);
}

/** UTC calendar month key, e.g. 2026-09 */
export function utcMonth(ms = Date.now()) {
  return new Date(ms).toISOString().slice(0, 7);
}

/** data/mlb/2026-09.db */
export function dbPathForMonth(sport: EnvSport, month: string) {
  return resolve(sportDir(sport), `${month}.db`);
}

/** data/mlb/_idx.db — event/token → month map */
export function idxPathForSport(sport: EnvSport) {
  return resolve(sportDir(sport), "_idx.db");
}

/** @deprecated use utcMonth */
export function utcDay(ms = Date.now()) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** @deprecated use dbPathForMonth */
export function dbPathForDay(sport: EnvSport, dayOrMonth: string) {
  const month = /^\d{4}-\d{2}-\d{2}$/.test(dayOrMonth) ? dayOrMonth.slice(0, 7) : dayOrMonth;
  return dbPathForMonth(sport, month);
}

/** Ensure data dirs exist (download / dashboard). */
export function ensureDataDirs() {
  mkdirSync(DATA_DIR, { recursive: true });
  for (const sport of SPORTS) mkdirSync(sportDir(sport), { recursive: true });
}

/** @deprecated */
export const DB_PATH = process.env.DB_PATH ?? resolve(DATA_DIR, "monitoring.db");

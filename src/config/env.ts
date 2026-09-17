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

export const SPORTS = ["soccer", "football", "mlb", "weather"] as const;
export type EnvSport = (typeof SPORTS)[number];

export const DATA_DIR = process.env.DATA_DIR ?? resolve(process.cwd(), "data");

/** data/mlb */
export function sportDir(sport: EnvSport) {
  return resolve(DATA_DIR, sport);
}

/** data/mlb/2026-09-16.db */
export function dbPathForDay(sport: EnvSport, day: string) {
  return resolve(sportDir(sport), `${day}.db`);
}

/** data/mlb/_idx.db — event/token → day map */
export function idxPathForSport(sport: EnvSport) {
  return resolve(sportDir(sport), "_idx.db");
}

export function utcDay(ms = Date.now()) {
  return new Date(ms).toISOString().slice(0, 10);
}

export const CATALOG_REFRESH_MS = Number(process.env.CATALOG_REFRESH_MS ?? 30_000);
export const CONSOLE_REFRESH_MS = Number(process.env.CONSOLE_REFRESH_MS ?? 2_000);
export const WEATHER_ARM_PRICE = Number(process.env.WEATHER_ARM_PRICE ?? 0.6);

/** @deprecated */
export const DB_PATH = process.env.DB_PATH ?? resolve(DATA_DIR, "monitoring.db");

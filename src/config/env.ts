import { existsSync, readFileSync } from "node:fs";
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

export const CATALOG_REFRESH_MS = Number(process.env.CATALOG_REFRESH_MS ?? 30_000);
export const CONSOLE_REFRESH_MS = Number(process.env.CONSOLE_REFRESH_MS ?? 2_000);
/** Weather: start orderbook recording once any Yes bucket hits this price (0.60 = 60¢). */
export const WEATHER_ARM_PRICE = Number(process.env.WEATHER_ARM_PRICE ?? 0.6);
export const DB_PATH = process.env.DB_PATH ?? resolve(process.cwd(), "data", "monitoring.db");

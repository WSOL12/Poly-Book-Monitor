import { resolve } from "node:path";

export const PROJECT_ROOT = process.env.MONITOR_ROOT
  ? resolve(process.env.MONITOR_ROOT)
  : resolve(process.cwd(), "..");

export const DB_PATH = process.env.DB_PATH ?? resolve(PROJECT_ROOT, "data", "monitoring.db");
export const LINKS_PATH = process.env.LINKS_PATH ?? resolve(PROJECT_ROOT, "data", "live-links.json");

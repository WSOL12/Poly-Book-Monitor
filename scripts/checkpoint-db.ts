/**
 * Flush per-sport / per-day WAL files.
 *
 *   npx tsx scripts/checkpoint-db.ts
 */
import { existsSync } from "node:fs";
import { openDb, listDayFiles } from "../src/db/store.ts";
import { SPORTS, dbPathForDay, idxPathForSport } from "../src/config/env.ts";

function sizeLabel(bytes: number) {
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(2)} TB`;
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${bytes} B`;
}

function fileSize(path: string) {
  if (!existsSync(path)) return 0;
  return Number(process.getBuiltinModule("fs").statSync(path).size);
}

function checkpoint(path: string, label: string) {
  console.log(`\n=== ${label} ===`);
  console.log("DB ", path, sizeLabel(fileSize(path)));
  console.log("WAL", sizeLabel(fileSize(`${path}-wal`)));
  if (!existsSync(path)) {
    console.log("skip (missing)");
    return;
  }
  const db = openDb(path);
  try {
    console.log("result", db.pragma("wal_checkpoint(TRUNCATE)"));
  } finally {
    db.close();
  }
  console.log("After DB ", sizeLabel(fileSize(path)), "WAL", sizeLabel(fileSize(`${path}-wal`)));
}

for (const sport of SPORTS) {
  checkpoint(idxPathForSport(sport), `${sport}/_idx`);
  for (const day of listDayFiles(sport)) {
    checkpoint(dbPathForDay(sport, day), `${sport}/${day}`);
  }
}

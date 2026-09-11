/**
 * Flush monitoring.db-wal into monitoring.db and shrink the WAL on disk.
 *
 * Stop `npm run monitor` and the Next.js dashboard first, or TRUNCATE may fail
 * while other connections hold the DB open.
 *
 *   npx tsx scripts/checkpoint-db.ts
 */
import { existsSync } from "node:fs";
import { openDb, checkpointDb } from "../src/db/store.ts";
import { DB_PATH } from "../src/config/env.ts";

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

const walPath = `${DB_PATH}-wal`;
const shmPath = `${DB_PATH}-shm`;

console.log("DB ", DB_PATH, sizeLabel(fileSize(DB_PATH)));
console.log("WAL", walPath, sizeLabel(fileSize(walPath)));
console.log("SHM", shmPath, sizeLabel(fileSize(shmPath)));
console.log("Running wal_checkpoint(TRUNCATE)…");

const db = openDb();
try {
  const before = db.pragma("wal_checkpoint(TRUNCATE)") as Array<{
    busy: number;
    log: number;
    checkpointed: number;
  }>;
  console.log("result", before);
} finally {
  db.close();
}

console.log("After:");
console.log("DB ", sizeLabel(fileSize(DB_PATH)));
console.log("WAL", sizeLabel(fileSize(walPath)));
console.log("SHM", sizeLabel(fileSize(shmPath)));

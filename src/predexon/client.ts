/**
 * Predexon authenticated client — rate-limited lanes + multi-key round-robin.
 * Pattern from compare-poly-predict history-download (https://docs.predexon.com/).
 */
import { httpGet, sleep } from "./http.ts";

export const PREDEXON_API = "https://api.predexon.com";

export type PredexonClientOptions = {
  apiKeys: string[];
  /** Pause between HTTP call starts on one key×lane (ms). Free ≈1100; Pro ≈10–15. */
  requestDelayMs: number;
};

const lastRequestAtByLane = new Map<string, number>();
const laneLocks = new Map<string, Promise<void>>();
let nextKeyIndex = 0;

function nextApiKey(opts: PredexonClientOptions): { key: string; keyIndex: number } {
  const keyIndex = nextKeyIndex++ % opts.apiKeys.length;
  return { key: opts.apiKeys[keyIndex]!, keyIndex };
}

async function acquireRequestSlot(lane: string, delayMs: number): Promise<void> {
  const prev = laneLocks.get(lane) ?? Promise.resolve();
  let unlock!: () => void;
  laneLocks.set(
    lane,
    new Promise<void>((resolve) => {
      unlock = resolve;
    }),
  );
  await prev;
  const now = Date.now();
  const slot = Math.max(now, lastRequestAtByLane.get(lane) ?? 0);
  lastRequestAtByLane.set(lane, slot + delayMs);
  unlock();
  const wait = slot - Date.now();
  if (wait > 0) await sleep(wait);
}

export function parseApiKeysFromEnv(): string[] {
  const fromList = (process.env.PREDEXON_API_KEYS ?? "")
    .split(/[,;\s]+/)
    .map((k) => k.trim())
    .filter(Boolean);
  const singles = [
    process.env.PREDEXON_API_KEY ?? "",
    process.env.PREDEXON_API_KEY_2 ?? "",
    process.env.PREDEXON_API_KEY_3 ?? "",
  ]
    .map((k) => k.trim())
    .filter(Boolean);
  const keys = [...new Set([...fromList, ...singles])];
  if (keys.length === 0) {
    throw new Error(
      "Set PREDEXON_API_KEY in .env (https://dashboard.predexon.com). Optional: PREDEXON_API_KEY_2 / PREDEXON_API_KEYS.",
    );
  }
  return keys;
}

/** Mask for logs: `pk_ab…wxyz` (never print full secrets). */
export function maskApiKey(key: string): string {
  if (key.length <= 10) return "***";
  return `${key.slice(0, 5)}…${key.slice(-4)}`;
}

export async function predexonGet(
  opts: PredexonClientOptions,
  pathAndQuery: string,
  laneName = "default",
): Promise<unknown> {
  const { key, keyIndex } = nextApiKey(opts);
  const lane = `k${keyIndex}:${laneName}`;
  await acquireRequestSlot(lane, opts.requestDelayMs);
  const url = `${PREDEXON_API}${pathAndQuery}`;
  const response = await httpGet(url, { "x-api-key": key });
  if (response.status === 429) {
    await sleep(Math.max(opts.requestDelayMs * 10, 500));
    await acquireRequestSlot(lane, opts.requestDelayMs);
    const retry = await httpGet(url, { "x-api-key": key });
    if (retry.status !== 200) {
      throw new Error(`Predexon HTTP ${retry.status}: ${retry.text.slice(0, 200)}`);
    }
    return JSON.parse(retry.text) as unknown;
  }
  if (response.status !== 200) {
    throw new Error(`Predexon HTTP ${response.status}: ${response.text.slice(0, 300)}`);
  }
  return JSON.parse(response.text) as unknown;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

export function asString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

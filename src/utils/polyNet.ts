export const POLY_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
  accept: "application/json",
  origin: "https://polymarket.com",
  referer: "https://polymarket.com/",
};

/** Cap concurrent HTTP so Gamma catalog dumps can't starve WSS handshakes. */
const MAX_INFLIGHT = 6;
let inflight = 0;
const waiters: Array<() => void> = [];

function acquire(): Promise<void> {
  if (inflight < MAX_INFLIGHT) {
    inflight++;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    waiters.push(() => {
      inflight++;
      resolve();
    });
  });
}

function release() {
  inflight = Math.max(0, inflight - 1);
  const next = waiters.shift();
  if (next) next();
}

export async function polyFetch(url: string, timeoutMs = 30_000) {
  await acquire();
  try {
    return await fetch(url, {
      headers: POLY_HEADERS,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } finally {
    release();
  }
}

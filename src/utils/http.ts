/** Lightweight fetch with retries (Gamma + misc). */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function httpGetJson<T = unknown>(
  url: string,
  opts?: { timeoutMs?: number; headers?: Record<string, string> },
): Promise<T> {
  const timeoutMs = opts?.timeoutMs ?? 30_000;
  let waitMs = 400;
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          accept: "application/json",
          "user-agent": "poly-book-monitor/0.3",
          ...opts?.headers,
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        await sleep(waitMs);
        waitMs *= 2;
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return (await res.json()) as T;
    } catch (error) {
      lastError = error;
      if (attempt === 3) break;
      await sleep(waitMs);
      waitMs *= 2;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

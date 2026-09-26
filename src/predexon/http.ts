const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function httpGet(
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; text: string; finalUrl: string }> {
  let waitMs = 500;
  let lastError: unknown;

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          accept: "application/json, text/html;q=0.9, */*;q=0.8",
          "user-agent": USER_AGENT,
          ...headers,
        },
        signal: AbortSignal.timeout(45_000),
      });

      if ((response.status === 429 || response.status >= 500) && attempt < 4) {
        await sleep(waitMs);
        waitMs *= 2;
        continue;
      }

      return {
        status: response.status,
        text: await response.text(),
        finalUrl: response.url,
      };
    } catch (error) {
      lastError = error;
      if (attempt === 4) break;
      await sleep(waitMs);
      waitMs *= 2;
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`request failed for ${url}: ${message}`);
}

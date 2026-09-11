export const POLY_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
  accept: "application/json",
  origin: "https://polymarket.com",
  referer: "https://polymarket.com/",
};

export async function polyFetch(url: string, timeoutMs = 30_000) {
  return fetch(url, {
    headers: POLY_HEADERS,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

async function tryUrl(label: string, url: string) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  const text = await res.text();
  let n = 0;
  let sample = "";
  try {
    const j = JSON.parse(text) as Array<{ title?: string; startTime?: string; endDate?: string }>;
    n = Array.isArray(j) ? j.length : 0;
    const first = j[0];
    sample = `${first?.endDate ?? first?.startTime ?? ""} | ${(first?.title ?? "").slice(0, 70)}`;
  } catch {
    sample = text.slice(0, 160);
  }
  console.log(`${label}\n  HTTP ${res.status} n=${n}\n  ${sample}\n`);
}

await tryUrl(
  "soccer closed newest",
  "https://gamma-api.polymarket.com/events?closed=true&limit=3&offset=0&tag_slug=soccer&order=endDate&ascending=false",
);
await tryUrl(
  "soccer end_date_min",
  "https://gamma-api.polymarket.com/events?closed=true&limit=3&tag_slug=soccer&order=endDate&ascending=false&end_date_min=2026-09-01T00:00:00Z",
);
await tryUrl(
  "soccer endDateMin",
  "https://gamma-api.polymarket.com/events?closed=true&limit=3&tag_slug=soccer&order=endDate&ascending=false&endDateMin=2026-09-01T00:00:00Z",
);
await tryUrl(
  "soccer ascending oldest endDate",
  "https://gamma-api.polymarket.com/events?closed=true&limit=5&offset=0&tag_slug=soccer&order=endDate&ascending=true",
);
await tryUrl(
  "offset 1990",
  "https://gamma-api.polymarket.com/events?closed=true&limit=50&offset=1990&tag_slug=soccer&order=endDate&ascending=false",
);
await tryUrl(
  "offset 2000",
  "https://gamma-api.polymarket.com/events?closed=true&limit=50&offset=2000&tag_slug=soccer&order=endDate&ascending=false",
);
await tryUrl(
  "offset 2050",
  "https://gamma-api.polymarket.com/events?closed=true&limit=50&offset=2050&tag_slug=soccer&order=endDate&ascending=false",
);

// day-bucket via slug search?
await tryUrl(
  "soccer search Sept 10",
  "https://gamma-api.polymarket.com/public-search?q=2026-09-10&limit_per_type=10",
);

// Try events with end_date_max / between
for (const q of [
  "end_date_max=2026-09-10T23:59:59Z&end_date_min=2026-09-10T00:00:00Z",
  "endDate_max=2026-09-10&endDate_min=2026-09-10",
  "end_date=2026-09-10",
]) {
  await tryUrl(
    `soccer filter ${q}`,
    `https://gamma-api.polymarket.com/events?closed=true&limit=5&tag_slug=soccer&order=endDate&ascending=false&${q}`,
  );
}

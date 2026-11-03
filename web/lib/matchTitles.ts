/**
 * Fuzzy title match helpers — link Predict.Fun events to Polymarket events.
 * Requires both opponents (around "vs") to align; single-name overlaps score 0.
 */

const STOP = new Set([
  "the",
  "and",
  "fc",
  "cf",
  "sc",
  "afc",
  "united",
  "city",
  "open",
  "cup",
  "tour",
  "atp",
  "wta",
  "mlb",
  "nba",
  "nfl",
  "nhl",
  "map",
  "game",
  "set",
  "winner",
  "moneyline",
]);

export function normalizeMatchTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\b(map handicap|game spread|set handicap|set \d+|o\/u|over\/under|moneyline|winner|vs\.?|versus)\b/g, (m) =>
      /vs/i.test(m) ? " vs " : " "
    )
    .replace(/^[^:]+:\s*/, " ") // drop "China Open: "
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Significant tokens, prefer surnames / team words. */
export function titleTokens(title: string): string[] {
  return normalizeMatchTitle(title)
    .split(" ")
    .filter((t) => t.length >= 3 && !STOP.has(t));
}

/** Split "A vs B" (after stripping tournament prefix). */
export function matchSides(title: string): [string, string] | null {
  const raw = title.toLowerCase().replace(/^[^:]+:\s*/, " ").trim();
  const parts = raw.split(/\s+vs\.?\s+|\s+versus\s+/i);
  if (parts.length !== 2) return null;
  const a = parts[0]!.replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  const b = parts[1]!.replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  if (!a || !b) return null;
  return [a, b];
}

/** Surname / last word, title-cased — "jaime faria" → "Faria". */
export function sideDisplayName(side: string): string {
  const parts = side
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const last = parts[parts.length - 1] ?? side.trim();
  if (!last) return side.trim();
  return last.charAt(0).toUpperCase() + last.slice(1).toLowerCase();
}

/**
 * Predict.fun tennis (and other binary match) books are Yes/No on a "A vs B" title.
 * Yes = first named player, No = second. Returns [home, away] display names.
 */
export function pfMatchPlayerLabels(question: string): [string, string] | null {
  const sides = matchSides(question);
  if (!sides) return null;
  return [sideDisplayName(sides[0]), sideDisplayName(sides[1])];
}

function sideKeyTokens(side: string): string[] {
  return side
    .split(" ")
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !STOP.has(t));
}

/** True when two side strings name the same team/player (last-token / overlap). */
export function sideOverlap(a: string, b: string): number {
  const ta = new Set(sideKeyTokens(a));
  const tb = new Set(sideKeyTokens(b));
  if (!ta.size || !tb.size) return 0;
  let hit = 0;
  for (const t of ta) if (tb.has(t)) hit++;
  // Prefer surname / last word match for tennis names.
  const lastA = a.split(" ").filter(Boolean).pop() ?? "";
  const lastB = b.split(" ").filter(Boolean).pop() ?? "";
  if (lastA.length >= 4 && lastA === lastB) return Math.max(hit / Math.max(ta.size, tb.size), 0.85);
  return hit / Math.max(ta.size, tb.size);
}

function tournamentHint(a: string, b: string): number {
  const ha = /^([^:]+):/.exec(a)?.[1]?.toLowerCase().trim() ?? "";
  const hb = /^([^:]+):/.exec(b)?.[1]?.toLowerCase().trim() ?? "";
  if (!ha || !hb) return 0;
  const na = ha.replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  const nb = hb.replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  if (!na || !nb) return 0;
  if (na === nb) return 0.15;
  const ta = new Set(na.split(" ").filter((t) => t.length >= 3));
  const tb = new Set(nb.split(" ").filter((t) => t.length >= 3));
  let hit = 0;
  for (const t of ta) if (tb.has(t)) hit++;
  if (hit >= 1 && hit / Math.max(ta.size, tb.size) >= 0.5) return 0.1;
  return 0;
}

function tournamentConflict(a: string, b: string): boolean {
  const ha = /^([^:]+):/.exec(a)?.[1]?.toLowerCase().trim() ?? "";
  const hb = /^([^:]+):/.exec(b)?.[1]?.toLowerCase().trim() ?? "";
  if (!ha || !hb) return false;
  const scrub = (s: string) =>
    s
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\b(open|cup|tour|championships?|qualification|doubles)\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const na = scrub(ha);
  const nb = scrub(hb);
  if (!na || !nb || na === nb) return false;
  // Keep short tokens (us, wta, atp, mlb) — they distinguish tournaments.
  const ta = new Set(na.split(" ").filter((t) => t.length >= 2));
  const tb = new Set(nb.split(" ").filter((t) => t.length >= 2));
  if (!ta.size || !tb.size) return false;
  let hit = 0;
  for (const t of ta) if (tb.has(t)) hit++;
  return hit === 0; // e.g. "china" vs "us wta"
}

/**
 * Score overlap for the same fixture (0–1).
 * For "A vs B" titles both opponents must match (order-invariant); otherwise 0.
 * Weather: require same city (+ soft date tokens).
 */
export function titleSimilarity(a: string, b: string): number {
  const sa = matchSides(a);
  const sb = matchSides(b);
  if (sa && sb) {
    const same = Math.min(sideOverlap(sa[0], sb[0]), sideOverlap(sa[1], sb[1]));
    const swap = Math.min(sideOverlap(sa[0], sb[1]), sideOverlap(sa[1], sb[0]));
    const best = Math.max(same, swap);
    if (best < 0.55) return 0;
    if (tournamentConflict(a, b)) return 0; // same players, different tournament
    return Math.min(1, best * 0.8 + tournamentHint(a, b) + 0.12);
  }

  const weatherA = /highest\s+temp|temperature\s+in\s+/i.test(a);
  const weatherB = /highest\s+temp|temperature\s+in\s+/i.test(b);
  if (weatherA || weatherB) {
    if (!weatherA || !weatherB) return 0;
    const city = (t: string) => {
      const m =
        /temperature\s+in\s+(.+?)\s+on\s+/i.exec(t) ??
        /highest\s+temp(?:erature)?\s+in\s+(.+?)(?:\s+on\s+|\?|$)/i.exec(t);
      return (m?.[1] ?? "")
        .toLowerCase()
        .replace(/\(.*?\)/g, " ")
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    };
    const ca = city(a);
    const cb = city(b);
    if (!ca || !cb) return 0;
    if (ca === cb) return 0.92;
    // multi-word: "buenos aires" vs "buenos aires (ezeiza)"
    if (ca.includes(cb) || cb.includes(ca)) return 0.88;
    const ta = new Set(ca.split(" ").filter((t) => t.length >= 3));
    const tb = new Set(cb.split(" ").filter((t) => t.length >= 3));
    let hit = 0;
    for (const t of ta) if (tb.has(t)) hit++;
    if (!hit) return 0;
    return hit / Math.max(ta.size, tb.size) >= 0.6 ? 0.8 : 0;
  }

  // Non-vs titles (props): token Jaccard only.
  const ta = new Set(titleTokens(a));
  const tb = new Set(titleTokens(b));
  if (!ta.size || !tb.size) return 0;
  let hit = 0;
  for (const t of ta) if (tb.has(t)) hit++;
  return hit / Math.max(ta.size, tb.size);
}

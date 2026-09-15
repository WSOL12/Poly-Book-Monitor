/** Polymarket soccer slug prefixes → short league labels. */
const LEAGUE_LABELS: Record<string, string> = {
  ucl: "UCL",
  uwcl: "UWCL",
  uel: "UEL",
  uecl: "UECL",
  epl: "EPL",
  eng: "EPL",
  bun: "Bundesliga",
  bundesliga: "Bundesliga",
  sea: "Serie A",
  "serie-a": "Serie A",
  lal: "La Liga",
  "la-liga": "La Liga",
  fl1: "Ligue 1",
  "ligue-1": "Ligue 1",
  ere: "Eredivisie",
  eredivisie: "Eredivisie",
  mls: "MLS",
  liga: "Liga MX",
  "liga-mx": "Liga MX",
  lec: "Liga MX",
  kor: "K League",
  j1: "J1 League",
  j2: "J2 League",
  "j-league": "J League",
  "japan-j-league": "J League",
  "japan-j1-league": "J1 League",
  "japan-j2-league": "J2 League",
  bra: "Brasileirão",
  bra2: "Brasileirão B",
  brco: "Copa do Brasil",
  chi1: "Chile Primera",
  col1: "Colombia Primera",
  sud: "Copa Sudamericana",
  lib: "Copa Libertadores",
  scop: "Scottish Prem",
  elc: "EFL Championship",
  el1: "EFL League One",
  el2: "EFL League Two",
  dfb: "DFB-Pokal",
  den: "Danish Superliga",
  cze1: "Czech First League",
  grc: "Greek Super League",
  egy1: "Egyptian Premier",
  itc: "Coppa Italia",
  mlb: "MLB",
  nfl: "NFL",
  ncaaf: "NCAAF",
  kbo: "KBO",
  npb: "NPB",
};

const SKIP_TAG = new Set([
  "sports",
  "games",
  "soccer",
  "football",
  "mlb",
  "baseball",
  "weather",
  "crypto",
  "politics",
  "pop-culture",
]);

export function slugLeagueCode(slug?: string | null): string | null {
  if (!slug) return null;
  const head = slug.trim().toLowerCase().split("-")[0];
  return head || null;
}

export function leagueLabel(code?: string | null, fallback = "Other"): string {
  if (!code) return fallback;
  const key = code.trim().toLowerCase();
  if (LEAGUE_LABELS[key]) return LEAGUE_LABELS[key]!;
  if (key.length <= 5) return key.toUpperCase();
  return key
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Prefer short slug-code labels (UCL, EPL); fall back to stored Gamma league. */
export function resolveLeague(opts: {
  sport?: string | null;
  slug?: string | null;
  league?: string | null;
}): { code: string; label: string } {
  if (opts.sport === "weather") return { code: "weather", label: "Weather" };
  if (opts.sport === "mlb") return { code: "mlb", label: "MLB" };

  const code = slugLeagueCode(opts.slug) ?? opts.sport ?? "other";
  if (LEAGUE_LABELS[code]) return { code, label: LEAGUE_LABELS[code]! };

  const stored = opts.league?.trim();
  if (stored) return { code, label: stored };

  return { code, label: leagueLabel(code) };
}

export function leagueFromGamma(opts: {
  series?: Array<{ title?: string | null; slug?: string | null }> | null;
  seriesSlug?: string | null;
  tags?: Array<{ label?: string | null; slug?: string | null }> | null;
  slug?: string | null;
}): string | null {
  const seriesTitle = opts.series?.[0]?.title?.trim();
  if (seriesTitle) {
    return seriesTitle.replace(/\s+20\d{2}\s*$/, "").trim() || seriesTitle;
  }
  const seriesSlug = opts.seriesSlug ?? opts.series?.[0]?.slug;
  if (seriesSlug) {
    const code = seriesSlug.replace(/-20\d{2}$/, "");
    if (LEAGUE_LABELS[code]) return LEAGUE_LABELS[code]!;
  }
  for (const tag of opts.tags ?? []) {
    const slug = tag.slug?.trim().toLowerCase() ?? "";
    if (!slug || SKIP_TAG.has(slug)) continue;
    if (LEAGUE_LABELS[slug]) return LEAGUE_LABELS[slug]!;
    if (tag.label?.trim()) return tag.label.trim();
  }
  const code = slugLeagueCode(opts.slug);
  return code ? leagueLabel(code) : null;
}

export function formatVolume(n?: number | null): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return "—";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return `$${Math.round(n)}`;
}

const LEAGUE_COLORS = [
  "#59a1ff",
  "#3dd68c",
  "#f5a524",
  "#ff7a59",
  "#c084fc",
  "#22d3ee",
  "#f472b6",
  "#a3e635",
  "#38bdf8",
  "#fb7185",
];

/** Stable accent color for a league code (for group headers). */
export function leagueAccent(code?: string | null): string {
  const key = (code ?? "other").toLowerCase();
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return LEAGUE_COLORS[Math.abs(h) % LEAGUE_COLORS.length]!;
}

export type LeagueGroup<T> = {
  code: string;
  label: string;
  totalVolume: number;
  events: T[];
};

/** Group matches by league; high-volume leagues first, then high-volume matches. */
export function groupEventsByLeague<
  T extends { sport: string; slug: string; league?: string | null; volume?: number | null },
>(events: T[]): LeagueGroup<T>[] {
  const map = new Map<string, LeagueGroup<T>>();
  for (const event of events) {
    const { code, label } = resolveLeague(event);
    let group = map.get(code);
    if (!group) {
      group = { code, label, totalVolume: 0, events: [] };
      map.set(code, group);
    }
    group.events.push(event);
    group.totalVolume += event.volume ?? 0;
  }
  for (const group of map.values()) {
    group.events.sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0));
  }
  return [...map.values()].sort((a, b) => {
    if (b.totalVolume !== a.totalVolume) return b.totalVolume - a.totalVolume;
    return a.label.localeCompare(b.label);
  });
}

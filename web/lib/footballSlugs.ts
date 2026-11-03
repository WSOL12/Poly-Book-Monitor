/**
 * Predict.fun football slugs look like epl-bou-liv-2026-09-20 (league-home-away-date).
 * Predexon stores outcome labels (BOU/LIV), not "Team A vs Team B", so twin matching
 * must decode codes against Polymarket titles.
 */

const LEAGUE = "epl|lal|fl1|bun|ser|mls|ucl|uel|clf|efl|fif|unl|acle|kbo";

const TEAM_STOP = new Set([
  "fc",
  "cf",
  "sc",
  "afc",
  "the",
  "and",
  "de",
  "club",
  "ac",
  "as",
  "ssc",
  "cd",
  "ud",
  "rc",
  "sv",
  "vfb",
  "tsg",
]);

/** Club leagues / cups — nation ISO codes must not steal MLS/EPL names (POR≠Portland). */
const NATION_LEAGUES = new Set(["unl", "fif"]);

/** Club codes that must not fall through to weak prefix matching. */
const STRICT_CLUB = new Set(["psg", "mun", "mci", "mac", "rea", "rma", "atm", "mad"]);

const CLUB_ALIASES: Record<string, string[]> = {
  mun: ["manchester united"],
  mci: ["manchester city"],
  mac: ["manchester city"],
  psg: ["paris saint-germain", "paris saint germain", "psg"],
  atm: ["atletico", "atlético"],
  mad: ["atletico", "atlético"],
  rea: ["real madrid"],
  rma: ["real madrid"],
  bar: ["barcelona"],
  int: ["inter"],
  juv: ["juventus"],
  nap: ["napoli"],
  bay: ["bayern"],
  dor: ["dortmund"],
  b04: ["leverkusen"],
  s04: ["schalke"],
  tot: ["tottenham"],
  not: ["nottingham"],
  cry: ["crystal palace"],
  whu: ["west ham"],
  new: ["newcastle"],
  bri: ["brighton"],
  wol: ["wolverhampton", "wolves"],
  lei: ["leicester", "leipzig"],
  sou: ["southampton"],
  ips: ["ipswich"],
  hul: ["hull"],
  cov: ["coventry"],
  sun: ["sunderland"],
  bou: ["bournemouth"],
  bre: ["brentford"],
  ful: ["fulham"],
  eve: ["everton"],
  liv: ["liverpool"],
  ars: ["arsenal"],
  che: ["chelsea"],
  ast: ["aston villa"],
  olm: ["marseille"],
};

const NATION_ALIASES: Record<string, string[]> = {
  alb: ["albania"],
  bela: ["belarus"],
  bel: ["belgium"],
  bul: ["bulgaria"],
  lux: ["luxembourg"],
  far: ["faroe"],
  kaz: ["kazakhstan"],
  swe: ["sweden"],
  rom: ["romania"],
  mon: ["montenegro"],
  cyp: ["cyprus"],
  hun: ["hungary"],
  ukr: ["ukraine"],
  ita: ["italy"],
  geo: ["georgia"],
  nir: ["northern ireland"],
  arm: ["armenia"],
  lat: ["latvia"],
  nor: ["norway"],
  den: ["denmark"],
  lie: ["liechtenstein"],
  lit: ["lithuania"],
  and: ["andorra"],
  mal: ["malta"],
  nld: ["netherlands"],
  ger: ["germany"],
  grc: ["greece"],
  ser: ["serbia"],
  spa: ["spain"],
  eng: ["england"],
  fra: ["france"],
  por: ["portugal"],
  sco: ["scotland"],
  wal: ["wales"],
  ire: ["ireland", "republic of ireland"],
  arg: ["argentina"],
  bra: ["brazil"],
  uru: ["uruguay"],
  mex: ["mexico"],
  usa: ["united states", "usa"],
  can: ["canada"],
  jpn: ["japan"],
  kor: ["korea"],
  aus: ["australia"],
  ind: ["india"],
  pan: ["panama"],
  bur: ["burkina"],
};

export type FootballSlugParts = {
  league: string;
  home: string;
  away: string;
  date: string;
  slug: string;
};

export function parseFootballSlug(slugOrId: string): FootballSlugParts | null {
  let s = slugOrId.trim().toLowerCase();
  if (s.startsWith("pf:")) s = s.slice(3);
  s = s.replace(/-(more-markets|exact-score|total-corners|corners)$/i, "");
  const re = new RegExp(
    `^(${LEAGUE})-([a-z0-9]{2,5})-([a-z0-9]{2,5})-(\\d{4}-\\d{2}-\\d{2})$`,
  );
  const m = re.exec(s);
  if (!m) return null;
  return { league: m[1]!, home: m[2]!, away: m[3]!, date: m[4]!, slug: s };
}

export function isFootballSlugEvent(eventIdOrSlug: string): boolean {
  return parseFootballSlug(eventIdOrSlug) != null;
}

function significantTokens(team: string): string[] {
  return team
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !TEAM_STOP.has(t));
}

function aliasHit(aliases: string[] | undefined, name: string): boolean {
  if (!aliases) return false;
  return aliases.some((a) => name.includes(a));
}

function fold(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** 0 = no match, higher = better. */
export function abbrevScore(code: string, teamName: string, league?: string): number {
  const c = code.toLowerCase();
  if (c.length < 2) return 0;
  const name = fold(teamName);
  const nationLeague = league != null && NATION_LEAGUES.has(league);

  if (nationLeague) {
    const nat = NATION_ALIASES[c];
    if (nat) return aliasHit(nat.map(fold), name) ? 1 : 0;
  } else if (NATION_ALIASES[c] && !CLUB_ALIASES[c]) {
    // Club fixture: ignore pure nation aliases so POR can match Portland, AUS→Austin.
  }

  const club = CLUB_ALIASES[c];
  if (club) {
    if (aliasHit(club.map(fold), name)) return 1;
    if (STRICT_CLUB.has(c)) return 0;
  }

  const tokens = significantTokens(name);
  if (!tokens.length) return 0;

  for (const t of tokens) {
    if (t === c) return 1;
    if (t.startsWith(c) && c.length >= 3) return 0.95;
    if (c.length >= 3 && t.slice(0, 3) === c) return 0.9;
  }

  if (tokens.length >= 2) {
    const a = tokens[0]![0]! + tokens[1]!.slice(0, 2);
    if (a === c) return 0.92;
    const b = tokens[0]!.slice(0, 2) + tokens[1]![0]!;
    if (b === c) return 0.9;
    const initials = tokens.map((t) => t[0]!).join("");
    if (initials === c) return 0.85;
  }

  if (tokens.join("").startsWith(c) && c.length >= 3) return 0.7;
  return 0;
}

/** True when home/away codes align with an "A vs B" Polymarket title (order-invariant). */
export function footballCodesMatchTitle(
  home: string,
  away: string,
  title: string,
  league?: string,
): boolean {
  const parts = title.split(/\s+vs\.?\s+|\s+versus\s+/i);
  if (parts.length !== 2) return false;
  const s0 = parts[0]!.replace(/^[^:]+:\s*/, "").trim();
  const s1 = parts[1]!.trim();
  const h0 = abbrevScore(home, s0, league);
  const h1 = abbrevScore(home, s1, league);
  const a0 = abbrevScore(away, s0, league);
  const a1 = abbrevScore(away, s1, league);
  const same = h0 > 0 && a1 > 0 ? h0 + a1 : 0;
  const swap = h1 > 0 && a0 > 0 ? h1 + a0 : 0;
  return Math.max(same, swap) >= 1.4;
}

export function footballDisplayTitle(home: string, away: string, polyTitle?: string | null): string {
  if (polyTitle && /\bvs\.?\b/i.test(polyTitle)) {
    return polyTitle.replace(/\s+vs\.\s+/i, " vs ").trim();
  }
  return `${home.toUpperCase()} vs ${away.toUpperCase()}`;
}

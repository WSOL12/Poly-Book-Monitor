export type TeamInfo = {
  name: string;
  alias?: string | null;
  logo?: string | null;
  abbreviation?: string | null;
  ordering?: string | null;
};

export type SetCell = {
  games: number;
  tiebreak?: number;
};

export type ParsedScore = {
  mode: "simple" | "sets";
  homeTotal: number;
  awayTotal: number;
  homeSets: SetCell[];
  awaySets: SetCell[];
};

function parseSetPart(part: string): { home: SetCell; away: SetCell } | null {
  const m = part.trim().match(/^(\d+)-(\d+)(?:\((\d+)-(\d+)\))?$/);
  if (!m) return null;
  const homeGames = Number(m[1]);
  const awayGames = Number(m[2]);
  const home: SetCell = { games: homeGames };
  const away: SetCell = { games: awayGames };
  if (m[3] != null && m[4] != null) {
    home.tiebreak = Number(m[3]);
    away.tiebreak = Number(m[4]);
  }
  return { home, away };
}

export function parseScoreString(score: string | null | undefined): ParsedScore | null {
  if (!score?.trim()) return null;
  const raw = score.trim();
  if (raw.includes(",")) {
    const homeSets: SetCell[] = [];
    const awaySets: SetCell[] = [];
    for (const part of raw.split(",")) {
      const set = parseSetPart(part);
      if (!set) return null;
      homeSets.push(set.home);
      awaySets.push(set.away);
    }
    if (!homeSets.length) return null;
    const last = homeSets.length - 1;
    return {
      mode: "sets",
      homeTotal: homeSets[last]?.games ?? 0,
      awayTotal: awaySets[last]?.games ?? 0,
      homeSets,
      awaySets,
    };
  }
  const simple = raw.match(/^(\d+)-(\d+)$/);
  if (!simple) return null;
  const homeTotal = Number(simple[1]);
  const awayTotal = Number(simple[2]);
  return {
    mode: "simple",
    homeTotal,
    awayTotal,
    homeSets: [{ games: homeTotal }],
    awaySets: [{ games: awayTotal }],
  };
}

/** Compact score for match lists, e.g. "1–1" or "6-4, 3-6, 7-5". */
export function formatScoreLabel(score: string | null | undefined): string | null {
  const parsed = parseScoreString(score);
  if (!parsed) return score?.trim() || null;
  if (parsed.mode === "sets") return score!.trim();
  return `${parsed.homeTotal}–${parsed.awayTotal}`;
}

/** Sports score, weather winning temp, or tennis stop reason. */
export function eventResultLabel(event: {
  sport: string;
  score?: string | null;
  winTemp?: string | null;
  gameStatus?: string | null;
}): string | null {
  if (event.sport === "weather") return event.winTemp?.trim() || null;
  if (event.sport === "tennis") {
    const gs = event.gameStatus?.trim().toLowerCase() ?? "";
    if (gs === "canceled" || gs === "cancelled") return "CANCELED";
    if (gs === "retired") return "RETIRED";
    // Normal finish ("started" stop-reason): show the score, not a STARTED sticker.
  }
  return formatScoreLabel(event.score);
}

function sameTeamName(a: string | null | undefined, b: string | null | undefined) {
  if (!a || !b) return false;
  const na = a.toLowerCase().replace(/[^a-z0-9]/g, "");
  const nb = b.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

export function periodBadge(args: {
  period?: string | null;
  elapsed?: string | null;
  live?: boolean;
  ended?: boolean;
  closed?: boolean;
  /** Tennis stop-reason (retired / canceled) wins over FT/FINAL. */
  gameStatus?: string | null;
}) {
  const gs = args.gameStatus?.trim().toLowerCase() ?? "";
  if (gs === "retired") return "RETIRED";
  if (gs === "canceled" || gs === "cancelled") return "CANCELED";

  const period = args.period?.trim() || "";
  const elapsed = args.elapsed?.trim() || "";
  const finalPeriod = period === "VFT" || period === "FT" || period === "FINAL" || period === "F";
  // Prefer the scrubbed frame's period so early frames don't say FINAL over 0-0.
  if (finalPeriod) return "FINAL";
  if (period) {
    if (elapsed) return `${period} · ${elapsed}`;
    return period;
  }
  if (args.ended || args.closed) return "FINAL";
  if (args.live) return "LIVE";
  return null;
}

/** Left/right follow the event title ("A vs B"), not Gamma home/away. */
export function teamRows(teams: TeamInfo[] | undefined, title: string) {
  const parts = title.split(/ vs\.? /i).map((s) => s.trim());
  const leftName = parts[0] || "Home";
  const rightName = parts[1] || "Away";

  const match = (name: string) =>
    teams?.find(
      (t) =>
        sameTeamName(t.name, name) ||
        sameTeamName(t.alias, name) ||
        sameTeamName(t.abbreviation, name)
    );

  const left = match(leftName);
  const right = match(rightName);

  return {
    home: {
      name: left?.name ?? leftName,
      alias: left?.alias ?? null,
      logo: left?.logo ?? null,
      abbreviation: left?.abbreviation ?? null,
      ordering: left?.ordering ?? "left",
    },
    away: {
      name: right?.name ?? rightName,
      alias: right?.alias ?? null,
      logo: right?.logo ?? null,
      abbreviation: right?.abbreviation ?? null,
      ordering: right?.ordering ?? "right",
    },
  };
}

export function scoreAtTime<T extends { capturedAt: number; score: string | null }>(
  rows: T[],
  atMs: number
): T | null {
  if (!rows.length) return null;
  let best: T | null = null;
  for (const row of rows) {
    if (row.capturedAt <= atMs) best = row;
    else break;
  }
  // Don't invent the first score before it existed — caller can fall back to final.
  return best;
}

export type GoalEvent = {
  capturedAt: number;
  side: "home" | "away";
  /** Match minute from Gamma `elapsed` when present, e.g. "55". */
  minute: string | null;
  period: string | null;
  homeTotal: number;
  awayTotal: number;
};

/**
 * Approximate goals from score snapshot deltas.
 * Polymarket does not publish scorers / official minutes — we use the first
 * tick where the score increases, preferring `elapsed` as the minute.
 */
export function inferGoalsFromHistory(
  rows: Array<{
    capturedAt: number;
    score: string | null;
    period?: string | null;
    elapsed?: string | null;
  }>
): GoalEvent[] {
  const goals: GoalEvent[] = [];
  let prevHome = 0;
  let prevAway = 0;
  let havePrev = false;

  for (const row of rows) {
    const parsed = parseScoreString(row.score);
    if (!parsed || parsed.mode === "sets") continue;
    const { homeTotal, awayTotal } = parsed;
    if (!havePrev) {
      // Opening non-zero score (missed 0-0): count each goal without a minute if needed.
      if (homeTotal > 0 || awayTotal > 0) {
        for (let i = 0; i < homeTotal; i++) {
          goals.push({
            capturedAt: row.capturedAt,
            side: "home",
            minute: i === homeTotal - 1 ? row.elapsed?.trim() || null : null,
            period: row.period?.trim() || null,
            homeTotal: i + 1,
            awayTotal: 0,
          });
        }
        for (let i = 0; i < awayTotal; i++) {
          goals.push({
            capturedAt: row.capturedAt,
            side: "away",
            minute: i === awayTotal - 1 ? row.elapsed?.trim() || null : null,
            period: row.period?.trim() || null,
            homeTotal,
            awayTotal: i + 1,
          });
        }
      }
      prevHome = homeTotal;
      prevAway = awayTotal;
      havePrev = true;
      continue;
    }

    if (homeTotal > prevHome) {
      for (let i = prevHome; i < homeTotal; i++) {
        goals.push({
          capturedAt: row.capturedAt,
          side: "home",
          minute: row.elapsed?.trim() || null,
          period: row.period?.trim() || null,
          homeTotal: i + 1,
          awayTotal,
        });
      }
    }
    if (awayTotal > prevAway) {
      for (let i = prevAway; i < awayTotal; i++) {
        goals.push({
          capturedAt: row.capturedAt,
          side: "away",
          minute: row.elapsed?.trim() || null,
          period: row.period?.trim() || null,
          homeTotal,
          awayTotal: i + 1,
        });
      }
    }
    prevHome = homeTotal;
    prevAway = awayTotal;
  }

  return goals;
}

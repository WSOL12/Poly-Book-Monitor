/**
 * Predict.fun football fixtures split props across event_slug suffixes:
 *   epl-bri-ars-2026-09-19                 → moneyline (BRE/Draw/CHE)
 *   epl-bri-ars-2026-09-19-exact-score      → exact score
 *   epl-bri-ars-2026-09-19-more-markets     → spreads, O/U, BTTS, …
 *   epl-bri-ars-2026-09-19-total-corners    → corners
 */
import {
  listPredictMarkets,
  type ListPredictMarketsOpts,
  type PredictMarket,
} from "../predexon/predictfun.ts";
import type { PredexonClientOptions } from "../predexon/client.ts";
import type { MarketType } from "../types/monitoring.ts";

export const PF_FOOTBALL_PROP_SUFFIXES = [
  "-exact-score",
  "-more-markets",
  "-total-corners",
] as const;

const FOOTBALL_LEAGUE =
  /^(epl|lal|fl1|bun|ser|mls|ucl|uel|clf|efl|fif|unl|acle)-/i;

export function isPfFootballSlug(slugOrId: string): boolean {
  const s = slugOrId.replace(/^pf:/i, "");
  return FOOTBALL_LEAGUE.test(s);
}

/** Strip prop suffixes → parent fixture slug. */
export function pfFootballBaseSlug(slugOrId: string): string {
  let s = slugOrId.trim().replace(/^pf:/i, "");
  for (const suf of PF_FOOTBALL_PROP_SUFFIXES) {
    if (s.endsWith(suf)) return s.slice(0, -suf.length);
  }
  return s;
}

export function pfFootballParentEventId(slugOrId: string): string {
  return `pf:${pfFootballBaseSlug(slugOrId)}`;
}

export function guessPfMarketType(title: string, variant?: string): MarketType {
  const v = (variant ?? "").toUpperCase();
  if (/highest\s+temp/i.test(title) || /temperature\s+in\s+/i.test(title) || /\d+\s*°\s*[CF]\b/i.test(title)) {
    return "weather";
  }
  if (v.includes("EXACT_SCORE") || /any other score|\d+\s*-\s*\d+/i.test(title)) {
    if (/corner/i.test(title)) return "corners";
    return "exact_score";
  }
  if (v.includes("TOTAL_CORNERS") || /corner/i.test(title)) return "corners";
  if (/both teams to score|\bbtts\b/i.test(title)) return "btts";
  if (/halftime|1st half|first half|2nd half|second half/i.test(title)) return "half_result";
  if (/first (team|goal)|first to score/i.test(title)) return "first_goal";
  if (/set handicap|sets? handicap/i.test(title)) return "set_handicap";
  if (/\([+-]?\d+\.5\)|handicap|spread/i.test(title)) return "game_handicap";
  if (/o\/u|over\/under|total/i.test(title)) return "total";
  if (/completed match|match completed/i.test(title)) return "completed_match";
  if (/set \d|set winner/i.test(title)) return "set_winner";
  return "moneyline";
}

export function extractPfLine(title: string, marketType: MarketType): string | null {
  if (marketType === "weather") {
    return weatherBucketLabel(title);
  }
  if (marketType === "total" || marketType === "corners") {
    const m = /o\/u\s*([0-9.]+)/i.exec(title) ?? /([0-9.]+)\s*$/.exec(title);
    return m?.[1] ?? null;
  }
  if (marketType === "game_handicap") {
    const m = /\(([+-]?[0-9.]+)\)/.exec(title);
    return m?.[1] ?? null;
  }
  if (marketType === "exact_score") {
    const m = /(\d+\s*-\s*\d+)/.exec(title);
    return m?.[1]?.replace(/\s+/g, "") ?? ( /any other/i.test(title) ? "other" : null);
  }
  return null;
}

/** Mirror Poly weather bucket labels on PF Yes/No temp markets. */
export function weatherBucketLabel(question: string): string {
  const q = question;
  const rangeF = q.match(/between\s+(\d+)\s*[-–]\s*(\d+)\s*°?\s*F/i);
  if (rangeF) return `${rangeF[1]}-${rangeF[2]}°F`;
  const rangeC = q.match(/between\s+(\d+)\s*[-–]\s*(\d+)\s*°?\s*C/i);
  if (rangeC) return `${rangeC[1]}-${rangeC[2]}°C`;
  const belowF = q.match(/(\d+)\s*°?\s*F\s+or\s+below/i);
  if (belowF) return `≤${belowF[1]}°F`;
  const belowC = q.match(/(\d+)\s*°?\s*C\s+or\s+below/i);
  if (belowC) return `≤${belowC[1]}°C`;
  const aboveF = q.match(/(\d+)\s*°?\s*F\s+or\s+higher/i);
  if (aboveF) return `≥${aboveF[1]}°F`;
  const aboveC = q.match(/(\d+)\s*°?\s*C\s+or\s+higher/i);
  if (aboveC) return `≥${aboveC[1]}°C`;
  const singleC = q.match(/\b(\d+)\s*°?\s*C\b/i);
  if (singleC) return `${singleC[1]}°C`;
  const singleF = q.match(/\b(\d+)\s*°?\s*F\b/i);
  if (singleF) return `${singleF[1]}°F`;
  return (
    q
      .replace(/^Will the highest temperature in .+? be\s+/i, "")
      .replace(/\s+on .+$/i, "")
      .trim() || "Bucket"
  );
}

/** Fetch moneyline + prop markets for one football fixture base slug. */
export async function listFootballFixtureMarkets(
  client: PredexonClientOptions,
  baseSlug: string,
  opts?: { statuses?: Array<"open" | "closed">; maxPages?: number },
): Promise<PredictMarket[]> {
  const base = pfFootballBaseSlug(baseSlug);
  const statuses = opts?.statuses ?? ["closed", "open"];
  const maxPages = opts?.maxPages ?? 15;
  const slugs = [base, ...PF_FOOTBALL_PROP_SUFFIXES.map((s) => `${base}${s}`)];
  const out: PredictMarket[] = [];
  const seen = new Set<number>();
  for (const slug of slugs) {
    for (const status of statuses) {
      const page = await listPredictMarkets(client, {
        eventSlug: slug,
        status,
        maxPages,
      } satisfies ListPredictMarketsOpts);
      for (const m of page) {
        if (seen.has(m.marketId)) continue;
        seen.add(m.marketId);
        out.push(m);
      }
    }
  }
  return out;
}

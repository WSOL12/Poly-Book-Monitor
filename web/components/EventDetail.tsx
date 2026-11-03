"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { EventOrderbook } from "@/components/EventOrderbook";
import { quoteAtTime } from "@/lib/history";
import { MatchScoreboard } from "@/components/MatchScoreboard";
import { isEventLive, matchPhase, matchPhaseLabel } from "@/lib/live";
import { ago, finishedWhen } from "@/lib/time";
import { formatVolume } from "@/lib/league";
import { pfMatchPlayerLabels } from "@/lib/matchTitles";
import { resolveMatchEnd } from "@/lib/timeline";

/** PF only streams Yes books — No mid ≈ 1 − Yes mid. */
function complementTob(q: { bestBid: number | null; bestAsk: number | null }) {
  const flip = (p: number | null) =>
    p == null || !Number.isFinite(p) ? null : Math.max(0, Math.min(1, 1 - p));
  return { bestBid: flip(q.bestAsk), bestAsk: flip(q.bestBid) };
}

function cents(p: number | null | undefined) {
  if (p == null || !Number.isFinite(p)) return "—";
  return `${(p * 100).toFixed(1)}¢`;
}

type QuotePoint = {
  id?: number;
  capturedAt: number;
  bestBid: number | null;
  bestAsk: number | null;
  day?: string;
};
type Venue = "polymarket" | "predictfun";

type MarketTok = {
  tokenId: string;
  side: string;
  label: string;
  lastBid: number | null;
  lastAsk: number | null;
};

type MarketRow = {
  marketId: string;
  marketType: string;
  question: string;
  line: string | null;
  volume?: number | null;
  tokens: MarketTok[];
};

type EventPayload = {
  eventId: string;
  sport: string;
  title: string;
  slug: string;
  startTime: string | null;
  eventDate: string | null;
  ended: boolean;
  closed: boolean;
  polyLive?: boolean;
  gameStatus: string | null;
  finishedAt: number | null;
  lastSnapshotAt: number | null;
  volume: number | null;
  score?: string | null;
  period?: string | null;
  markets: MarketRow[];
};

function venueOf(sport: string | undefined): Venue {
  return sport === "predictfun" ? "predictfun" : "polymarket";
}

export default function EventDetail({ eventId }: { eventId: string }) {
  const [frameAt, setFrameAt] = useState<number | undefined>();
  const [tokenId, setTokenId] = useState("");
  const [venue, setVenue] = useState<Venue | null>(null);

  const event = useQuery({
    queryKey: ["event", eventId],
    queryFn: async () => {
      const res = await fetch(`/api/events/${eventId}`);
      if (!res.ok) throw new Error("not found");
      return res.json() as Promise<EventPayload>;
    },
    refetchInterval: 5_000,
  });

  const primaryVenue = venueOf(event.data?.sport);
  const activeVenue = venue ?? primaryVenue;

  const twins = useQuery({
    queryKey: ["event-twins", eventId],
    queryFn: async () => {
      const res = await fetch(`/api/events/${eventId}/twins`);
      if (!res.ok) throw new Error("twins unavailable");
      return res.json() as Promise<{
        lookingFor: Venue;
        best: {
          eventId: string;
          sport: string;
          title: string;
          score: number;
          href: string;
          volume?: number | null;
        } | null;
        twins: Array<{
          eventId: string;
          sport: string;
          title: string;
          score: number;
          href: string;
          volume?: number | null;
        }>;
      }>;
    },
    enabled: Boolean(event.data),
    staleTime: 60_000,
  });

  const bestTwin =
    twins.data?.best && twins.data.best.score >= 0.55 ? twins.data.best : null;
  const twinEventId = bestTwin?.eventId ?? null;
  const viewingTwin = Boolean(twinEventId) && activeVenue !== primaryVenue;
  const viewEventId = viewingTwin && twinEventId ? twinEventId : eventId;

  const twinEvent = useQuery({
    queryKey: ["event", twinEventId],
    queryFn: async () => {
      const res = await fetch(`/api/events/${twinEventId!}`);
      if (!res.ok) throw new Error("twin not found");
      return res.json() as Promise<EventPayload>;
    },
    enabled: Boolean(twinEventId),
    staleTime: 60_000,
  });

  const data = viewingTwin ? twinEvent.data ?? null : event.data ?? null;

  const sports = useQuery({
    queryKey: ["event-sports", eventId],
    queryFn: async () => {
      const res = await fetch(`/api/events/${eventId}/sports`);
      if (!res.ok) throw new Error("sports unavailable");
      return res.json();
    },
    enabled: Boolean(event.data?.slug) && event.data?.sport !== "predictfun",
    refetchInterval: () => (event.data && isEventLive(event.data) ? 5_000 : false),
  });

  const scores = useQuery({
    queryKey: ["event-scores", eventId],
    queryFn: async () => {
      const res = await fetch(`/api/events/${eventId}/scores`);
      if (!res.ok) throw new Error("scores unavailable");
      return res.json();
    },
    refetchInterval: () => (event.data && isEventLive(event.data) ? 5_000 : false),
  });

  const quoteSeries = useQuery({
    queryKey: ["event-quote-series", eventId, "l2"],
    queryFn: async () => {
      const res = await fetch(`/api/events/${eventId}/quotes`);
      if (!res.ok) throw new Error("quotes unavailable");
      return res.json() as Promise<{ series: Record<string, QuotePoint[]> }>;
    },
    enabled: Boolean(event.data),
    staleTime: () => {
      if (event.data && isEventLive(event.data)) return 10_000;
      const fa = event.data?.finishedAt;
      if (fa != null && Date.now() - fa < 12 * 60_000) return 10_000;
      return Infinity;
    },
    refetchInterval: () => {
      if (event.data && isEventLive(event.data)) return 10_000;
      const fa = event.data?.finishedAt;
      if (fa != null && Date.now() - fa < 12 * 60_000) return 10_000;
      return false;
    },
  });

  // Prefetch Predict.fun quote timeline as soon as the twin is known — venue switch must be instant.
  const twinQuotes = useQuery({
    queryKey: ["event-quote-series", twinEventId, "l2"],
    queryFn: async () => {
      const res = await fetch(`/api/events/${twinEventId!}/quotes`);
      if (!res.ok) throw new Error("twin quotes unavailable");
      return res.json() as Promise<{ series: Record<string, QuotePoint[]> }>;
    },
    enabled: Boolean(twinEventId),
    staleTime: Infinity,
  });

  const activeQuoteSeries = viewingTwin ? twinQuotes.data?.series : quoteSeries.data?.series;

  const onFrame = useCallback((capturedAt: number) => {
    setFrameAt((prev) => (prev === capturedAt ? prev : capturedAt));
  }, []);

  useEffect(() => {
    setFrameAt(undefined);
    setTokenId("");
    setVenue(null);
  }, [eventId]);

  useEffect(() => {
    setFrameAt(undefined);
    setTokenId("");
  }, [activeVenue]);

  useEffect(() => {
    if (frameAt != null || !data) return;
    if (isEventLive(data) || matchPhase(data) === "open") {
      if (data.lastSnapshotAt != null && Number.isFinite(data.lastSnapshotAt)) {
        setFrameAt(data.lastSnapshotAt);
      }
      return;
    }
    const start = data.startTime ? Date.parse(data.startTime) : NaN;
    if (Number.isFinite(start)) setFrameAt(start);
  }, [data, frameAt, viewEventId]);

  const quoteById = useMemo(() => {
    const map = new Map<string, { bestBid: number | null; bestAsk: number | null }>();
    const series = activeQuoteSeries;
    if (!series) return map;
    const at = frameAt;
    for (const [tokenIdKey, snaps] of Object.entries(series)) {
      if (!snaps.length) continue;
      if (at == null) {
        const first = snaps[0]!;
        map.set(tokenIdKey, { bestBid: first.bestBid, bestAsk: first.bestAsk });
        continue;
      }
      map.set(tokenIdKey, quoteAtTime(snaps, at));
    }
    // Fill empty No TOB from Yes for PF binary match markets (Yes-book only).
    if (data?.sport === "predictfun") {
      for (const market of data.markets) {
        const yes = market.tokens.find((t) => t.side === "yes" || t.side === "home");
        const no = market.tokens.find((t) => t.side === "no" || t.side === "away");
        if (!yes || !no) continue;
        const yq = map.get(yes.tokenId);
        if (!yq || map.has(no.tokenId)) continue;
        if (!pfMatchPlayerLabels(market.question ?? "")) continue;
        map.set(no.tokenId, complementTob(yq));
      }
    }
    return map;
  }, [activeQuoteSeries, frameAt, data]);

  const allTokens = useMemo(
    () =>
      data?.markets.flatMap((market) =>
        market.tokens.map((token) => {
          const q = market.question?.trim() ?? "";
          const generic = /^(yes|no|over|under)$/i.test(token.label.trim());
          const players = data.sport === "predictfun" ? pfMatchPlayerLabels(q) : null;
          let label = token.label;
          if (data.sport === "predictfun" && generic && q && !/^moneyline$/i.test(q)) {
            // Tennis / binary match: Yes/No → player surnames. Soccer team markets keep question as label.
            if (players && (token.side === "yes" || token.side === "no" || token.side === "home" || token.side === "away")) {
              label =
                token.side === "no" || token.side === "away" ? players[1] : players[0];
            } else {
              label = token.side === "no" ? `No ${q}` : q;
            }
          }
          return {
            tokenId: token.tokenId,
            label,
            side: token.side,
            marketType: market.marketType,
            line: market.line,
            lastBid: token.lastBid,
            lastAsk: token.lastAsk,
            volume: market.volume ?? null,
          };
        })
      ) ?? [],
    [data]
  );

  const defaultTokenId =
    allTokens.find((t) => t.marketType === "weather" && t.side === "yes")?.tokenId ??
    allTokens.find((t) => t.side === "yes" || t.side === "over" || t.side === "home")?.tokenId ??
    allTokens[0]?.tokenId;

  const activeTokenId = tokenId || defaultTokenId || "";

  /** Scrub frames from prefetched quote series — Predict switch must not wait on /history. */
  const readySnapshots = useMemo(() => {
    const mapPts = (pts: QuotePoint[]) =>
      pts
        .filter((p) => p.id != null)
        .map((p) => ({
          id: p.id!,
          capturedAt: p.capturedAt,
          bestBid: p.bestBid,
          bestAsk: p.bestAsk,
          bidDepth: 0,
          askDepth: 0,
          bids: [] as Array<{ price: number; size: number }>,
          asks: [] as Array<{ price: number; size: number }>,
          day: p.day,
        }));

    const direct = activeTokenId ? activeQuoteSeries?.[activeTokenId] : undefined;
    if (direct?.length) return mapPts(direct);

    // PF Yes-only books: synthesize No timeline from Yes (1 − price).
    if (data?.sport === "predictfun" && activeTokenId && activeQuoteSeries) {
      for (const market of data.markets) {
        const yes = market.tokens.find((t) => t.side === "yes" || t.side === "home");
        const no = market.tokens.find((t) => t.side === "no" || t.side === "away");
        if (!yes || !no || no.tokenId !== activeTokenId) continue;
        if (!pfMatchPlayerLabels(market.question ?? "")) continue;
        const yesPts = activeQuoteSeries[yes.tokenId];
        if (!yesPts?.length) continue;
        return mapPts(
          yesPts.map((p) => {
            const c = complementTob({ bestBid: p.bestBid, bestAsk: p.bestAsk });
            return { ...p, bestBid: c.bestBid, bestAsk: c.bestAsk };
          })
        );
      }
    }
    return undefined;
  }, [activeQuoteSeries, activeTokenId, data]);

  const live = data ? isEventLive(data) : false;
  const phase = data ? matchPhase(data) : null;
  const sportsData = sports.data?.sports;
  const scoreRows = scores.data?.scores ?? [];
  const lastScoreAt = scoreRows.length ? scoreRows[scoreRows.length - 1]!.capturedAt : null;
  // Twin venue (Predict.fun) stores market-created as start/finish — use Poly kickoff clock for scrub.
  const clockEvent = viewingTwin ? event.data ?? data : data;
  const matchStartForBooks = clockEvent?.startTime ?? data?.startTime ?? null;
  const matchEnd = clockEvent
    ? resolveMatchEnd({
        sport: clockEvent.sport === "predictfun" ? event.data?.sport ?? "soccer" : clockEvent.sport,
        matchStart: matchStartForBooks,
        finishedAt: clockEvent.finishedAt,
        lastScoreAt,
        // Prefer Poly tip when viewing twin — PF lastSnap can be hours of post-settle noise.
        lastSnapshotAt: viewingTwin
          ? clockEvent.lastSnapshotAt ?? data?.lastSnapshotAt ?? null
          : data?.lastSnapshotAt ?? clockEvent.lastSnapshotAt ?? null,
      })
    : null;

  const scrubSport =
    clockEvent?.sport === "predictfun"
      ? event.data?.sport ?? "soccer"
      : clockEvent?.sport ?? data?.sport ?? undefined;

  const polyHref = event.data
    ? `https://polymarket.com/event/${event.data.slug}`
    : "https://polymarket.com";
  const externalHref = activeVenue === "predictfun" ? "https://predict.fun" : polyHref;

  const headerTitle = event.data?.title ?? data?.title ?? "";
  const headerSport = event.data?.sport ?? data?.sport ?? "";
  const twinReady = Boolean(bestTwin);
  const twinLoading = viewingTwin && twinEvent.isLoading;

  return (
    <>
      {!event.data ? (
        <div className="event-mid">
          <div className="panel-loading">Loading event…</div>
        </div>
      ) : (
        <>
          <div className="event-mid">
            <nav className="crumbs">
              <div className="crumbs-left">
                <Link href={headerSport && headerSport !== "predictfun" ? `/${headerSport}` : "/"}>
                  Matches
                </Link>
                <span className="crumb-sep">/</span>
                <span className="crumb-current">{headerTitle}</span>
                <span className="crumb-meta">
                  <span className={`sport-chip sport-${headerSport}`}>{headerSport}</span>
                  {event.data ? (
                    <span
                      className={
                        isEventLive(event.data) || matchPhase(event.data) === "live"
                          ? "match-status is-live"
                          : matchPhase(event.data) === "retired" || matchPhase(event.data) === "canceled"
                            ? "match-status is-void"
                            : "match-status"
                      }
                    >
                      {matchPhaseLabel(
                        matchPhase(event.data),
                        event.data.sport,
                        event.data.gameStatus,
                        event.data.score,
                        event.data.period
                      )}
                    </span>
                  ) : null}
                </span>
              </div>
              <div className="venue-switch" role="tablist" aria-label="Venue">
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeVenue === "polymarket"}
                  className={`venue-switch-btn${activeVenue === "polymarket" ? " on" : ""}`}
                  disabled={primaryVenue !== "polymarket" && !twinReady}
                  onClick={() => setVenue("polymarket")}
                >
                  Polymarket
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeVenue === "predictfun"}
                  className={`venue-switch-btn${activeVenue === "predictfun" ? " on" : ""}${
                    twinReady || primaryVenue === "predictfun" ? " has-twin" : ""
                  }`}
                  disabled={primaryVenue !== "predictfun" && !twinReady}
                  title={
                    primaryVenue !== "predictfun" && !twinReady
                      ? "No Predict.fun twin in local DB"
                      : bestTwin
                        ? `${bestTwin.title} · ${Math.round(bestTwin.score * 100)}%`
                        : "Predict.fun"
                  }
                  onClick={() => setVenue("predictfun")}
                >
                  Predict.fun
                  {twinReady && primaryVenue === "polymarket" ? (
                    <span className="venue-switch-dot" aria-hidden />
                  ) : null}
                </button>
              </div>
            </nav>

            <div className="event-main">
              {headerSport !== "weather" && headerSport !== "predictfun" ? (
                <MatchScoreboard
                  sports={sportsData}
                  title={headerTitle}
                  live={isEventLive(event.data) || sportsData?.live === true}
                  ended={event.data.ended || sportsData?.ended === true}
                  closed={event.data.closed || sportsData?.closed === true}
                  sport={headerSport}
                  gameStatus={event.data.gameStatus}
                  atMs={frameAt}
                  scoreHistory={scores.data?.scores ?? []}
                />
              ) : null}

              {twinLoading || !data ? (
                <div className="panel-loading">
                  {activeVenue === "predictfun" ? "Loading Predict.fun books…" : "Loading markets…"}
                </div>
              ) : (
                <EventOrderbook
                  tokens={allTokens}
                  eventFinished={!live}
                  matchStart={matchStartForBooks}
                  matchEnd={matchEnd}
                  eventVolume={data.volume}
                  onFrame={onFrame}
                  tokenId={tokenId || defaultTokenId}
                  onTokenChange={setTokenId}
                  frameQuotes={quoteById}
                  seekAt={frameAt}
                  sport={data.sport}
                  clockSport={scrubSport}
                  readySnapshots={readySnapshots}
                />
              )}

              <div className="event-meta mono">
                {data?.lastSnapshotAt && live ? <span>snap {ago(data.lastSnapshotAt)}</span> : null}
                {!live && (clockEvent?.finishedAt ?? data?.finishedAt) ? (
                  <span>
                    finished{" "}
                    {finishedWhen(
                      clockEvent?.finishedAt ?? data!.finishedAt!,
                      clockEvent?.eventDate ?? data?.eventDate,
                    )}
                  </span>
                ) : null}
                {(clockEvent?.eventDate ?? data?.eventDate) ? (
                  <span>{clockEvent?.eventDate ?? data?.eventDate}</span>
                ) : null}
                {activeVenue === "predictfun" && bestTwin ? (
                  <span title={bestTwin.title}>PF · {Math.round(bestTwin.score * 100)}% twin</span>
                ) : null}
              </div>
            </div>
          </div>

          <aside className="event-aside">
            <div className="aside-head">
              <div className="aside-title-wrap">
                <h2 className="aside-title">
                  {activeVenue === "predictfun" ? "Predict.fun markets" : "Markets"}
                </h2>
                {data?.volume != null && data.volume > 0 ? (
                  <span className="aside-vol mono" title="Event total volume">
                    {formatVolume(data.volume)}
                  </span>
                ) : null}
              </div>
              <a
                className="btn btn-primary aside-poly"
                href={externalHref}
                target="_blank"
                rel="noreferrer"
              >
                {activeVenue === "predictfun" ? "Predict.fun ↗" : "Polymarket ↗"}
              </a>
            </div>
            <div className="aside-list">
              {twinLoading || !data ? (
                <div className="panel-loading">Loading…</div>
              ) : (
                data.markets
                  .slice()
                  .sort((a, b) => {
                    const rank = (mt: string, line: string | null) => {
                      if (mt === "moneyline") return 0;
                      if (mt === "half_result") return 5;
                      if (mt === "btts") return 8;
                      if (mt === "first_goal") return 9;
                      if (mt === "exact_score") return 12;
                      if (mt === "set_winner") return 20 + Number(line ?? 99);
                      if (mt === "completed_match") return 25;
                      if (mt === "set_handicap") return 30;
                      if (mt === "game_handicap") return 40;
                      if (mt === "corners") return 45;
                      if (mt === "total") {
                        if (/^S1 Games/i.test(line ?? "")) return 50;
                        if (/^S\d+ Games/i.test(line ?? "")) return 60;
                        if (/^Sets/i.test(line ?? "")) return 70;
                        if (/^Match/i.test(line ?? "")) return 80;
                        return 90;
                      }
                      return 100;
                    };
                    const d = rank(a.marketType, a.line) - rank(b.marketType, b.line);
                    if (d !== 0) return d;
                    return (a.line ?? "").localeCompare(b.line ?? "", undefined, { numeric: true });
                  })
                  .map((market) => (
                    <div key={market.marketId} className="aside-market">
                      <div className="aside-market-head">
                        <span>
                          {market.marketType === "moneyline"
                            ? data?.sport === "predictfun" &&
                              pfMatchPlayerLabels(market.question ?? "")
                              ? "Moneyline"
                              : market.question?.trim() &&
                                  !/^(moneyline|match winner)$/i.test(market.question.trim())
                                ? market.question.trim()
                                : "Moneyline"
                            : market.marketType === "exact_score"
                              ? market.question?.trim() || "Exact score"
                              : market.marketType === "corners"
                                ? market.question?.trim() || "Corners"
                                : market.marketType === "btts"
                                  ? "Both teams to score"
                                  : market.marketType === "half_result"
                                    ? market.question?.trim() || "Half result"
                                    : market.marketType === "first_goal"
                                      ? market.question?.trim() || "First goal"
                                      : market.marketType === "weather"
                              ? (market.line ?? "Temp")
                              : market.marketType === "set_winner"
                                ? `Set ${market.line ?? "?"} Winner`
                                : market.marketType === "set_handicap"
                                  ? `Set Handicap${market.line ? ` ${market.line}` : ""}`
                                  : market.marketType === "game_handicap"
                                    ? market.question?.trim() ||
                                      `Spread${market.line ? ` ${market.line}` : ""}`
                                    : market.marketType === "completed_match"
                                      ? "Completed Match"
                                      : market.line && /O\/U/i.test(market.line)
                                        ? market.line
                                        : market.question?.trim()
                                          ? market.question
                                          : `O/U ${market.line ?? ""}`}
                        </span>
                        {market.volume != null && market.volume > 0 ? (
                          <span className="aside-market-vol mono">{formatVolume(market.volume)}</span>
                        ) : null}
                      </div>
                      <div className="aside-outcomes">
                        {[...market.tokens]
                          .sort((a, b) => {
                            const rank = (s: string) =>
                              s === "yes" || s === "over" || s === "home"
                                ? 0
                                : s === "no" || s === "under" || s === "away"
                                  ? 1
                                  : 2;
                            return rank(a.side) - rank(b.side);
                          })
                          .map((token) => {
                            const q = quoteById.get(token.tokenId);
                            const bid = q ? q.bestBid : token.lastBid;
                            const ask = q ? q.bestAsk : token.lastAsk;
                            const name = (() => {
                              if (market.marketType === "weather") {
                                return token.side === "no" ? "No" : "Yes";
                              }
                              if (data?.sport === "predictfun") {
                                const players = pfMatchPlayerLabels(market.question ?? "");
                                if (
                                  players &&
                                  /^(yes|no)$/i.test(token.label.trim())
                                ) {
                                  return token.side === "no" || token.side === "away"
                                    ? players[1]
                                    : players[0];
                                }
                                if (
                                  /^(yes|no)$/i.test(token.label.trim()) &&
                                  market.question?.trim()
                                ) {
                                  return token.side === "no"
                                    ? `No ${market.question.trim()}`
                                    : market.question.trim();
                                }
                              }
                              return token.label;
                            })();
                            return (
                              <button
                                key={token.tokenId}
                                type="button"
                                className={`aside-outcome ${
                                  token.tokenId === (tokenId || defaultTokenId) ? "aside-outcome-on" : ""
                                }`}
                                onClick={() => setTokenId(token.tokenId)}
                              >
                                <span>{name}</span>
                                <span className="aside-quotes mono">
                                  <span className="aside-bid">{cents(bid)}</span>
                                  <span className="aside-quote-sep">/</span>
                                  <span className="aside-ask">{cents(ask)}</span>
                                </span>
                              </button>
                            );
                          })}
                      </div>
                    </div>
                  ))
              )}
            </div>
          </aside>
        </>
      )}
    </>
  );
}

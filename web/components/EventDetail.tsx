"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { EventOrderbook } from "@/components/EventOrderbook";
import { quoteAtTime } from "@/lib/history";
import { MatchRail } from "@/components/MatchRail";
import { MatchScoreboard } from "@/components/MatchScoreboard";
import { Topbar } from "@/components/Topbar";
import { isEventLive, matchPhase, matchPhaseLabel } from "@/lib/live";
import { ago, finishedWhen } from "@/lib/time";
import type { Sport } from "@/lib/db";
import { formatVolume } from "@/lib/league";
import { resolveMatchEnd } from "@/lib/timeline";

function cents(p: number | null | undefined) {
  if (p == null || !Number.isFinite(p)) return "—";
  return `${(p * 100).toFixed(1)}¢`;
}

type QuotePoint = { capturedAt: number; bestBid: number | null; bestAsk: number | null };

export default function EventDetail({ eventId }: { eventId: string }) {
  const [frameAt, setFrameAt] = useState<number | undefined>();
  const [tokenId, setTokenId] = useState("");

  const event = useQuery({
    queryKey: ["event", eventId],
    queryFn: async () => {
      const res = await fetch(`/api/events/${eventId}`);
      if (!res.ok) throw new Error("not found");
      return res.json();
    },
    refetchInterval: 5_000,
  });

  const sports = useQuery({
    queryKey: ["event-sports", eventId],
    queryFn: async () => {
      const res = await fetch(`/api/events/${eventId}/sports`);
      if (!res.ok) throw new Error("sports unavailable");
      return res.json();
    },
    enabled: Boolean(event.data?.slug),
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

  // One dense series per token — scrubbing updates all market prices locally (no per-tick fetch).
  const quoteSeries = useQuery({
    queryKey: ["event-quote-series", eventId],
    queryFn: async () => {
      const res = await fetch(`/api/events/${eventId}/quotes`);
      if (!res.ok) throw new Error("quotes unavailable");
      return res.json() as Promise<{ series: Record<string, QuotePoint[]> }>;
    },
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

  const onFrame = useCallback((capturedAt: number) => {
    setFrameAt((prev) => (prev === capturedAt ? prev : capturedAt));
  }, []);

  const data = event.data;

  useEffect(() => {
    setFrameAt(undefined);
    setTokenId("");
  }, [eventId]);

  // Live / open: follow the latest recorded book — never seed a future kickoff
  // (that parked the scrubber on a stale prematch frame vs Polymarket live).
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
  }, [data, frameAt, eventId]);

  const quoteById = useMemo(() => {
    const map = new Map<string, { bestBid: number | null; bestAsk: number | null }>();
    const series = quoteSeries.data?.series;
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
    return map;
  }, [quoteSeries.data, frameAt]);

  const allTokens = useMemo(
    () =>
      data?.markets.flatMap(
        (market: {
          marketType: string;
          line: string | null;
          volume?: number | null;
          tokens: Array<{
            tokenId: string;
            side: string;
            label: string;
            lastBid: number | null;
            lastAsk: number | null;
          }>;
        }) =>
          market.tokens.map((token) => ({
            tokenId: token.tokenId,
            label: token.label,
            side: token.side,
            marketType: market.marketType,
            line: market.line,
            lastBid: token.lastBid,
            lastAsk: token.lastAsk,
            volume: market.volume ?? null,
          }))
      ) ?? [],
    [data]
  );

  const defaultTokenId =
    allTokens.find((t: { marketType: string; side?: string }) => t.marketType === "weather" && t.side === "yes")
      ?.tokenId ??
    allTokens.find((t: { side?: string }) => t.side === "yes" || t.side === "over" || t.side === "home")?.tokenId ??
    allTokens[0]?.tokenId;

  const live = data ? isEventLive(data) : false;
  const phase = data ? matchPhase(data) : null;
  const sportsData = sports.data?.sports;
  const scoreRows = scores.data?.scores ?? [];
  const lastScoreAt = scoreRows.length ? scoreRows[scoreRows.length - 1]!.capturedAt : null;
  const matchEnd = data
    ? resolveMatchEnd({
        sport: data.sport,
        matchStart: data.startTime,
        finishedAt: data.finishedAt,
        lastScoreAt,
        lastSnapshotAt: data.lastSnapshotAt ?? null,
      })
    : null;

  return (
    <div className="shell shell-event">
      <Topbar />

      {!data ? (
        <div className="panel-loading">Loading event…</div>
      ) : (
        <>
          <nav className="crumbs">
            <div className="crumbs-left">
              <Link href={`/${data.sport}`}>Matches</Link>
              <span className="crumb-sep">/</span>
              <span className="crumb-current">{data.title}</span>
              <span className="crumb-meta">
                <span className={`sport-chip sport-${data.sport}`}>{data.sport}</span>
                <span className={live || phase === "live" ? "match-status is-live" : phase === "voided" ? "match-status is-void" : "match-status"}>
                  {phase ? matchPhaseLabel(phase, data.sport, data.gameStatus) : live ? "Live" : "Finished"}
                </span>
              </span>
            </div>
          </nav>

          <div className="event-page">
            <MatchRail activeEventId={eventId} sport={data.sport as Sport} />

            <div className="event-main">
              {data.sport !== "weather" ? (
                <MatchScoreboard
                  sports={sportsData}
                  title={data.title}
                  live={live || sportsData?.live === true}
                  ended={data.ended || sportsData?.ended === true}
                  closed={data.closed || sportsData?.closed === true}
                  sport={data.sport}
                  gameStatus={data.gameStatus}
                  atMs={frameAt}
                  scoreHistory={scores.data?.scores ?? []}
                />
              ) : null}

              <EventOrderbook
                tokens={allTokens}
                eventFinished={!live}
                matchStart={data.startTime}
                matchEnd={matchEnd}
                eventVolume={data.volume}
                onFrame={onFrame}
                tokenId={tokenId || defaultTokenId}
                onTokenChange={setTokenId}
                frameQuotes={quoteById}
                seekAt={frameAt}
                sport={data.sport}
              />

              <div className="event-meta mono">
                {data.lastSnapshotAt && live ? <span>snap {ago(data.lastSnapshotAt)}</span> : null}
                {!live && data.finishedAt ? (
                  <span>finished {finishedWhen(data.finishedAt, data.eventDate)}</span>
                ) : null}
                {data.eventDate ? <span>{data.eventDate}</span> : null}
              </div>
            </div>

            <aside className="event-aside">
              <div className="aside-head">
                <div className="aside-title-wrap">
                  <h2 className="aside-title">Markets</h2>
                  {data.volume != null && data.volume > 0 ? (
                    <span className="aside-vol mono" title="Event total volume">
                      {formatVolume(data.volume)}
                    </span>
                  ) : null}
                </div>
                <a
                  className="btn btn-primary aside-poly"
                  href={`https://polymarket.com/event/${data.slug}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Polymarket ↗
                </a>
              </div>
              {data.markets
                .slice()
                .sort((a: { marketType: string; line: string | null }, b: { marketType: string; line: string | null }) => {
                  const rank = (mt: string, line: string | null) => {
                    if (mt === "moneyline") return 0;
                    if (mt === "set_winner") return 10 + Number(line ?? 99);
                    if (mt === "completed_match") return 20;
                    if (mt === "set_handicap") return 30;
                    if (mt === "game_handicap") return 40;
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
                .map(
                (market: {
                  marketId: string;
                  marketType: string;
                  question: string;
                  line: string | null;
                  volume?: number | null;
                  tokens: Array<{
                    tokenId: string;
                    side: string;
                    label: string;
                    lastBid: number | null;
                    lastAsk: number | null;
                  }>;
                }) => (
                  <div key={market.marketId} className="aside-market">
                    <div className="aside-market-head">
                      <span>
                        {market.marketType === "moneyline"
                          ? "Moneyline"
                          : market.marketType === "weather"
                            ? (market.line ?? "Temp")
                            : market.marketType === "set_winner"
                              ? `Set ${market.line ?? "?"} Winner`
                              : market.marketType === "set_handicap"
                                ? `Set Handicap${market.line ? ` ${market.line}` : ""}`
                                : market.marketType === "game_handicap"
                                  ? `Game Spread${market.line ? ` ${market.line}` : ""}`
                                  : market.marketType === "completed_match"
                                    ? "Completed Match"
                                    : market.line && /O\/U/i.test(market.line)
                                      ? market.line
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
                            s === "yes" || s === "over" || s === "home" ? 0 : s === "no" || s === "under" || s === "away" ? 1 : 2;
                          return rank(a.side) - rank(b.side);
                        })
                        .map((token) => {
                        const q = quoteById.get(token.tokenId);
                        const bid = q ? q.bestBid : token.lastBid;
                        const ask = q ? q.bestAsk : token.lastAsk;
                        const name =
                          market.marketType === "weather"
                            ? token.side === "no"
                              ? "No"
                              : "Yes"
                            : token.label;
                        const showBidAsk =
                          market.marketType === "total" ||
                          market.marketType === "set_handicap" ||
                          market.marketType === "game_handicap";
                        return (
                          <button
                            key={token.tokenId}
                            type="button"
                            className={`aside-outcome ${token.tokenId === (tokenId || defaultTokenId) ? "aside-outcome-on" : ""}`}
                            onClick={() => setTokenId(token.tokenId)}
                          >
                            <span>{name}</span>
                            {showBidAsk ? (
                              <span className="aside-quotes mono">
                                <span className="aside-bid">{cents(bid)}</span>
                                <span className="aside-quote-sep">/</span>
                                <span className="aside-ask">{cents(ask)}</span>
                              </span>
                            ) : (
                              <span className="aside-ask mono">{cents(ask ?? bid)}</span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )
              )}
            </aside>
          </div>
        </>
      )}
    </div>
  );
}

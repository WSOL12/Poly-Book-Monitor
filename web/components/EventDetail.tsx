"use client";

import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { EventOrderbook } from "@/components/EventOrderbook";
import { quoteAtTime } from "@/lib/history";
import { MatchRail } from "@/components/MatchRail";
import { MatchScoreboard } from "@/components/MatchScoreboard";
import { Topbar } from "@/components/Topbar";
import { isEventLive } from "@/lib/live";
import { ago, finishedWhen } from "@/lib/time";
import type { Sport } from "@/lib/db";

function cents(p: number | null | undefined) {
  if (p == null || !Number.isFinite(p)) return "—";
  return `${(p * 100).toFixed(1)}¢`;
}

type QuotePoint = { capturedAt: number; bestBid: number | null; bestAsk: number | null };

export default function EventDetail({ eventId }: { eventId: string }) {
  const [frameAt, setFrameAt] = useState<number | undefined>();
  const [tokenId, setTokenId] = useState("");
  const [activeBook, setActiveBook] = useState<{
    bestBid: number | null;
    bestAsk: number | null;
  } | null>(null);

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

  const quoteSeries = useQuery({
    queryKey: ["event-quote-series", eventId],
    queryFn: async () => {
      const res = await fetch(`/api/events/${eventId}/quotes`);
      if (!res.ok) throw new Error("quotes unavailable");
      return res.json() as Promise<{ series: Record<string, QuotePoint[]> }>;
    },
    staleTime: event.data && !isEventLive(event.data) ? Infinity : 10_000,
    refetchInterval: () => (event.data && isEventLive(event.data) ? 10_000 : false),
  });

  const onFrame = useCallback((capturedAt: number, book?: { bestBid: number | null; bestAsk: number | null }) => {
    setFrameAt((prev) => (prev === capturedAt ? prev : capturedAt));
    setActiveBook((prev) => {
      const next = book ?? null;
      if (
        prev?.bestBid === next?.bestBid &&
        prev?.bestAsk === next?.bestAsk &&
        (prev == null) === (next == null)
      ) {
        return prev;
      }
      return next;
    });
  }, []);

  const quoteById = useMemo(() => {
    const map = new Map<string, { bestBid: number | null; bestAsk: number | null }>();
    const series = quoteSeries.data?.series;
    if (!series) return map;
    const at = frameAt;
    for (const [tokenIdKey, snaps] of Object.entries(series)) {
      if (at == null) {
        const last = snaps[snaps.length - 1];
        if (last) map.set(tokenIdKey, { bestBid: last.bestBid, bestAsk: last.bestAsk });
        continue;
      }
      map.set(tokenIdKey, quoteAtTime(snaps, at));
    }
    return map;
  }, [quoteSeries.data, frameAt]);

  const data = event.data;
  const allTokens = useMemo(
    () =>
      data?.markets.flatMap(
        (market: {
          marketType: string;
          line: string | null;
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
          }))
      ) ?? [],
    [data]
  );

  const defaultTokenId =
    allTokens.find((t) => t.marketType === "weather" && t.side === "yes")?.tokenId ??
    allTokens.find((t) => t.side === "yes" || t.side === "over" || t.side === "home")?.tokenId ??
    allTokens[0]?.tokenId;

  const live = data ? isEventLive(data) : false;
  const sportsData = sports.data?.sports;

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
                <span className={live ? "match-status is-live" : "match-status"}>
                  {live ? "Live" : "Finished"}
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
                  atMs={frameAt}
                  scoreHistory={scores.data?.scores ?? []}
                />
              ) : null}

              <EventOrderbook
                tokens={allTokens}
                eventFinished={!live}
                matchStart={data.startTime}
                matchEnd={data.finishedAt}
                onFrame={onFrame}
                tokenId={tokenId || defaultTokenId}
                onTokenChange={(id) => {
                  setTokenId(id);
                  setActiveBook(null);
                }}
                frameQuotes={quoteById}
                seekAt={frameAt}
                activeBook={activeBook}
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
                <h2 className="aside-title">Markets</h2>
                <a
                  className="btn btn-primary aside-poly"
                  href={`https://polymarket.com/event/${data.slug}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Polymarket ↗
                </a>
              </div>
              {data.markets.map(
                (market: {
                  marketId: string;
                  marketType: string;
                  question: string;
                  line: string | null;
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
                      {market.marketType === "moneyline"
                        ? "Moneyline"
                        : market.marketType === "weather"
                          ? (market.line ?? "Temp")
                          : `O/U ${market.line ?? ""}`}
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
                        const fromBook =
                          token.tokenId === (tokenId || defaultTokenId) && activeBook
                            ? activeBook
                            : null;
                        const ask = fromBook ? fromBook.bestAsk : q ? q.bestAsk : token.lastAsk;
                        const name =
                          market.marketType === "weather"
                            ? token.side === "no"
                              ? "No"
                              : "Yes"
                            : token.label;
                        return (
                          <button
                            key={token.tokenId}
                            type="button"
                            className={`aside-outcome ${token.tokenId === (tokenId || defaultTokenId) ? "aside-outcome-on" : ""}`}
                            onClick={() => setTokenId(token.tokenId)}
                          >
                            <span>{name}</span>
                            <span className="aside-ask mono">{cents(ask)}</span>
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

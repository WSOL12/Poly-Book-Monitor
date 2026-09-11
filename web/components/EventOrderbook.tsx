"use client";

import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { OrderbookChart } from "@/components/OrderbookChart";
import { OrderbookScrubber } from "@/components/OrderbookScrubber";
import type { FrameQuote } from "@/lib/history";

export type { FrameQuote };

type TokenOption = {
  tokenId: string;
  label: string;
  marketType: string;
  line: string | null;
  side?: string;
  lastBid?: number | null;
  lastAsk?: number | null;
};

function cents(p: number | null | undefined) {
  if (p == null || !Number.isFinite(p)) return "—";
  const c = p * 100;
  return `${Number.isInteger(c) ? c.toFixed(0) : c.toFixed(1)}¢`;
}

function shortLabel(label: string) {
  const parts = label.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 8).toUpperCase();
  return parts
    .filter((p) => !/^(fc|cf|sc|afc|the)$/i.test(p))
    .slice(0, 2)
    .map((p) => p.slice(0, 6))
    .join(" ")
    .toUpperCase();
}

function bucketKey(token: TokenOption) {
  return token.line ?? token.label;
}

import { expandTimeline } from "@/lib/timeline";

async function fetchHistory(tokenId: string) {
  const res = await fetch(`/api/tokens/${tokenId}/history`);
  if (!res.ok) throw new Error("history unavailable");
  const raw = await res.json();
  return {
    ...raw,
    snapshots: expandTimeline(raw.timeline),
  };
}

export function EventOrderbook({
  tokens,
  eventFinished = false,
  matchStart,
  matchEnd,
  onFrame,
  tokenId,
  onTokenChange,
  frameQuotes,
}: {
  tokens: TokenOption[];
  eventFinished?: boolean;
  matchStart?: string | null;
  matchEnd?: number | null;
  onFrame?: (capturedAt: number) => void;
  tokenId?: string;
  onTokenChange?: (tokenId: string) => void;
  frameQuotes?: Map<string, { bestBid: number | null; bestAsk: number | null }>;
}) {
  const [internalId, setInternalId] = useState(tokens[0]?.tokenId ?? "");
  const [tab, setTab] = useState<"book" | "graph">("book");
  const activeId = tokenId ?? internalId;
  const setActiveId = onTokenChange ?? setInternalId;

  const resolvedId = tokens.some((t) => t.tokenId === activeId) ? activeId : (tokens[0]?.tokenId ?? "");
  const active = tokens.find((t) => t.tokenId === resolvedId) ?? null;
  const moneyline = useMemo(() => tokens.filter((t) => t.marketType === "moneyline"), [tokens]);
  const weatherBuckets = useMemo(() => tokens.filter((t) => t.marketType === "weather"), [tokens]);

  /** One pill per temp bucket — prefer Yes for the default token id. */
  const weatherBucketPills = useMemo(() => {
    const byKey = new Map<string, TokenOption>();
    for (const t of weatherBuckets) {
      const key = bucketKey(t);
      const prev = byKey.get(key);
      if (!prev || t.side === "yes") byKey.set(key, t);
    }
    return [...byKey.values()];
  }, [weatherBuckets]);

  const outcomeTokens = moneyline.length
    ? moneyline
    : weatherBucketPills.length
      ? weatherBucketPills
      : tokens.slice(0, 3);

  const activeSide = active?.side === "no" ? "no" : "yes";
  const weatherPair = useMemo(() => {
    if (!active || active.marketType !== "weather") return null;
    const key = bucketKey(active);
    const yes = weatherBuckets.find((t) => bucketKey(t) === key && t.side === "yes") ?? null;
    const no = weatherBuckets.find((t) => bucketKey(t) === key && t.side === "no") ?? null;
    return { yes, no, key };
  }, [active, weatherBuckets]);

  const history = useQuery({
    queryKey: ["token-history", resolvedId],
    queryFn: () => fetchHistory(resolvedId),
    enabled: Boolean(resolvedId),
    refetchInterval: eventFinished ? false : 5_000,
    staleTime: eventFinished ? Infinity : 4_000,
  });

  const handleFrame = useCallback(
    (snap: { capturedAt: number }) => {
      onFrame?.(snap.capturedAt);
    },
    [onFrame]
  );

  const selectWeatherBucket = (pill: TokenOption) => {
    const key = bucketKey(pill);
    const prefer =
      weatherBuckets.find((t) => bucketKey(t) === key && t.side === activeSide) ??
      weatherBuckets.find((t) => bucketKey(t) === key && t.side === "yes") ??
      pill;
    setActiveId(prefer.tokenId);
  };

  if (!tokens.length) {
    return (
      <div className="panel-empty panel-empty-inline">
        <div className="panel-empty-title">No tokens recorded</div>
      </div>
    );
  }

  const data = history.data;
  const frames = data?.totalSnapshots ?? data?.snapshots?.length ?? 0;
  const marketTitle =
    active?.marketType === "moneyline"
      ? "Moneyline"
      : active?.marketType === "total"
        ? `O/U ${active.line ?? ""}`
        : active?.marketType === "weather"
          ? `High temp · ${active.label}${activeSide === "no" ? " No" : " Yes"}`
          : "Market";

  const scrubberLabel =
    active?.marketType === "weather"
      ? `${active.label} ${activeSide === "no" ? "No" : "Yes"}`
      : active?.label;

  return (
    <section className="ob-panel poly-panel">
      <div className="poly-market-head">
        <div className="poly-market-title">
          <h2>{marketTitle}</h2>
          <span className="poly-market-vol mono">{frames.toLocaleString()} frames</span>
          {weatherPair?.no ? (
            <div className="poly-yn-toggle" role="group" aria-label="Yes or No">
              <button
                type="button"
                className={`poly-yn-btn${activeSide === "yes" ? " poly-yn-on" : ""}`}
                disabled={!weatherPair.yes}
                onClick={() => weatherPair.yes && setActiveId(weatherPair.yes.tokenId)}
              >
                Yes
              </button>
              <button
                type="button"
                className={`poly-yn-btn${activeSide === "no" ? " poly-yn-on" : ""}`}
                disabled={!weatherPair.no}
                onClick={() => weatherPair.no && setActiveId(weatherPair.no.tokenId)}
              >
                No
              </button>
            </div>
          ) : null}
        </div>
        <div className={`poly-outcome-btns${weatherBucketPills.length ? " poly-outcome-btns-wrap" : ""}`}>
          {outcomeTokens.map((token, i) => {
            const key = bucketKey(token);
            const displayTok =
              token.marketType === "weather"
                ? (weatherBuckets.find((t) => bucketKey(t) === key && t.side === activeSide) ?? token)
                : token;
            const q = frameQuotes?.get(displayTok.tokenId);
            const ask = q?.bestAsk ?? displayTok.lastAsk;
            const on =
              token.marketType === "weather"
                ? Boolean(active && bucketKey(active) === key)
                : token.tokenId === resolvedId;
            return (
              <button
                key={token.marketType === "weather" ? key : token.tokenId}
                type="button"
                className={clsOutcome(on, i)}
                onClick={() =>
                  token.marketType === "weather" ? selectWeatherBucket(token) : setActiveId(token.tokenId)
                }
              >
                <span className="poly-out-name">
                  {token.marketType === "weather" ? token.label : shortLabel(token.label)}
                </span>
                <span className="poly-out-price">{cents(ask)}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="poly-tabs">
        <button
          type="button"
          className={`poly-tab${tab === "book" ? " poly-tab-on" : ""}`}
          onClick={() => setTab("book")}
        >
          Order Book
        </button>
        <button
          type="button"
          className={`poly-tab${tab === "graph" ? " poly-tab-on" : ""}`}
          onClick={() => setTab("graph")}
        >
          Graph
        </button>
      </div>

      {history.isLoading ? (
        <div className="panel-loading">Loading orderbook…</div>
      ) : tab === "graph" ? (
        <OrderbookChart snapshots={data?.snapshots ?? []} matchEnd={matchEnd} />
      ) : (
        <OrderbookScrubber
          snapshots={data?.snapshots ?? []}
          outcomeLabel={scrubberLabel}
          startAtBeginning={eventFinished || Boolean(data?.eventFinished)}
          matchStart={matchStart}
          matchEnd={matchEnd}
          onFrame={(snap) => handleFrame(snap)}
        />
      )}
    </section>
  );
}

function clsOutcome(on: boolean, index: number) {
  const base = "poly-out-btn";
  if (!on) return `${base} poly-out-off`;
  if (index === 0) return `${base} poly-out-on poly-out-a`;
  if (index === 1) return `${base} poly-out-on poly-out-b`;
  return `${base} poly-out-on poly-out-c`;
}

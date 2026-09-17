"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { OrderbookScrubber } from "@/components/OrderbookScrubber";
import { Topbar } from "@/components/Topbar";
import { expandTimeline } from "@/lib/timeline";

export default function TokenDetail({ tokenId }: { tokenId: string }) {
  const history = useQuery({
    queryKey: ["token-history", tokenId],
    queryFn: async () => {
      const res = await fetch(`/api/tokens/${tokenId}/history`);
      if (!res.ok) throw new Error("history unavailable");
      const raw = await res.json();
      return { ...raw, snapshots: expandTimeline(raw.timeline) };
    },
    refetchInterval: 3_000,
  });

  const data = history.data;

  return (
    <div className="shell">
      <Topbar />

      {!data?.token ? (
        <div className="panel-loading">Loading orderbook…</div>
      ) : (
        <>
          <nav className="crumbs">
            <Link href="/">Matches</Link>
            <span className="crumb-sep">/</span>
            <Link href={`/${data.token.sport}/event/${data.token.eventId}`}>{data.eventTitle}</Link>
            <span className="crumb-sep">/</span>
            <span className="crumb-current">{data.token.label}</span>
          </nav>

          <header className="event-head">
            <div className="event-head-main">
              <div className="event-tags">
                <span className={`sport-chip sport-${data.token.sport}`}>{data.token.sport}</span>
                <span className="market-type-chip">{data.token.marketType}</span>
              </div>
              <h1 className="event-title">{data.token.label}</h1>
              <div className="event-date">{data.eventTitle}</div>
            </div>
            <Link href={`/${data.token.sport}/event/${data.token.eventId}`} className="btn">
              ← Event
            </Link>
          </header>

          <section className="ob-panel poly-panel">
            <div className="poly-market-head">
              <div className="poly-market-title">
                <h2>{data.token.marketType === "moneyline" ? "Moneyline" : data.token.marketType}</h2>
                <span className="poly-market-vol mono">{data.totalSnapshots.toLocaleString()} frames</span>
              </div>
            </div>
            <div className="poly-tabs">
              <span className="poly-tab poly-tab-on">Order Book</span>
            </div>
            <OrderbookScrubber
              snapshots={data.snapshots}
              outcomeLabel={data.token.label}
              startAtBeginning={data.eventFinished}
              sport={data.token.sport}
            />
          </section>
        </>
      )}
    </div>
  );
}

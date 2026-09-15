"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { EventRow, Sport } from "@/lib/db";
import { splitEvents } from "@/lib/live";
import { eventResultLabel } from "@/lib/score";
import { ago, finishedWhen } from "@/lib/time";

type Tab = "live" | "finished";

function shortTitle(title: string) {
  return title.replace(/\s+vs\.?\s+/i, " vs ");
}

export function MatchRail({
  activeEventId,
  sport,
}: {
  activeEventId: string;
  sport?: Sport;
}) {
  const [tab, setTab] = useState<Tab | null>(null);

  const events = useQuery({
    queryKey: ["events", sport ?? "all", "rail"],
    queryFn: async () => {
      const url = sport ? `/api/events?sport=${sport}` : "/api/events";
      const res = await fetch(url);
      if (!res.ok) throw new Error("events unavailable");
      const body = (await res.json()) as { events: EventRow[] };
      return body.events;
    },
    refetchInterval: 5_000,
  });

  const { live, finished } = useMemo(() => splitEvents(events.data ?? []), [events.data]);

  const activeIsLive = live.some((e) => e.eventId === activeEventId);
  const activeIsFinished = finished.some((e) => e.eventId === activeEventId);
  const preferred: Tab = activeIsFinished ? "finished" : "live";
  const effectiveTab: Tab = tab ?? preferred;
  const rows = effectiveTab === "live" ? live : finished;

  return (
    <aside className="match-rail">
      <div className="match-rail-head">
        <h2 className="aside-title">Matches</h2>
        <div className="match-rail-seg" role="tablist" aria-label="Match status">
          <button
            type="button"
            role="tab"
            aria-selected={effectiveTab === "live"}
            className={`match-rail-seg-btn${effectiveTab === "live" ? " on" : ""}`}
            onClick={() => setTab("live")}
          >
            Live
            <span className="match-rail-count">{live.length}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={effectiveTab === "finished"}
            className={`match-rail-seg-btn${effectiveTab === "finished" ? " on" : ""}`}
            onClick={() => setTab("finished")}
          >
            Done
            <span className="match-rail-count">{finished.length}</span>
          </button>
        </div>
      </div>

      {events.isLoading ? (
        <div className="match-rail-empty">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="match-rail-empty">
          No {effectiveTab === "live" ? "live" : "finished"} matches
        </div>
      ) : (
        <div className="match-rail-list">
          {rows.map((event) => {
            const on = event.eventId === activeEventId;
            const result = eventResultLabel(event);
            const hint =
              effectiveTab === "live"
                ? ago(event.lastSnapshotAt)
                : finishedWhen(event.finishedAt, event.eventDate);
            return (
              <Link
                key={event.eventId}
                href={`/event/${event.eventId}`}
                className={`match-rail-item${on ? " match-rail-item-on" : ""}${
                  effectiveTab === "live" ? " match-rail-item-live" : ""
                }`}
                title={event.title}
              >
                <span className="match-rail-top">
                  <span className="match-rail-title">{shortTitle(event.title)}</span>
                  {result ? <span className="match-rail-score mono">{result}</span> : null}
                </span>
                <span className="match-rail-meta mono">
                  {event.sport !== "weather" && event.period ? `${event.period} · ` : ""}
                  {event.sport === "weather" && result ? "win · " : ""}
                  {hint}
                </span>
              </Link>
            );
          })}
        </div>
      )}

      {/* Keep active match reachable if it's on the other tab */}
      {activeIsLive && effectiveTab === "finished" ? (
        <p className="match-rail-hint">Active match is under Live</p>
      ) : null}
      {activeIsFinished && effectiveTab === "live" ? (
        <p className="match-rail-hint">Active match is under Done</p>
      ) : null}
    </aside>
  );
}

"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { MatchListControls } from "@/components/MatchListControls";
import type { EventRow, Sport } from "@/lib/db";
import { formatVolume, leagueAccent, resolveLeague } from "@/lib/league";
import { splitEvents } from "@/lib/live";
import {
  DEFAULT_MATCH_FILTERS,
  filterAndSortEvents,
  groupSortedEvents,
  listLeagueOptions,
  type MatchListFilters,
} from "@/lib/matchFilters";
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
  const [filters, setFilters] = useState<MatchListFilters>(DEFAULT_MATCH_FILTERS);

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
  const pool = effectiveTab === "live" ? live : finished;

  const leagueOptions = useMemo(() => listLeagueOptions(pool), [pool]);
  const rows = useMemo(() => filterAndSortEvents(pool, filters), [pool, filters]);
  const groups = useMemo(() => groupSortedEvents(rows, filters.sort), [rows, filters.sort]);

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
        <MatchListControls
          compact
          filters={filters}
          onChange={setFilters}
          leagueOptions={leagueOptions}
        />
      </div>

      {events.isLoading ? (
        <div className="match-rail-empty">Loading…</div>
      ) : pool.length === 0 ? (
        <div className="match-rail-empty">
          No {effectiveTab === "live" ? "live" : "finished"} matches
        </div>
      ) : rows.length === 0 ? (
        <div className="match-rail-empty">No matches for these filters</div>
      ) : (
        <div className="match-rail-list">
          {groups.map((group) => {
            const accent = leagueAccent(group.code);
            return (
              <div key={group.code} className="match-rail-group" style={{ ["--league-accent" as string]: accent }}>
                <div className="match-rail-group-head">
                  <span className="match-rail-group-name">{group.label}</span>
                  <span className="match-rail-group-meta mono">
                    {group.events.length}
                    {group.totalVolume > 0 ? ` · ${formatVolume(group.totalVolume)}` : ""}
                  </span>
                </div>
                {group.events.map((event) => {
                  const on = event.eventId === activeEventId;
                  const result = eventResultLabel(event);
                  const league = resolveLeague(event).label;
                  const hint =
                    effectiveTab === "live"
                      ? ago(event.lastSnapshotAt)
                      : finishedWhen(event.finishedAt, event.eventDate);
                  return (
                    <Link
                      key={event.eventId}
                      href={`/${event.sport}/event/${event.eventId}`}
                      className={`match-rail-item${on ? " match-rail-item-on" : ""}${
                        effectiveTab === "live" ? " match-rail-item-live" : ""
                      }`}
                      title={`${event.title} · ${league}${event.volume ? ` · ${formatVolume(event.volume)}` : ""}`}
                    >
                      <span className="match-rail-top">
                        <span className="match-rail-title">{shortTitle(event.title)}</span>
                        {result ? <span className="match-rail-score mono">{result}</span> : null}
                      </span>
                      <span className="match-rail-meta mono">
                        <span className="match-rail-vol">{formatVolume(event.volume)}</span>
                        <span className="match-rail-dot">·</span>
                        {event.sport !== "weather" && event.sport !== "tennis" && event.period
                          ? `${event.period} · `
                          : ""}
                        {event.sport === "tennis" && result ? `${result} · ` : ""}
                        {event.sport === "weather" && result ? "win · " : ""}
                        {hint}
                      </span>
                    </Link>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}

      {activeIsLive && effectiveTab === "finished" ? (
        <p className="match-rail-hint">Active match is under Live</p>
      ) : null}
      {activeIsFinished && effectiveTab === "live" ? (
        <p className="match-rail-hint">Active match is under Done</p>
      ) : null}
    </aside>
  );
}

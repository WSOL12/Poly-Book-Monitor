"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { MatchListControls } from "@/components/MatchListControls";
import type { EventRow, Sport } from "@/lib/db";
import { formatVolume, leagueAccent, resolveLeague } from "@/lib/league";
import { matchPhase, matchPhaseLabel, splitEvents, type MatchPhase } from "@/lib/live";
import {
  DEFAULT_MATCH_FILTERS,
  filterAndSortEvents,
  groupSortedEvents,
  listLeagueOptions,
  type MatchListFilters,
} from "@/lib/matchFilters";
import { eventResultLabel } from "@/lib/score";
import { ago, finishedWhen } from "@/lib/time";

type Tab = MatchPhase;

function shortTitle(title: string) {
  return title.replace(/\s+vs\.?\s+/i, " vs ");
}

function phaseShort(phase: MatchPhase) {
  if (phase === "open") return "Open";
  if (phase === "live") return "Live";
  if (phase === "voided") return "Void";
  return "Done";
}

export function MatchRail({
  activeEventId,
  sport,
}: {
  activeEventId: string;
  sport?: Sport;
}) {
  const tennisMode = sport === "tennis";
  const weatherMode = sport === "weather";
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

  const { open, live, voided, finished } = useMemo(
    () => splitEvents(events.data ?? []),
    [events.data]
  );

  const active = events.data?.find((e) => e.eventId === activeEventId) ?? null;
  const activePhase = active ? matchPhase(active) : null;
  const preferred: Tab = activePhase ?? (tennisMode || weatherMode ? "open" : "live");
  const effectiveTab: Tab = tab ?? preferred;
  const pool =
    effectiveTab === "open"
      ? open
      : effectiveTab === "live"
        ? live
        : effectiveTab === "voided"
          ? voided
          : finished;

  const leagueOptions = useMemo(() => listLeagueOptions(pool), [pool]);
  const rows = useMemo(() => filterAndSortEvents(pool, filters), [pool, filters]);
  const groups = useMemo(() => groupSortedEvents(rows, filters.sort), [rows, filters.sort]);

  const emptyWord =
    effectiveTab === "open"
      ? "open"
      : effectiveTab === "live"
        ? "live"
        : effectiveTab === "voided"
          ? "void"
          : "finished";

  return (
    <aside className="match-rail">
      <div className="match-rail-head">
        <h2 className="aside-title">Matches</h2>
        <div className="match-rail-seg" role="tablist" aria-label="Match status">
          {tennisMode || weatherMode ? (
            <button
              type="button"
              role="tab"
              aria-selected={effectiveTab === "open"}
              className={`match-rail-seg-btn${effectiveTab === "open" ? " on" : ""}`}
              onClick={() => setTab("open")}
            >
              Open
              <span className="match-rail-count">{open.length}</span>
            </button>
          ) : null}
          {!weatherMode ? (
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
          ) : null}
          {tennisMode ? (
            <button
              type="button"
              role="tab"
              aria-selected={effectiveTab === "voided"}
              className={`match-rail-seg-btn${effectiveTab === "voided" ? " on" : ""}`}
              onClick={() => setTab("voided")}
            >
              Void
              <span className="match-rail-count">{voided.length}</span>
            </button>
          ) : null}
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
        <div className="match-rail-empty">No {emptyWord} matches</div>
      ) : rows.length === 0 ? (
        <div className="match-rail-empty">No matches for these filters</div>
      ) : (
        <div className="match-rail-list">
          {groups.map((group) => {
            const accent = leagueAccent(group.code);
            return (
              <div
                key={group.code}
                className="match-rail-group"
                style={{ ["--league-accent" as string]: accent }}
              >
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
                  const phase = matchPhase(event);
                  const league = resolveLeague(event).label;
                  const hint =
                    effectiveTab === "finished" || effectiveTab === "voided"
                      ? finishedWhen(event.finishedAt, event.eventDate)
                      : ago(event.lastSnapshotAt);
                  return (
                    <Link
                      key={event.eventId}
                      href={`/${event.sport}/event/${event.eventId}`}
                      className={`match-rail-item${on ? " match-rail-item-on" : ""}${
                        phase === "open" || phase === "live" ? " match-rail-item-live" : ""
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
                        {tennisMode ? (
                          <span>
                            {matchPhaseLabel(phase, event.sport, event.gameStatus)}
                            {" · "}
                          </span>
                        ) : null}
                        {event.sport !== "weather" && event.sport !== "tennis" && event.period
                          ? `${event.period} · `
                          : ""}
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

      {activePhase && activePhase !== effectiveTab ? (
        <p className="match-rail-hint">
          Active match is under {phaseShort(activePhase)}
        </p>
      ) : null}
    </aside>
  );
}

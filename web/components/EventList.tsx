"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { EventRow } from "@/lib/db";
import { splitEvents } from "@/lib/live";
import { eventResultLabel } from "@/lib/score";
import { ago, finishedWhen } from "@/lib/time";

type Tab = "live" | "finished";

const SPORT_LABEL: Record<string, string> = {
  soccer: "Soccer",
  football: "Football",
  mlb: "MLB",
  weather: "Weather",
};

function MatchRow({ event, tab }: { event: EventRow; tab: Tab }) {
  const result = eventResultLabel(event);
  return (
    <Link href={`/${event.sport}/event/${event.eventId}`} className={`match-row${tab === "live" ? " match-row-live" : ""}`}>
      <div className="match-main">
        <div className="match-title">{event.title}</div>
        <div className="match-meta">
          <span className={`sport-chip sport-${event.sport}`}>{SPORT_LABEL[event.sport] ?? event.sport}</span>
          {event.period && event.sport !== "weather" ? (
            <span className="match-period">{event.period}</span>
          ) : null}
          {event.eventDate ? <span className="match-date">{event.eventDate}</span> : null}
          <span className="match-markets">
            {event.marketCount} mkts · {event.tokenCount} tokens
          </span>
        </div>
      </div>
      {result ? (
        <div className="match-result mono" title={event.sport === "weather" ? "Winning temp" : "Score"}>
          {result}
        </div>
      ) : (
        <div className="match-result match-result-empty mono">—</div>
      )}
      <div className="match-side">
        <span className={`match-status${tab === "live" ? " is-live" : ""}`}>
          {tab === "live" ? (event.sport === "weather" ? "Open" : "Live") : "Finished"}
        </span>
        <span className="match-time mono">
          {tab === "finished" ? finishedWhen(event.finishedAt, event.eventDate) : ago(event.lastSnapshotAt)}
        </span>
      </div>
      <span className="match-chevron" aria-hidden>
        ›
      </span>
    </Link>
  );
}

export function EventList({ events, loading }: { events: EventRow[]; loading?: boolean }) {
  const [tab, setTab] = useState<Tab>("live");
  const [search, setSearch] = useState("");

  const { live, finished } = useMemo(() => splitEvents(events), [events]);

  const filtered = useMemo(() => {
    const pool = tab === "live" ? live : finished;
    const q = search.trim().toLowerCase();
    if (!q) return pool;
    return pool.filter((e) => e.title.toLowerCase().includes(q) || e.sport.includes(q));
  }, [tab, live, finished, search]);

  if (loading) {
    return (
      <div className="match-panel">
        <div className="match-toolbar">
          <div className="seg seg-skel" />
          <div className="search-input search-skel" />
        </div>
        <div className="panel-loading">Loading matches…</div>
      </div>
    );
  }

  if (!events.length) {
    return (
      <div className="panel-empty">
        <div className="panel-empty-title">No matches yet</div>
        <p className="panel-empty-text">
          Start the monitor to record live Polymarket orderbooks.
        </p>
        <code className="panel-empty-code">npm run monitor</code>
      </div>
    );
  }

  return (
    <div className="match-panel">
      <div className="match-toolbar">
        <div className="seg" role="tablist" aria-label="Match status">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "live"}
            className={`seg-btn${tab === "live" ? " on" : ""}`}
            onClick={() => setTab("live")}
          >
            Live
            <span className="seg-count">{live.length}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "finished"}
            className={`seg-btn${tab === "finished" ? " on" : ""}`}
            onClick={() => setTab("finished")}
          >
            Finished
            <span className="seg-count">{finished.length}</span>
          </button>
        </div>

        <label className="search-wrap">
          <span className="search-icon" aria-hidden>
            ⌕
          </span>
          <input
            className="search-input"
            type="search"
            placeholder="Search matches…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
      </div>

      {filtered.length === 0 ? (
        <div className="panel-empty panel-empty-inline">
          <div className="panel-empty-title">
            No {tab === "live" ? "Live" : "Finished"} matches
            {search.trim() ? " for this search" : ""}
          </div>
          {search.trim() ? (
            <button type="button" className="btn-text" onClick={() => setSearch("")}>
              Clear search
            </button>
          ) : tab === "finished" && finished.length === 0 ? (
            <p className="panel-empty-text">
              Finished matches are events Polymarket marks as ended or closed.
            </p>
          ) : null}
        </div>
      ) : (
        <div className="match-list">
          {filtered.map((event) => (
            <MatchRow key={event.eventId} event={event} tab={tab} />
          ))}
        </div>
      )}
    </div>
  );
}

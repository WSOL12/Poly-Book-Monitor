"use client";

import { useQuery } from "@tanstack/react-query";
import { EventList } from "@/components/EventList";
import { Topbar } from "@/components/Topbar";
import type { EventRow } from "@/lib/db";

export function Dashboard({ sport }: { sport?: "soccer" | "football" | "mlb" | "weather" | "tennis" }) {
  const overview = useQuery({
    queryKey: ["overview"],
    queryFn: async () => {
      const res = await fetch("/api/overview");
      return res.json();
    },
    refetchInterval: 5_000,
  });

  const events = useQuery({
    queryKey: ["events", sport ?? "all"],
    queryFn: async () => {
      const url = sport ? `/api/events?sport=${sport}` : "/api/events";
      const res = await fetch(url);
      const body = (await res.json()) as { events: EventRow[] };
      return body.events;
    },
    refetchInterval: 5_000,
  });

  const stats = overview.data;
  const sportLabel = sport ?? "all";

  return (
    <div className="shell">
      <Topbar />

      <header className="dash-head">
        <div>
          <h1 className="dash-title">{sport === "weather" ? "Weather" : "Matches"}</h1>
          <p className="dash-sub">
            {sportLabel === "all" ? "All categories" : sportLabel === "weather" ? "High temp · all cities" : sportLabel}
            {stats ? (
              <>
                {" · "}
                <span className="mono">{stats.events}</span> events
                {" · "}
                <span className="mono">{stats.tokens}</span> tokens
                {" · "}
                <span className="mono">{stats.snapshots?.toLocaleString?.()}</span> snapshots
              </>
            ) : null}
          </p>
        </div>
      </header>

      <EventList events={events.data ?? []} loading={events.isLoading} />
    </div>
  );
}

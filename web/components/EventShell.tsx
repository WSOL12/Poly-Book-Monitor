"use client";

import type { ReactNode } from "react";
import { useParams } from "next/navigation";
import { MatchRail } from "@/components/MatchRail";
import { Topbar } from "@/components/Topbar";
import type { Sport } from "@/lib/db";

const SPORTS = new Set<Sport>(["soccer", "football", "mlb", "weather", "tennis"]);

export function EventShell({ children }: { children: ReactNode }) {
  const params = useParams<{ sport?: string; eventId?: string }>();
  const sportParam = typeof params.sport === "string" ? params.sport : undefined;
  const sport = sportParam && SPORTS.has(sportParam as Sport) ? (sportParam as Sport) : undefined;
  const eventId = typeof params.eventId === "string" ? params.eventId : "";

  return (
    <div className="shell shell-event">
      <Topbar />
      <div className="event-page">
        <MatchRail activeEventId={eventId} sport={sport} />
        {children}
      </div>
    </div>
  );
}

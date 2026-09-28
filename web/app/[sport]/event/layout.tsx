import type { ReactNode } from "react";
import { EventShell } from "@/components/EventShell";

/** Keeps MatchRail mounted while switching /:sport/event/:id — scroll & filters survive. */
export default function SportEventLayout({ children }: { children: ReactNode }) {
  return <EventShell>{children}</EventShell>;
}

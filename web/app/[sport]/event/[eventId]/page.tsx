import EventDetail from "@/components/EventDetail";
import { redirect } from "next/navigation";

const SPORTS = new Set(["soccer", "football", "mlb", "weather", "tennis"]);

export default async function SportEventRoute({
  params,
}: {
  params: Promise<{ sport: string; eventId: string }>;
}) {
  const { sport, eventId } = await params;
  if (!SPORTS.has(sport)) redirect(`/event/${eventId}`);
  // No key={eventId} — EventDetail resets via useEffect; shell/MatchRail stay mounted.
  return <EventDetail eventId={eventId} />;
}

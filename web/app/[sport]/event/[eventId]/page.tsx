import EventDetail from "@/components/EventDetail";
import { redirect } from "next/navigation";

const SPORTS = new Set(["soccer", "football", "mlb", "weather", "tennis", "predictfun"]);

export default async function SportEventRoute({
  params,
}: {
  params: Promise<{ sport: string; eventId: string }>;
}) {
  const { sport, eventId } = await params;
  if (!SPORTS.has(sport)) redirect(`/event/${eventId}`);
  return <EventDetail eventId={eventId} />;
}

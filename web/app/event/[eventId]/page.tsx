import EventDetail from "@/components/EventDetail";

export default async function EventRoute({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  return <EventDetail key={eventId} eventId={eventId} />;
}

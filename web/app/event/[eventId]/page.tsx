import { redirect } from "next/navigation";
import { getEvent } from "@/lib/db";

/** Legacy `/event/:id` → `/:sport/event/:id` */
export default async function LegacyEventRoute({
  params,
}: {
  params: Promise<{ eventId: string }>;
}) {
  const { eventId } = await params;
  const event = getEvent(eventId);
  if (event?.sport) redirect(`/${event.sport}/event/${eventId}`);
  redirect("/");
}

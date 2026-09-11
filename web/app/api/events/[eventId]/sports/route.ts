import { fetchEventBySlug } from "@/lib/gamma";
import { getEvent, recordScoreSnapshot } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await ctx.params;
  const event = getEvent(eventId);
  if (!event) return Response.json({ error: "not found" }, { status: 404 });

  const sports = await fetchEventBySlug(event.slug);
  if (sports) {
    recordScoreSnapshot(
      eventId,
      sports.score?.trim() || null,
      sports.period?.trim() || null,
      sports.elapsed?.trim() || null
    );
  }

  return Response.json({ sports });
}

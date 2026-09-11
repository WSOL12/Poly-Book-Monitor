import { getEvent, getScoreHistory } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await ctx.params;
  const event = getEvent(eventId);
  if (!event) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ scores: getScoreHistory(eventId) });
}

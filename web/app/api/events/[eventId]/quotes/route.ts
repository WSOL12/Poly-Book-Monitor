import { getEvent, getEventQuoteSeries, getEventQuotesAt } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await ctx.params;
  const event = getEvent(eventId);
  if (!event) return Response.json({ error: "not found" }, { status: 404 });

  const atRaw = new URL(req.url).searchParams.get("at");
  if (atRaw != null && atRaw !== "") {
    const at = Number(atRaw);
    if (!Number.isFinite(at)) {
      return Response.json({ error: "invalid at" }, { status: 400 });
    }
    return Response.json({ at, quotes: getEventQuotesAt(eventId, at) });
  }

  return Response.json({ series: getEventQuoteSeries(eventId) });
}

import { findPolyTwins, findPredictTwins, getEvent } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Cross-venue twins: Poly↔Predict.fun by title similarity. */
export async function GET(_req: Request, ctx: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await ctx.params;
  const event = getEvent(eventId);
  if (!event) return Response.json({ error: "not found" }, { status: 404 });

  const lookingFor = event.sport === "predictfun" ? "polymarket" : "predictfun";
  const anchorMs =
    (event.startTime ? Date.parse(event.startTime) : NaN) ||
    (event.eventDate ? Date.parse(event.eventDate) : NaN) ||
    event.finishedAt ||
    event.lastSnapshotAt ||
    null;
  const anchor = typeof anchorMs === "number" && Number.isFinite(anchorMs) ? anchorMs : null;
  const raw =
    lookingFor === "polymarket"
      ? findPolyTwins(event.title, 8, {
          anchorMs: anchor,
          pfEventId: event.eventId,
          pfSlug: event.slug,
        })
      : findPredictTwins(event.title, 8, { anchorMs: anchor });

  const twins = raw.map((t) => ({
    eventId: t.eventId,
    sport: t.sport,
    title: t.title,
    volume: t.volume,
    score: Math.round(t.score * 100) / 100,
    href: `/${t.sport}/event/${t.eventId}`,
  }));

  return Response.json({
    eventId,
    title: event.title,
    sport: event.sport,
    lookingFor,
    twins,
    best: twins[0] ?? null,
  });
}

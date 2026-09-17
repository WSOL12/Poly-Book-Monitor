import { getSnapshotById, type Sport } from "@/lib/db";

export const dynamic = "force-dynamic";

const SPORTS = new Set(["soccer", "football", "mlb", "weather", "tennis"]);

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const snapId = Number(id);
  if (!Number.isFinite(snapId)) {
    return Response.json({ error: "invalid id" }, { status: 400 });
  }
  const url = new URL(req.url);
  const sportParam = url.searchParams.get("sport");
  const day = url.searchParams.get("day");
  const sport =
    sportParam && SPORTS.has(sportParam) ? (sportParam as Sport) : null;
  const snap = getSnapshotById(snapId, sport, day);
  if (!snap) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json(snap);
}

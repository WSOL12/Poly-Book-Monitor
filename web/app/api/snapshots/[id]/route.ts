import { getSnapshotById } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const snapId = Number(id);
  if (!Number.isFinite(snapId)) {
    return Response.json({ error: "invalid id" }, { status: 400 });
  }
  const snap = getSnapshotById(snapId);
  if (!snap) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json(snap);
}

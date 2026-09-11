import { getTokenHistory } from "@/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(_req: Request, ctx: { params: Promise<{ tokenId: string }> }) {
  const { tokenId } = await ctx.params;
  const hist = getTokenHistory(tokenId);
  // Send columnar timeline only — expand on the client (much smaller JSON).
  return Response.json({
    token: hist.token,
    eventTitle: hist.eventTitle,
    totalSnapshots: hist.totalSnapshots,
    eventFinished: hist.eventFinished,
    timeline: hist.timeline,
  });
}

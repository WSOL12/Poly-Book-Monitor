import { getTokenHistory, type Sport } from "@/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(req: Request, ctx: { params: Promise<{ tokenId: string }> }) {
  const { tokenId } = await ctx.params;
  const sportParam = new URL(req.url).searchParams.get("sport");
  const preferSport =
    sportParam === "soccer" ||
    sportParam === "football" ||
    sportParam === "mlb" ||
    sportParam === "weather" ||
    sportParam === "tennis" ||
    sportParam === "predictfun"
      ? (sportParam as Sport)
      : undefined;
  const hist = getTokenHistory(tokenId, preferSport);
  // Send columnar timeline only — expand on the client (much smaller JSON).
  return Response.json({
    token: hist.token,
    eventTitle: hist.eventTitle,
    totalSnapshots: hist.totalSnapshots,
    eventFinished: hist.eventFinished,
    timeline: hist.timeline,
  });
}

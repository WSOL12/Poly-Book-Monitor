import { readFileSync, existsSync } from "node:fs";
import { LINKS_PATH } from "@/lib/paths";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!existsSync(LINKS_PATH)) {
    return Response.json({ updatedAt: null, count: 0, tokenCount: 0, events: [] });
  }
  try {
    const body = JSON.parse(readFileSync(LINKS_PATH, "utf8"));
    return Response.json(body);
  } catch {
    return Response.json({ error: "failed to read links" }, { status: 500 });
  }
}

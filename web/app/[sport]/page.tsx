import { Dashboard } from "@/components/Dashboard";
import { redirect } from "next/navigation";

export default async function SportPage({ params }: { params: Promise<{ sport: string }> }) {
  const { sport } = await params;
  const allowed =
    sport === "soccer" ||
    sport === "football" ||
    sport === "mlb" ||
    sport === "weather" ||
    sport === "tennis" ||
    sport === "predictfun"
      ? sport
      : undefined;
  if (!allowed && sport !== "all") redirect("/");
  return <Dashboard sport={allowed} />;
}

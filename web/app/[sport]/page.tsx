import { Dashboard } from "@/components/Dashboard";

export default async function SportPage({ params }: { params: Promise<{ sport: string }> }) {
  const { sport } = await params;
  const allowed =
    sport === "soccer" ||
    sport === "football" ||
    sport === "mlb" ||
    sport === "weather" ||
    sport === "tennis"
      ? sport
      : undefined;
  return <Dashboard sport={allowed} />;
}

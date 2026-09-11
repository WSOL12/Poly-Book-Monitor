"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useQuery } from "@tanstack/react-query";

const SPORTS = [
  { id: "all", label: "All", href: "/" },
  { id: "soccer", label: "Soccer", href: "/soccer" },
  { id: "football", label: "Football", href: "/football" },
  { id: "mlb", label: "MLB", href: "/mlb" },
  { id: "weather", label: "Weather", href: "/weather" },
] as const;

export function Topbar() {
  const pathname = usePathname();
  const overview = useQuery({
    queryKey: ["overview"],
    queryFn: async () => {
      const res = await fetch("/api/overview");
      return res.json() as Promise<{
        exists: boolean;
        snapshots: number;
        events: number;
      }>;
    },
    refetchInterval: 5_000,
  });

  const sport =
    pathname.startsWith("/soccer") ? "soccer"
    : pathname.startsWith("/football") ? "football"
    : pathname.startsWith("/mlb") ? "mlb"
    : pathname.startsWith("/weather") ? "weather"
    : "all";

  const stats = overview.data;

  return (
    <header className="hdr">
      <Link href="/" className="brand">
        <span className={`brand-dot${stats?.exists ? " live" : ""}`} />
        Poly Monitor
      </Link>

      <nav className="nav" aria-label="Sports">
        {SPORTS.map((row) => (
          <Link
            key={row.id}
            href={row.href}
            className={sport === row.id ? "on" : undefined}
          >
            {row.label}
          </Link>
        ))}
      </nav>

      <div className="hdr-right">
        <span className="hdr-stat">
          <span className={`dot${stats?.exists ? " ok" : " bad"}`} />
          {stats?.exists ? "DB connected" : "DB missing"}
        </span>
        {stats?.snapshots != null ? (
          <span className="hdr-stat mono">{stats.snapshots.toLocaleString()} snaps</span>
        ) : null}
      </div>
    </header>
  );
}

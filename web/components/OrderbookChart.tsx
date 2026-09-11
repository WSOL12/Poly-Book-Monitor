"use client";

import { useMemo } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { SnapshotRow } from "@/lib/db";

function cents(p: number | null | undefined) {
  if (p == null || !Number.isFinite(p)) return null;
  return Math.round(p * 1000) / 10;
}

/** Polymarket-style display price: mid when spread ≤ 10¢, else best ask (fallback bid). */
function displayPrice(snap: SnapshotRow): number | null {
  const bid = snap.bestBid;
  const ask = snap.bestAsk;
  if (bid != null && ask != null) {
    const spread = ask - bid;
    if (spread <= 0.1) return (bid + ask) / 2;
    return ask;
  }
  if (ask != null) return ask;
  if (bid != null) return bid;
  return null;
}

function formatTick(ms: number) {
  return new Date(ms).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

type Pt = { at: number; time: string; price: number };

/**
 * Keep every price change; for long flat stretches keep a sparse heartbeat
 * so the axis still reads time correctly without 18k identical points.
 */
function downsamplePriceSeries(points: Pt[], maxPoints = 1200): Pt[] {
  if (points.length <= maxPoints) return points;

  const out: Pt[] = [points[0]!];
  let lastKept = points[0]!;
  const minGapMs = Math.max(
    2_000,
    (points[points.length - 1]!.at - points[0]!.at) / (maxPoints - 1)
  );

  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i]!;
    const changed = Math.abs(p.price - lastKept.price) >= 0.05;
    const aged = p.at - lastKept.at >= minGapMs;
    if (changed || aged) {
      out.push(p);
      lastKept = p;
    }
  }

  const last = points[points.length - 1]!;
  if (out[out.length - 1]?.at !== last.at) out.push(last);

  if (out.length > maxPoints * 1.2) {
    const step = Math.ceil(out.length / maxPoints);
    const thinned: Pt[] = [];
    for (let i = 0; i < out.length; i += step) thinned.push(out[i]!);
    if (thinned[thinned.length - 1]?.at !== last.at) thinned.push(last);
    return thinned;
  }
  return out;
}

/** Drop hours of settled flatline after the last real price move (or match end). */
function cropActiveWindow(points: Pt[], matchEnd?: number | null): Pt[] {
  if (points.length < 3) return points;

  let lastMove = 0;
  for (let i = 1; i < points.length; i++) {
    if (Math.abs(points[i]!.price - points[i - 1]!.price) >= 0.05) lastMove = i;
  }

  const endAt = Math.min(
    points[points.length - 1]!.at,
    matchEnd != null && Number.isFinite(matchEnd)
      ? matchEnd + 5 * 60_000
      : points[lastMove]!.at + 10 * 60_000
  );

  const cropped = points.filter((p) => p.at <= endAt);
  if (cropped.length < 2) return points.slice(0, Math.min(points.length, lastMove + 2));
  return cropped;
}

export function OrderbookChart({
  snapshots,
  matchEnd,
}: {
  snapshots: SnapshotRow[];
  matchEnd?: number | null;
}) {
  const data = useMemo(() => {
    const raw: Pt[] = [];
    for (const snap of snapshots) {
      const c = cents(displayPrice(snap));
      if (c == null) continue;
      raw.push({
        at: snap.capturedAt,
        time: formatTick(snap.capturedAt),
        price: c,
      });
    }

    return downsamplePriceSeries(cropActiveWindow(raw, matchEnd));
  }, [snapshots, matchEnd]);

  if (!data.length) {
    return <div className="empty">No orderbook snapshots recorded yet.</div>;
  }

  const last = data[data.length - 1]!;

  return (
    <div className="chart-wrap">
      <ResponsiveContainer width="100%" height={360}>
        <AreaChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="polyAskFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#2e6cff" stopOpacity={0.35} />
              <stop offset="100%" stopColor="#2e6cff" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="#23282f" strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="at"
            type="number"
            domain={["dataMin", "dataMax"]}
            tick={{ fill: "#8b939e", fontSize: 11 }}
            minTickGap={48}
            tickFormatter={(v) => formatTick(Number(v))}
          />
          <YAxis
            tick={{ fill: "#8b939e", fontSize: 11 }}
            domain={[0, 100]}
            width={44}
            tickFormatter={(v) => `${v}¢`}
          />
          <Tooltip
            contentStyle={{ background: "#101214", border: "1px solid #23282f", fontSize: 12 }}
            labelFormatter={(v) => formatTick(Number(v))}
            formatter={(value) => [`${value}¢`, "Price"]}
          />
          <Area
            type="stepAfter"
            dataKey="price"
            name="Price"
            stroke="#4d7cff"
            fill="url(#polyAskFill)"
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
            activeDot={{ r: 3, fill: "#4d7cff", stroke: "#fff", strokeWidth: 1 }}
          />
        </AreaChart>
      </ResponsiveContainer>
      <div className="chart-meta mono">
        {data.length.toLocaleString()} pts · last {last.price.toFixed(1)}¢ ·{" "}
        {formatTick(last.at)}
      </div>
    </div>
  );
}

"use client";

import { useMemo } from "react";
import Link from "next/link";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { quoteAtTime } from "@/lib/history";
import { formatVolume } from "@/lib/league";

type QuotePoint = { capturedAt: number; bestBid: number | null; bestAsk: number | null };

type TwinInfo = {
  eventId: string;
  sport: string;
  title: string;
  score: number;
  href: string;
  volume?: number | null;
};

export type CompareLeg = {
  label: string;
  localSeries: QuotePoint[];
  twinSeries: QuotePoint[];
};

function cents(p: number | null | undefined) {
  if (p == null || !Number.isFinite(p)) return "—";
  return `${(p * 100).toFixed(1)}¢`;
}

function mid(q: { bestBid: number | null; bestAsk: number | null } | undefined): number | null {
  if (!q) return null;
  const { bestBid: bid, bestAsk: ask } = q;
  if (bid != null && ask != null) {
    if (ask - bid <= 0.1) return (bid + ask) / 2;
    return ask;
  }
  return ask ?? bid ?? null;
}

function formatTick(ms: number) {
  return new Date(ms).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function downsample(
  points: Array<{ at: number; poly: number | null; pf: number | null }>,
  max = 900
) {
  if (points.length <= max) return points;
  const step = Math.ceil(points.length / max);
  const out: typeof points = [];
  for (let i = 0; i < points.length; i += step) out.push(points[i]!);
  const last = points[points.length - 1]!;
  if (out[out.length - 1]?.at !== last.at) out.push(last);
  return out;
}

function LegPanel({
  leg,
  atMs,
  localVenue,
}: {
  leg: CompareLeg;
  atMs?: number;
  localVenue: "polymarket" | "predictfun";
}) {
  const polySeries = localVenue === "polymarket" ? leg.localSeries : leg.twinSeries;
  const pfSeries = localVenue === "predictfun" ? leg.localSeries : leg.twinSeries;

  const chart = useMemo(() => {
    const times = new Set<number>();
    for (const p of polySeries) times.add(p.capturedAt);
    for (const p of pfSeries) times.add(p.capturedAt);
    const sorted = [...times].sort((a, b) => a - b);
    const rows: Array<{ at: number; poly: number | null; pf: number | null }> = [];
    for (const at of sorted) {
      const poly = mid(quoteAtTime(polySeries, at));
      const pf = mid(quoteAtTime(pfSeries, at));
      if (poly == null && pf == null) continue;
      rows.push({
        at,
        poly: poly != null ? Math.round(poly * 1000) / 10 : null,
        pf: pf != null ? Math.round(pf * 1000) / 10 : null,
      });
    }
    return downsample(rows);
  }, [polySeries, pfSeries]);

  const at = atMs ?? chart[chart.length - 1]?.at;
  const polyNow = at != null ? quoteAtTime(polySeries, at) : undefined;
  const pfNow = at != null ? quoteAtTime(pfSeries, at) : undefined;
  const polyMid = mid(polyNow);
  const pfMid = mid(pfNow);
  const edge =
    polyMid != null && pfMid != null ? Math.round((polyMid - pfMid) * 1000) / 10 : null;

  if (!chart.length) {
    return (
      <div className="venue-compare-leg venue-compare-empty">
        {leg.label}: no overlapping book history
      </div>
    );
  }

  return (
    <div className="venue-compare-leg">
      <div className="venue-compare-leg-head">
        <div className="venue-compare-leg-label">{leg.label}</div>
        <div className="venue-compare-edge mono" title="Polymarket mid − Predict.fun mid (¢)">
          {edge != null ? (
            <>
              edge {edge > 0 ? "+" : ""}
              {edge.toFixed(1)}¢
            </>
          ) : (
            "—"
          )}
        </div>
      </div>

      <div className="venue-compare-tobs">
        <div className="venue-tob venue-tob-poly">
          <div className="venue-tob-label">Polymarket</div>
          <div className="venue-tob-prices mono">
            <span className="aside-bid">{cents(polyNow?.bestBid)}</span>
            <span className="aside-quote-sep">/</span>
            <span className="aside-ask">{cents(polyNow?.bestAsk)}</span>
          </div>
        </div>
        <div className="venue-tob venue-tob-pf">
          <div className="venue-tob-label">Predict.fun</div>
          <div className="venue-tob-prices mono">
            <span className="aside-bid">{cents(pfNow?.bestBid)}</span>
            <span className="aside-quote-sep">/</span>
            <span className="aside-ask">{cents(pfNow?.bestAsk)}</span>
          </div>
        </div>
      </div>

      <div className="venue-compare-chart">
        <ResponsiveContainer width="100%" height={200} minWidth={0}>
          <LineChart data={chart} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="#23282f" strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="at"
              type="number"
              domain={["dataMin", "dataMax"]}
              tick={{ fill: "#8b939e", fontSize: 10 }}
              minTickGap={40}
              tickFormatter={(v) => formatTick(Number(v))}
            />
            <YAxis
              domain={[0, 100]}
              width={40}
              tick={{ fill: "#8b939e", fontSize: 10 }}
              tickFormatter={(v) => `${v}¢`}
            />
            <Tooltip
              contentStyle={{ background: "#101214", border: "1px solid #23282f", fontSize: 12 }}
              labelFormatter={(v) => formatTick(Number(v))}
              formatter={(value, name) =>
                value == null ? [null, ""] : [`${value}¢`, String(name)]
              }
            />
            <Legend wrapperStyle={{ fontSize: 11, color: "#8b939e" }} iconType="line" />
            <Line
              type="stepAfter"
              dataKey="poly"
              name="Polymarket"
              stroke="#4d7cff"
              strokeWidth={2}
              dot={false}
              connectNulls
              isAnimationActive={false}
            />
            <Line
              type="stepAfter"
              dataKey="pf"
              name="Predict.fun"
              stroke="#d4a5ff"
              strokeWidth={2}
              dot={false}
              connectNulls
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

/**
 * Side-by-side Polymarket vs Predict.fun price movement for matched outcomes.
 * Pass one leg per moneyline side (home + away). Scrub clock drives both TOBs.
 */
export function VenueCompare({
  twin,
  legs,
  atMs,
  localVenue,
}: {
  twin: TwinInfo;
  legs: CompareLeg[];
  atMs?: number;
  localVenue: "polymarket" | "predictfun";
}) {
  const usable = legs.filter((l) => l.localSeries.length || l.twinSeries.length);

  if (!usable.length) {
    return (
      <div className="venue-compare venue-compare-empty">
        Twin found but no overlapping book history to compare.
      </div>
    );
  }

  return (
    <section className="venue-compare">
      <div className="venue-compare-head">
        <div>
          <h3 className="venue-compare-title">Poly ↔ Predict.fun</h3>
          <p className="venue-compare-sub">
            Orderbook mid movement · both sides
            {" · "}
            {twin.sport === "predictfun" ? (
              <span>{twin.title}</span>
            ) : (
              <Link href={twin.href}>{twin.title}</Link>
            )}
            <span className="mono"> · {Math.round(twin.score * 100)}% match</span>
            {twin.volume != null && twin.volume > 0 ? (
              <span className="mono"> · PF {formatVolume(twin.volume)}</span>
            ) : null}
          </p>
        </div>
      </div>

      <div className="venue-compare-legs">
        {usable.map((leg) => (
          <LegPanel key={leg.label} leg={leg} atMs={atMs} localVenue={localVenue} />
        ))}
      </div>
      <div className="venue-compare-hint mono">
        Prices follow the order-book scrubber · blue = Poly · purple = Predict.fun
      </div>
    </section>
  );
}

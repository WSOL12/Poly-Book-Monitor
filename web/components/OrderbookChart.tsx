"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Area,
  Brush,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
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
type DualPt = { at: number; time: string; a?: number; b?: number };

export type ChartSeries = {
  key: string;
  label: string;
  color: string;
  snapshots: SnapshotRow[];
};

export type ChartStyle = "single" | "dual";

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

function toPricePoints(snapshots: SnapshotRow[]): Pt[] {
  const raw: Pt[] = [];
  for (const snap of snapshots) {
    const c = cents(displayPrice(snap));
    if (c == null) continue;
    raw.push({ at: snap.capturedAt, time: formatTick(snap.capturedAt), price: c });
  }
  return raw;
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

function mergeDualSeries(a: Pt[], b: Pt[], matchEnd?: number | null): DualPt[] {
  const aCrop = cropActiveWindow(a, matchEnd);
  const bCrop = cropActiveWindow(b, matchEnd);
  const times = new Set<number>();
  for (const p of aCrop) times.add(p.at);
  for (const p of bCrop) times.add(p.at);
  const sorted = [...times].sort((x, y) => x - y);
  if (!sorted.length) return [];

  let ia = 0;
  let ib = 0;
  let lastA: number | undefined;
  let lastB: number | undefined;
  const out: DualPt[] = [];

  for (const at of sorted) {
    while (ia < aCrop.length && aCrop[ia]!.at <= at) {
      lastA = aCrop[ia]!.price;
      ia++;
    }
    while (ib < bCrop.length && bCrop[ib]!.at <= at) {
      lastB = bCrop[ib]!.price;
      ib++;
    }
    out.push({ at, time: formatTick(at), a: lastA, b: lastB });
  }

  // Downsample merged series on either-side changes.
  if (out.length <= 1600) return out;
  const thinned: DualPt[] = [out[0]!];
  let last = out[0]!;
  const minGap = Math.max(2_000, (out[out.length - 1]!.at - out[0]!.at) / 1400);
  for (let i = 1; i < out.length - 1; i++) {
    const p = out[i]!;
    const changed =
      (p.a != null && last.a != null && Math.abs(p.a - last.a) >= 0.05) ||
      (p.b != null && last.b != null && Math.abs(p.b - last.b) >= 0.05) ||
      p.a !== last.a ||
      p.b !== last.b;
    const aged = p.at - last.at >= minGap;
    if (changed || aged) {
      thinned.push(p);
      last = p;
    }
  }
  const end = out[out.length - 1]!;
  if (thinned[thinned.length - 1]?.at !== end.at) thinned.push(end);
  return thinned;
}

const MIN_SPAN_MS = 60_000;

const COLOR_A = "#4d7cff";
const COLOR_B = "#e8a838";

function IconOneLine() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
      <path d="M2 8h12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function IconTwoLines() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
      <path
        d="M2 5.5h12M2 10.5h12"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function OrderbookChart({
  series,
  style = "single",
  onStyleChange,
  matchEnd,
  canDual = false,
}: {
  series: ChartSeries[];
  style?: ChartStyle;
  onStyleChange?: (style: ChartStyle) => void;
  matchEnd?: number | null;
  canDual?: boolean;
}) {
  const primary = series[0];
  const secondary = series[1];
  const dual = style === "dual" && Boolean(secondary);

  const singleData = useMemo(() => {
    if (!primary) return [] as Pt[];
    return downsamplePriceSeries(cropActiveWindow(toPricePoints(primary.snapshots), matchEnd));
  }, [primary, matchEnd]);

  const dualData = useMemo(() => {
    if (!primary || !secondary) return [] as DualPt[];
    return mergeDualSeries(
      toPricePoints(primary.snapshots),
      toPricePoints(secondary.snapshots),
      matchEnd
    );
  }, [primary, secondary, matchEnd]);

  const dataAt = dual ? dualData.map((d) => d.at) : singleData.map((d) => d.at);
  const fullLo = dataAt[0] ?? 0;
  const fullHi = dataAt[dataAt.length - 1] ?? 0;
  const fullSpan = Math.max(0, fullHi - fullLo);

  const [domain, setDomain] = useState<[number, number] | null>(null);

  useEffect(() => {
    setDomain(null);
  }, [fullLo, fullHi, style]);

  const viewLo = domain?.[0] ?? fullLo;
  const viewHi = domain?.[1] ?? fullHi;
  const zoomed = domain != null && (viewLo > fullLo + 1 || viewHi < fullHi - 1);

  const clampDomain = useCallback(
    (lo: number, hi: number): [number, number] => {
      let nextLo = Math.max(fullLo, Math.min(lo, fullHi));
      let nextHi = Math.max(fullLo, Math.min(hi, fullHi));
      if (nextHi - nextLo < MIN_SPAN_MS) {
        const mid = (nextLo + nextHi) / 2;
        nextLo = Math.max(fullLo, mid - MIN_SPAN_MS / 2);
        nextHi = Math.min(fullHi, nextLo + MIN_SPAN_MS);
        nextLo = Math.max(fullLo, nextHi - MIN_SPAN_MS);
      }
      return [nextLo, nextHi];
    },
    [fullLo, fullHi]
  );

  const zoomBy = useCallback(
    (factor: number, anchorRatio = 0.5) => {
      if (fullSpan <= 0) return;
      const span = viewHi - viewLo;
      const nextSpan = span * factor;
      const anchor = viewLo + span * Math.min(1, Math.max(0, anchorRatio));
      const next = clampDomain(anchor - nextSpan * anchorRatio, anchor + nextSpan * (1 - anchorRatio));
      if (next[0] <= fullLo + 1 && next[1] >= fullHi - 1) setDomain(null);
      else setDomain(next);
    },
    [viewLo, viewHi, fullLo, fullHi, fullSpan, clampDomain]
  );

  const chartRef = useRef<HTMLDivElement>(null);
  const zoomByRef = useRef(zoomBy);
  zoomByRef.current = zoomBy;

  useEffect(() => {
    const el = chartRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (fullSpan <= 0) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const plotLeft = rect.left + 44;
      const plotWidth = Math.max(1, rect.width - 56);
      const ratio = Math.min(1, Math.max(0, (e.clientX - plotLeft) / plotWidth));
      zoomByRef.current(e.deltaY < 0 ? 0.8 : 1.25, ratio);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [fullSpan]);

  const indexData = dual ? dualData : singleData;

  const onBrushChange = useCallback(
    (range: { startIndex?: number; endIndex?: number } | null) => {
      if (!range || range.startIndex == null || range.endIndex == null || !indexData.length) {
        setDomain(null);
        return;
      }
      const a = indexData[range.startIndex]?.at;
      const b = indexData[range.endIndex]?.at;
      if (a == null || b == null) return;
      const next = clampDomain(Math.min(a, b), Math.max(a, b));
      if (next[0] <= fullLo + 1 && next[1] >= fullHi - 1) setDomain(null);
      else setDomain(next);
    },
    [indexData, clampDomain, fullLo, fullHi]
  );

  const brushStart = useMemo(() => {
    if (!indexData.length) return 0;
    let best = 0;
    for (let i = 0; i < indexData.length; i++) {
      if (indexData[i]!.at <= viewLo) best = i;
      else break;
    }
    return best;
  }, [indexData, viewLo]);

  const brushEnd = useMemo(() => {
    if (!indexData.length) return 0;
    let best = indexData.length - 1;
    for (let i = 0; i < indexData.length; i++) {
      if (indexData[i]!.at <= viewHi) best = i;
      else break;
    }
    return Math.max(brushStart, best);
  }, [indexData, viewHi, brushStart]);

  const lastIdx = Math.max(0, indexData.length - 1);
  const safeBrushStart = Math.min(Math.max(0, brushStart), lastIdx);
  const safeBrushEnd = Math.min(Math.max(safeBrushStart, brushEnd), lastIdx);

  // Keep toolbar visible while the second series loads — don't flash empty.
  const ready = dual ? dualData.length > 0 : singleData.length > 0;
  if (!primary || !ready) {
    return (
      <div className="chart-wrap">
        <div className="chart-toolbar">
          <div className="chart-toolbar-left">
            {onStyleChange ? (
              <div className="chart-style" role="group" aria-label="Graph style">
                <button
                  type="button"
                  className={`chart-style-btn${style === "single" ? " on" : ""}`}
                  onClick={() => onStyleChange("single")}
                  title="One outcome"
                  aria-label="One line"
                >
                  <IconOneLine />
                </button>
                <button
                  type="button"
                  className={`chart-style-btn${style === "dual" ? " on" : ""}`}
                  onClick={() => onStyleChange("dual")}
                  disabled={!canDual}
                  title={canDual ? "Both outcomes" : "Need two outcomes"}
                  aria-label="Two lines"
                >
                  <IconTwoLines />
                </button>
              </div>
            ) : null}
          </div>
        </div>
        <div className="empty">
          {dual && canDual ? "Loading both outcomes…" : "No orderbook snapshots recorded yet."}
        </div>
      </div>
    );
  }

  const lastSingle = singleData[singleData.length - 1];
  const lastDual = dualData[dualData.length - 1];
  const canZoomIn = viewHi - viewLo > MIN_SPAN_MS * 1.5;
  const labelA = primary.label;
  const labelB = secondary?.label ?? "Other";
  const colorA = primary.color || COLOR_A;
  const colorB = secondary?.color || COLOR_B;

  // One chart type always — swapping AreaChart/LineChart crashed ResponsiveContainer.
  const chartRows = dual
    ? dualData
    : singleData.map((p) => ({ at: p.at, time: p.time, a: p.price as number | undefined }));

  return (
    <div className="chart-wrap">
      <div className="chart-toolbar">
        <div className="chart-toolbar-left">
          {onStyleChange ? (
            <div className="chart-style" role="group" aria-label="Graph style">
              <button
                type="button"
                className={`chart-style-btn${style === "single" ? " on" : ""}`}
                onClick={() => onStyleChange("single")}
                title="One outcome"
                aria-label="One line"
              >
                <IconOneLine />
              </button>
              <button
                type="button"
                className={`chart-style-btn${style === "dual" ? " on" : ""}`}
                onClick={() => onStyleChange("dual")}
                disabled={!canDual}
                title={canDual ? "Both outcomes" : "Need two outcomes"}
                aria-label="Two lines"
              >
                <IconTwoLines />
              </button>
            </div>
          ) : null}
          <div className="chart-zoom" role="group" aria-label="Zoom time axis">
            <button
              type="button"
              className="chart-zoom-btn"
              disabled={!canZoomIn}
              onClick={() => zoomBy(0.5)}
              title="Zoom in (time)"
            >
              Zoom in
            </button>
            <button
              type="button"
              className="chart-zoom-btn"
              disabled={!zoomed}
              onClick={() => zoomBy(2)}
              title="Zoom out (time)"
            >
              Zoom out
            </button>
            <button
              type="button"
              className="chart-zoom-btn"
              disabled={!zoomed}
              onClick={() => setDomain(null)}
              title="Reset time range"
            >
              Reset
            </button>
          </div>
        </div>
        <span className="chart-zoom-hint mono">Scroll to zoom · drag bar to pan</span>
      </div>
      <div className="chart-plot" ref={chartRef}>
        <ResponsiveContainer width="100%" height={360} minWidth={0}>
          <ComposedChart data={chartRows} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="polyAskFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={colorA} stopOpacity={0.35} />
                <stop offset="100%" stopColor={colorA} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="#23282f" strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="at"
              type="number"
              domain={[viewLo, viewHi]}
              allowDataOverflow
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
              formatter={(value, name) =>
                value == null || value === "" ? [null, ""] : [`${value}¢`, String(name)]
              }
            />
            {dual ? (
              <Legend
                wrapperStyle={{ fontSize: 11, color: "#8b939e", paddingTop: 4 }}
                iconType="line"
              />
            ) : null}
            {!dual ? (
              <Area
                type="stepAfter"
                dataKey="a"
                name={labelA}
                stroke={colorA}
                fill="url(#polyAskFill)"
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
                activeDot={{ r: 3, fill: colorA, stroke: "#fff", strokeWidth: 1 }}
              />
            ) : (
              <Line
                type="stepAfter"
                dataKey="a"
                name={labelA}
                stroke={colorA}
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
                connectNulls
                activeDot={{ r: 3, fill: colorA, stroke: "#fff", strokeWidth: 1 }}
              />
            )}
            {dual ? (
              <Line
                type="stepAfter"
                dataKey="b"
                name={labelB}
                stroke={colorB}
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
                connectNulls
                activeDot={{ r: 3, fill: colorB, stroke: "#fff", strokeWidth: 1 }}
              />
            ) : null}
            <Brush
              dataKey="at"
              height={28}
              stroke="#3d4450"
              fill="#14171c"
              travellerWidth={8}
              startIndex={safeBrushStart}
              endIndex={safeBrushEnd}
              onChange={onBrushChange}
              tickFormatter={(v) => formatTick(Number(v))}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="chart-meta mono">
        {dual ? (
          <>
            {dualData.length.toLocaleString()} pts
            {lastDual?.a != null ? ` · ${labelA} ${lastDual.a.toFixed(1)}¢` : ""}
            {lastDual?.b != null ? ` · ${labelB} ${lastDual.b.toFixed(1)}¢` : ""}
          </>
        ) : (
          <>
            {singleData.length.toLocaleString()} pts · last {lastSingle!.price.toFixed(1)}¢ ·{" "}
            {formatTick(lastSingle!.at)}
          </>
        )}
        {zoomed ? ` · view ${formatTick(viewLo)} → ${formatTick(viewHi)}` : ""}
      </div>
    </div>
  );
}

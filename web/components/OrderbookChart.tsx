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
type DepthPt = { at: number; time: string; bid: number; ask: number };

export type ChartSeries = {
  key: string;
  label: string;
  color: string;
  snapshots: SnapshotRow[];
};

export type ChartStyle = "single" | "dual";
export type ChartMetric = "price" | "depth";
/** Whole book, or size within N¢ of best bid / best ask. */
export type DepthBand = "whole" | "3" | "5" | "10";

function depthFromSnap(snap: SnapshotRow, band: DepthBand): { bid: number; ask: number } {
  if (band === "3") return { bid: snap.bidNear3 ?? 0, ask: snap.askNear3 ?? 0 };
  if (band === "5") return { bid: snap.bidNear5 ?? 0, ask: snap.askNear5 ?? 0 };
  if (band === "10") return { bid: snap.bidNear10 ?? 0, ask: snap.askNear10 ?? 0 };
  return { bid: snap.bidDepth || 0, ask: snap.askDepth || 0 };
}

function toDepthPoints(snapshots: SnapshotRow[], band: DepthBand): DepthPt[] {
  const raw: DepthPt[] = [];
  for (const snap of snapshots) {
    const d = depthFromSnap(snap, band);
    raw.push({ at: snap.capturedAt, time: formatTick(snap.capturedAt), bid: d.bid, ask: d.ask });
  }
  return raw;
}

function downsampleDepthSeries(points: DepthPt[], maxPoints = 1200): DepthPt[] {
  if (points.length <= maxPoints) return points;
  const out: DepthPt[] = [points[0]!];
  let lastKept = points[0]!;
  const minGapMs = Math.max(
    2_000,
    (points[points.length - 1]!.at - points[0]!.at) / (maxPoints - 1),
  );
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i]!;
    const changed =
      Math.abs(p.bid - lastKept.bid) >= Math.max(1, lastKept.bid * 0.02) ||
      Math.abs(p.ask - lastKept.ask) >= Math.max(1, lastKept.ask * 0.02);
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
    const thinned: DepthPt[] = [];
    for (let i = 0; i < out.length; i += step) thinned.push(out[i]!);
    if (thinned[thinned.length - 1]?.at !== last.at) thinned.push(last);
    return thinned;
  }
  return out;
}

function cropDepthWindow(points: DepthPt[], matchEnd?: number | null): DepthPt[] {
  if (points.length < 3) return points;
  let lastMove = 0;
  for (let i = 1; i < points.length; i++) {
    if (
      Math.abs(points[i]!.bid - points[i - 1]!.bid) >= 1 ||
      Math.abs(points[i]!.ask - points[i - 1]!.ask) >= 1
    ) {
      lastMove = i;
    }
  }
  const endAt = Math.min(
    points[points.length - 1]!.at,
    matchEnd != null && Number.isFinite(matchEnd)
      ? matchEnd + 5 * 60_000
      : points[lastMove]!.at + 10 * 60_000,
  );
  const cropped = points.filter((p) => p.at <= endAt);
  if (cropped.length < 2) return points.slice(0, Math.min(points.length, lastMove + 2));
  return cropped;
}

function formatShares(n: number) {
  if (!Number.isFinite(n)) return "—";
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return n >= 10 ? n.toFixed(0) : n.toFixed(1);
}

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
  const [metric, setMetric] = useState<ChartMetric>("price");
  const [depthBand, setDepthBand] = useState<DepthBand>("5");
  const dual = metric === "price" && style === "dual" && Boolean(secondary);

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

  const depthData = useMemo(() => {
    if (!primary) return [] as DepthPt[];
    return downsampleDepthSeries(cropDepthWindow(toDepthPoints(primary.snapshots, depthBand), matchEnd));
  }, [primary, matchEnd, depthBand]);

  const dataAt =
    metric === "depth"
      ? depthData.map((d) => d.at)
      : dual
        ? dualData.map((d) => d.at)
        : singleData.map((d) => d.at);
  const fullLo = dataAt[0] ?? 0;
  const fullHi = dataAt[dataAt.length - 1] ?? 0;
  const fullSpan = Math.max(0, fullHi - fullLo);

  const [domain, setDomain] = useState<[number, number] | null>(null);

  useEffect(() => {
    setDomain(null);
  }, [fullLo, fullHi, style, metric, depthBand]);

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
  const clampDomainRef = useRef(clampDomain);
  clampDomainRef.current = clampDomain;
  const viewRef = useRef({ viewLo, viewHi, fullLo, fullHi, fullSpan });
  viewRef.current = { viewLo, viewHi, fullLo, fullHi, fullSpan };
  const [dragging, setDragging] = useState(false);
  /** Brush indices owned here so Recharts doesn't fight controlled start/end mid-drag. */
  const [brushIdx, setBrushIdx] = useState<{ start: number; end: number } | null>(null);
  const indexDataRef = useRef<Array<{ at: number }>>([]);

  const indexAt = useCallback((at: number, data: Array<{ at: number }>) => {
    if (!data.length) return 0;
    let best = 0;
    for (let i = 0; i < data.length; i++) {
      if (data[i]!.at <= at) best = i;
      else break;
    }
    return best;
  }, []);

  const syncBrushToDomain = useCallback(
    (lo: number, hi: number, data: Array<{ at: number }>) => {
      if (!data.length) {
        setBrushIdx(null);
        return;
      }
      const last = data.length - 1;
      const start = Math.min(Math.max(0, indexAt(lo, data)), last);
      const end = Math.min(Math.max(start, indexAt(hi, data)), last);
      setBrushIdx({ start, end });
    },
    [indexAt]
  );
  const syncBrushRef = useRef(syncBrushToDomain);
  syncBrushRef.current = syncBrushToDomain;

  useEffect(() => {
    const el = chartRef.current;
    if (!el) return;

    const plotMetrics = (clientX: number) => {
      const rect = el.getBoundingClientRect();
      const plotLeft = rect.left + 44;
      const plotWidth = Math.max(1, rect.width - 56);
      const ratio = Math.min(1, Math.max(0, (clientX - plotLeft) / plotWidth));
      return { plotWidth, ratio };
    };

    const onWheel = (e: WheelEvent) => {
      if (viewRef.current.fullSpan <= 0) return;
      e.preventDefault();
      const { ratio } = plotMetrics(e.clientX);
      zoomByRef.current(e.deltaY < 0 ? 0.8 : 1.25, ratio);
    };

    type DragState = {
      pointerId: number;
      startX: number;
      baseLo: number;
      baseHi: number;
      plotWidth: number;
      lastLo: number;
      lastHi: number;
    };
    let drag: DragState | null = null;

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      // Ignore drags that start on the brush strip (bottom ~36px).
      const rect = el.getBoundingClientRect();
      if (e.clientY > rect.bottom - 40) return;
      if (viewRef.current.fullSpan <= 0) return;
      const { plotWidth } = plotMetrics(e.clientX);
      const { viewLo: lo, viewHi: hi } = viewRef.current;
      drag = {
        pointerId: e.pointerId,
        startX: e.clientX,
        baseLo: lo,
        baseHi: hi,
        plotWidth,
        lastLo: lo,
        lastHi: hi,
      };
      el.setPointerCapture(e.pointerId);
      setDragging(true);
      e.preventDefault();
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      const span = drag.baseHi - drag.baseLo;
      if (span <= 0 || drag.plotWidth <= 0) return;
      const dx = e.clientX - drag.startX;
      const dt = (-dx / drag.plotWidth) * span;
      const next = clampDomainRef.current(drag.baseLo + dt, drag.baseHi + dt);
      drag.lastLo = next[0];
      drag.lastHi = next[1];
      const { fullLo: flo, fullHi: fhi } = viewRef.current;
      if (next[0] <= flo + 1 && next[1] >= fhi - 1) setDomain(null);
      else setDomain(next);
    };

    const endDrag = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      const finished = drag;
      drag = null;
      setDragging(false);
      const { fullLo: flo, fullHi: fhi } = viewRef.current;
      if (finished.lastLo <= flo + 1 && finished.lastHi >= fhi - 1) {
        setBrushIdx(null);
      } else {
        syncBrushRef.current(finished.lastLo, finished.lastHi, indexDataRef.current);
      }
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup", endDrag);
    el.addEventListener("pointercancel", endDrag);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup", endDrag);
      el.removeEventListener("pointercancel", endDrag);
    };
  }, [fullSpan]);

  const indexData = metric === "depth" ? depthData : dual ? dualData : singleData;
  indexDataRef.current = indexData;

  // Remount / resync brush when the underlying series changes.
  useEffect(() => {
    setBrushIdx(null);
  }, [fullLo, fullHi, metric, depthBand, style]);

  const onBrushChange = useCallback(
    (range: { startIndex?: number; endIndex?: number } | null) => {
      if (!range || range.startIndex == null || range.endIndex == null || !indexData.length) {
        setBrushIdx(null);
        setDomain(null);
        return;
      }
      const start = Math.min(range.startIndex, range.endIndex);
      const end = Math.max(range.startIndex, range.endIndex);
      setBrushIdx({ start, end });
      const a = indexData[start]?.at;
      const b = indexData[end]?.at;
      if (a == null || b == null) return;
      const next = clampDomain(Math.min(a, b), Math.max(a, b));
      if (next[0] <= fullLo + 1 && next[1] >= fullHi - 1) {
        setDomain(null);
        setBrushIdx(null);
      } else {
        setDomain(next);
      }
    },
    [indexData, clampDomain, fullLo, fullHi]
  );

  const zoomByAndSyncBrush = useCallback(
    (factor: number, anchorRatio = 0.5) => {
      if (fullSpan <= 0) return;
      const span = viewHi - viewLo;
      const nextSpan = span * factor;
      const anchor = viewLo + span * Math.min(1, Math.max(0, anchorRatio));
      const next = clampDomain(anchor - nextSpan * anchorRatio, anchor + nextSpan * (1 - anchorRatio));
      if (next[0] <= fullLo + 1 && next[1] >= fullHi - 1) {
        setDomain(null);
        setBrushIdx(null);
      } else {
        setDomain(next);
        syncBrushToDomain(next[0], next[1], indexData);
      }
    },
    [viewLo, viewHi, fullLo, fullHi, fullSpan, clampDomain, syncBrushToDomain, indexData]
  );

  // Wheel zoom should also keep the brush strip in sync.
  zoomByRef.current = zoomByAndSyncBrush;

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
  const safeBrushStart = Math.min(Math.max(0, brushIdx?.start ?? brushStart), lastIdx);
  const safeBrushEnd = Math.min(Math.max(safeBrushStart, brushIdx?.end ?? brushEnd), lastIdx);

  // Keep toolbar visible while the second series loads — don't flash empty.
  const ready =
    metric === "depth" ? depthData.length > 0 : dual ? dualData.length > 0 : singleData.length > 0;

  const lastSingle = singleData[singleData.length - 1];
  const lastDual = dualData[dualData.length - 1];
  const lastDepth = depthData[depthData.length - 1];
  const canZoomIn = viewHi - viewLo > MIN_SPAN_MS * 1.5;
  const labelA = primary?.label ?? "Price";
  const labelB = secondary?.label ?? "Other";
  const colorA = primary?.color || COLOR_A;
  const colorB = secondary?.color || COLOR_B;
  const COLOR_BID = "#3ecf8e";
  const COLOR_ASK = "#ef6b6b";
  const bandLabel =
    depthBand === "whole" ? "Whole book" : `Within ${depthBand}¢ of touch`;

  const depthMax = useMemo(() => {
    if (metric !== "depth" || !depthData.length) return 10;
    let m = 1;
    for (const p of depthData) m = Math.max(m, p.bid, p.ask);
    return Math.ceil(m * 1.08);
  }, [metric, depthData]);

  type ChartRow = {
    at: number;
    time: string;
    a?: number;
    b?: number;
    bid?: number;
    ask?: number;
  };
  const chartRows: ChartRow[] =
    metric === "depth"
      ? depthData
      : dual
        ? dualData
        : singleData.map((p) => ({ at: p.at, time: p.time, a: p.price }));

  const toolbar = (
    <div className="chart-toolbar">
      <div className="chart-toolbar-left">
        <div className="chart-style" role="group" aria-label="Chart metric">
          <button
            type="button"
            className={`chart-style-btn chart-style-btn-wide${metric === "price" ? " on" : ""}`}
            onClick={() => setMetric("price")}
            title="Price over time"
          >
            Price
          </button>
          <button
            type="button"
            className={`chart-style-btn chart-style-btn-wide${metric === "depth" ? " on" : ""}`}
            onClick={() => setMetric("depth")}
            title="Bid / ask depth size over time"
          >
            Depth
          </button>
        </div>
        {metric === "price" && onStyleChange ? (
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
        {metric === "depth" ? (
          <div className="chart-style" role="group" aria-label="Depth band">
            {(
              [
                ["whole", "All"],
                ["3", "3¢"],
                ["5", "5¢"],
                ["10", "10¢"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={`chart-style-btn chart-style-btn-wide${depthBand === id ? " on" : ""}`}
                onClick={() => setDepthBand(id)}
                title={
                  id === "whole"
                    ? "Total bid / ask size"
                    : `Size within ${id}¢ of best bid / best ask`
                }
              >
                {label}
              </button>
            ))}
          </div>
        ) : null}
        <div className="chart-zoom" role="group" aria-label="Zoom time axis">
          <button
            type="button"
            className="chart-zoom-btn"
            disabled={!canZoomIn || !ready}
            onClick={() => zoomByAndSyncBrush(0.5)}
            title="Zoom in (time)"
          >
            Zoom in
          </button>
          <button
            type="button"
            className="chart-zoom-btn"
            disabled={!zoomed}
            onClick={() => zoomByAndSyncBrush(2)}
            title="Zoom out (time)"
          >
            Zoom out
          </button>
          <button
            type="button"
            className="chart-zoom-btn"
            disabled={!zoomed}
            onClick={() => {
              setDomain(null);
              setBrushIdx(null);
            }}
            title="Reset time range"
          >
            Reset
          </button>
        </div>
      </div>
      <span className="chart-zoom-hint mono">
        {metric === "depth" ? `${bandLabel} · ` : ""}
        Drag chart to pan · scroll to zoom · drag bar to select
      </span>
    </div>
  );

  if (!primary || !ready) {
    return (
      <div className="chart-wrap">
        {toolbar}
        <div className="empty">
          {dual && canDual ? "Loading both outcomes…" : "No orderbook snapshots recorded yet."}
        </div>
      </div>
    );
  }

  return (
    <div className="chart-wrap">
      {toolbar}
      <div
        className={`chart-plot${dragging ? " chart-plot-dragging" : ""}`}
        ref={chartRef}
        title="Drag to pan · scroll to zoom"
      >
        <ResponsiveContainer width="100%" height={360} minWidth={0}>
          <ComposedChart data={chartRows} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="polyAskFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={colorA} stopOpacity={0.35} />
                <stop offset="100%" stopColor={colorA} stopOpacity={0.02} />
              </linearGradient>
              <linearGradient id="polyBidDepthFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={COLOR_BID} stopOpacity={0.4} />
                <stop offset="100%" stopColor={COLOR_BID} stopOpacity={0.05} />
              </linearGradient>
              <linearGradient id="polyAskDepthFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={COLOR_ASK} stopOpacity={0.4} />
                <stop offset="100%" stopColor={COLOR_ASK} stopOpacity={0.05} />
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
              domain={metric === "depth" ? [0, depthMax] : [0, 100]}
              width={48}
              tickFormatter={(v) => (metric === "depth" ? formatShares(Number(v)) : `${v}¢`)}
            />
            <Tooltip
              contentStyle={{ background: "#101214", border: "1px solid #23282f", fontSize: 12 }}
              labelFormatter={(v) => formatTick(Number(v))}
              formatter={(value, name) => {
                if (value == null || value === "") return [null, ""];
                if (metric === "depth") return [formatShares(Number(value)), String(name)];
                return [`${value}¢`, String(name)];
              }}
            />
            {metric === "depth" || dual ? (
              <Legend
                wrapperStyle={{ fontSize: 11, color: "#8b939e", paddingTop: 4 }}
                iconType="line"
              />
            ) : null}
            {metric === "depth" ? (
              <>
                <Area
                  type="stepAfter"
                  dataKey="bid"
                  name="Bid size"
                  stroke={COLOR_BID}
                  fill="url(#polyBidDepthFill)"
                  strokeWidth={1.5}
                  dot={false}
                  isAnimationActive={false}
                  activeDot={{ r: 3, fill: COLOR_BID, stroke: "#fff", strokeWidth: 1 }}
                />
                <Area
                  type="stepAfter"
                  dataKey="ask"
                  name="Ask size"
                  stroke={COLOR_ASK}
                  fill="url(#polyAskDepthFill)"
                  strokeWidth={1.5}
                  dot={false}
                  isAnimationActive={false}
                  activeDot={{ r: 3, fill: COLOR_ASK, stroke: "#fff", strokeWidth: 1 }}
                />
              </>
            ) : !dual ? (
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
            {metric === "price" && dual ? (
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
        {metric === "depth" ? (
          <>
            {depthData.length.toLocaleString()} pts · {bandLabel}
            {lastDepth
              ? ` · bid ${formatShares(lastDepth.bid)} / ask ${formatShares(lastDepth.ask)}`
              : ""}
            {lastDepth ? ` · ${formatTick(lastDepth.at)}` : ""}
          </>
        ) : dual ? (
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

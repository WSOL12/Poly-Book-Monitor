"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { SnapshotRow } from "@/lib/db";
import { cls } from "@/lib/format";
import { elapsedLabel, timelineClock, timelineDateTime } from "@/lib/time";

function cents(p: number | null | undefined) {
  if (p == null || !Number.isFinite(p)) return "—";
  const c = p * 100;
  return `${Number.isInteger(c) ? c.toFixed(0) : c.toFixed(1)}¢`;
}

function shares(n: number) {
  if (!Number.isFinite(n)) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return n >= 100 ? n.toFixed(2) : n.toFixed(2);
}

function dollars(price: number, size: number) {
  const v = price * size;
  if (!Number.isFinite(v)) return "—";
  if (v >= 1000) return `$${v.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  return `$${v.toFixed(2)}`;
}

function withTotals(levels: Array<{ price: number; size: number }>, side: "ask" | "bid") {
  let total = 0;
  const rows = levels.map((l) => {
    total += l.size;
    return { ...l, total };
  });
  return side === "ask" ? [...rows].reverse() : rows;
}

export function pickInitialFrame(snapshots: SnapshotRow[], startAtBeginning: boolean) {
  if (!snapshots.length) return 0;
  const hasBook = (s: SnapshotRow) =>
    (s.asks.length > 0 && s.bids.length > 0) || (s.bestAsk != null && s.bestBid != null);
  if (!startAtBeginning) {
    for (let i = snapshots.length - 1; i >= 0; i--) {
      if (hasBook(snapshots[i]!)) return i;
    }
    return snapshots.length - 1;
  }
  const twoSided = snapshots.findIndex(hasBook);
  if (twoSided >= 0) return twoSided;
  return 0;
}

function parseIsoMs(raw: string | null | undefined) {
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : null;
}

function lowerBoundAt(snapshots: SnapshotRow[], targetAt: number) {
  let lo = 0;
  let hi = snapshots.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (snapshots[mid]!.capturedAt < targetAt) lo = mid + 1;
    else hi = mid;
  }
  return Math.min(lo, Math.max(0, snapshots.length - 1));
}

function upperBoundAt(snapshots: SnapshotRow[], targetAt: number) {
  let lo = 0;
  let hi = snapshots.length - 1;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (snapshots[mid]!.capturedAt <= targetAt) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

/** Fine window: time radius around center, with a minimum frame span so the slider can move. */
function computeFineWindow(snapshots: SnapshotRow[], centerIdx: number, halfMs: number) {
  if (!snapshots.length) return { lo: 0, hi: 0 };
  const mid = Math.min(Math.max(0, centerIdx), snapshots.length - 1);
  const centerAt = snapshots[mid]!.capturedAt;
  let lo = lowerBoundAt(snapshots, centerAt - halfMs);
  let hi = upperBoundAt(snapshots, centerAt + halfMs);
  const minRadius = 25;
  lo = Math.min(lo, Math.max(0, mid - minRadius));
  hi = Math.max(hi, Math.min(snapshots.length - 1, mid + minRadius));
  if (hi <= lo) {
    lo = Math.max(0, mid - 1);
    hi = Math.min(snapshots.length - 1, mid + 1);
  }
  return { lo, hi };
}

const FINE_WINDOWS = [
  { id: "30s", label: "±30s", halfMs: 30_000 },
  { id: "2m", label: "±2m", halfMs: 2 * 60_000 },
  { id: "5m", label: "±5m", halfMs: 5 * 60_000 },
] as const;

function DepthRow({
  side,
  price,
  size,
  total,
  maxSize,
  highlight,
}: {
  side: "ask" | "bid";
  price: number;
  size: number;
  total: number;
  maxSize: number;
  highlight?: boolean;
}) {
  const width = maxSize > 0 ? Math.max(4, Math.min(100, (size / maxSize) * 100)) : 0;
  return (
    <div className={cls("poly-row", side === "ask" ? "poly-ask" : "poly-bid", highlight && "poly-touch")}>
      <span className="poly-bar" style={{ width: `${width}%` }} />
      <span className="poly-trade-cell" />
      <span className="poly-price">{cents(price)}</span>
      <span className="poly-shares">{shares(size)}</span>
      <span className="poly-total">{dollars(price, total)}</span>
    </div>
  );
}

export function OrderbookScrubber({
  snapshots,
  outcomeLabel,
  startAtBeginning = false,
  matchStart,
  matchEnd,
  onFrame,
}: {
  snapshots: SnapshotRow[];
  outcomeLabel?: string;
  startAtBeginning?: boolean;
  /** Kickoff from Polymarket event.startTime */
  matchStart?: string | null;
  /** Finish from Polymarket finished_at */
  matchEnd?: number | null;
  onFrame?: (snap: SnapshotRow, idx: number) => void;
}) {
  const initialIdx = useMemo(
    () => pickInitialFrame(snapshots, startAtBeginning),
    [snapshots, startAtBeginning]
  );
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [followLive, setFollowLive] = useState(!startAtBeginning);
  const [fineHalfMs, setFineHalfMs] = useState<(typeof FINE_WINDOWS)[number]["halfMs"]>(2 * 60_000);
  /** Index the fine window is centered on — updated on coarse release / window change, not while dragging Fine. */
  const [fineAnchorIdx, setFineAnchorIdx] = useState(0);
  /** Locked bounds for the duration of a Fine drag (avoids min/max changing mid-gesture). */
  const fineLockRef = useRef<{ lo: number; hi: number } | null>(null);
  const askScrollRef = useRef<HTMLDivElement>(null);
  const bidScrollRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();

  const safeIdx = snapshots.length ? Math.min(Math.max(0, idx), snapshots.length - 1) : 0;
  const snap = snapshots[safeIdx];

  const bookQuery = useQuery({
    queryKey: ["snapshot-book", snap?.id],
    queryFn: async () => {
      const res = await fetch(`/api/snapshots/${snap!.id}`);
      if (!res.ok) throw new Error("snapshot unavailable");
      return res.json() as Promise<SnapshotRow>;
    },
    enabled: Boolean(snap?.id),
    staleTime: Infinity,
    placeholderData: (prev) => prev,
  });

  const displaySnap: SnapshotRow | undefined = bookQuery.data
    ? bookQuery.data
    : snap
      ? snap
      : undefined;

  // Prefetch neighbors for snappy scrubbing.
  useEffect(() => {
    if (!snapshots.length) return;
    for (const j of [safeIdx - 1, safeIdx + 1, safeIdx - 2, safeIdx + 2]) {
      if (j < 0 || j >= snapshots.length) continue;
      const id = snapshots[j]!.id;
      void queryClient.prefetchQuery({
        queryKey: ["snapshot-book", id],
        queryFn: async () => {
          const res = await fetch(`/api/snapshots/${id}`);
          if (!res.ok) throw new Error("snapshot unavailable");
          return res.json() as Promise<SnapshotRow>;
        },
        staleTime: Infinity,
      });
    }
  }, [safeIdx, snapshots, queryClient]);

  useEffect(() => {
    if (!snapshots.length) return;
    setIdx(initialIdx);
    setFollowLive(!startAtBeginning);
    setPlaying(false);
    setFineAnchorIdx(initialIdx);
    fineLockRef.current = null;
  }, [snapshots, initialIdx, startAtBeginning]);

  useEffect(() => {
    if (!snap) return;
    onFrame?.(snap, safeIdx);
  }, [snap, safeIdx, onFrame]);

  useEffect(() => {
    if (!playing || snapshots.length < 2) return;
    const timer = setInterval(() => {
      setIdx((i) => {
        if (i >= snapshots.length - 1) {
          setPlaying(false);
          setFollowLive(true);
          return i;
        }
        return i + 1;
      });
    }, 700);
    return () => clearInterval(timer);
  }, [playing, snapshots.length]);

  useEffect(() => {
    if (followLive && snapshots.length) {
      const last = snapshots.length - 1;
      setIdx(last);
      setFineAnchorIdx(last);
      fineLockRef.current = null;
    }
  }, [followLive, snapshots.length]);

  const askRows = useMemo(
    () =>
      displaySnap ? withTotals([...displaySnap.asks].sort((a, b) => a.price - b.price), "ask") : [],
    [displaySnap]
  );
  const bidRows = useMemo(
    () =>
      displaySnap ? withTotals([...displaySnap.bids].sort((a, b) => b.price - a.price), "bid") : [],
    [displaySnap]
  );
  const maxSize = useMemo(() => {
    let m = 0;
    for (const l of [...(displaySnap?.asks ?? []), ...(displaySnap?.bids ?? [])]) m = Math.max(m, l.size);
    return m;
  }, [displaySnap]);

  useEffect(() => {
    const askRoot = askScrollRef.current;
    const bidRoot = bidScrollRef.current;
    if (!askRoot || !bidRoot) return;
    askRoot.scrollTop = askRoot.scrollHeight;
    bidRoot.scrollTop = 0;
  }, [safeIdx, displaySnap?.id, askRows.length, bidRows.length]);

  const anchored = computeFineWindow(snapshots, fineAnchorIdx, fineHalfMs);
  const fineLo = fineLockRef.current?.lo ?? anchored.lo;
  const fineHi = fineLockRef.current?.hi ?? anchored.hi;

  // If play walks past the pinned fine window, re-center once.
  useEffect(() => {
    if (!playing || !snapshots.length) return;
    if (safeIdx < fineLo || safeIdx > fineHi) setFineAnchorIdx(safeIdx);
  }, [playing, safeIdx, fineLo, fineHi, snapshots.length]);

  if (!snapshots.length || !snap || !displaySnap) {
    return <div className="empty">No orderbook snapshots recorded yet.</div>;
  }

  const spread =
    displaySnap.bestAsk != null && displaySnap.bestBid != null
      ? Math.max(0, displaySnap.bestAsk - displaySnap.bestBid)
      : null;
  const last = displaySnap.bestAsk ?? displaySnap.bestBid ?? null;

  const scrubCoarse = (next: number, reanchor = true) => {
    const clamped = Math.min(Math.max(0, next), snapshots.length - 1);
    setPlaying(false);
    setFollowLive(clamped >= snapshots.length - 1);
    setIdx(clamped);
    fineLockRef.current = null;
    if (reanchor) setFineAnchorIdx(clamped);
  };

  const pinFineToCurrent = () => {
    fineLockRef.current = null;
    setFineAnchorIdx(safeIdx);
  };

  const beginFineDrag = () => {
    const bounds = computeFineWindow(snapshots, safeIdx, fineHalfMs);
    fineLockRef.current = bounds;
    setFineAnchorIdx(safeIdx);
  };

  const endFineDrag = () => {
    fineLockRef.current = null;
    setFineAnchorIdx(safeIdx);
  };

  const scrubFineRel = (rel: number) => {
    const lo = fineLockRef.current?.lo ?? fineLo;
    const hi = fineLockRef.current?.hi ?? fineHi;
    const clamped = Math.min(Math.max(lo + rel, lo), hi);
    setPlaying(false);
    setFollowLive(clamped >= snapshots.length - 1);
    setIdx(clamped);
  };

  const recordStart = snapshots[0].capturedAt;
  const recordEnd = snapshots[snapshots.length - 1].capturedAt;
  const spanMs = Math.max(0, recordEnd - recordStart);
  const elapsedMs = Math.max(0, snap.capturedAt - recordStart);
  const progressPct = spanMs > 0 ? Math.round((elapsedMs / spanMs) * 100) : 0;
  const kickoff = parseIsoMs(matchStart);
  const avgGapS =
    snapshots.length > 1 ? (recordEnd - recordStart) / (snapshots.length - 1) / 1000 : 0;

  const fineSpan = Math.max(0, fineHi - fineLo);
  const fineRel = Math.min(Math.max(safeIdx - fineLo, 0), fineSpan);
  const fineLabel = FINE_WINDOWS.find((w) => w.halfMs === fineHalfMs)?.label ?? "±2m";
  const fineDisabled = fineSpan < 1;

  const shortName = (outcomeLabel ?? "OUTCOME").split(/\s+/).slice(0, 2).join(" ").toUpperCase();

  return (
    <div className="poly-ob">
      <div className="poly-timeline">
        <div className="poly-controls">
          <button type="button" className="ob-btn" disabled={safeIdx <= 0} onClick={() => scrubCoarse(safeIdx - 1)}>
            ‹
          </button>
          <button type="button" className="ob-btn" onClick={() => setPlaying((p) => !p)} disabled={snapshots.length < 2}>
            {playing ? "‖" : "▶"}
          </button>
          <button type="button" className="ob-btn" disabled={safeIdx >= snapshots.length - 1} onClick={() => scrubCoarse(safeIdx + 1)}>
            ›
          </button>
          <input
            className="ob-slider"
            type="range"
            min={0}
            max={Math.max(0, snapshots.length - 1)}
            value={safeIdx}
            onChange={(e) => scrubCoarse(Number(e.target.value), false)}
            onPointerUp={pinFineToCurrent}
            onKeyUp={pinFineToCurrent}
            aria-label="Full timeline"
            title="Full recording — Fine window re-centers when you release"
          />
          <span className="ob-frame mono">
            {safeIdx + 1}/{snapshots.length}
          </span>
          <button type="button" className="ob-btn" onClick={() => scrubCoarse(0)} disabled={safeIdx === 0} title="Recording start">
            ◀◀
          </button>
          <button
            type="button"
            className="ob-btn"
            onClick={() => {
              setFollowLive(true);
              const lastIdx = snapshots.length - 1;
              setIdx(lastIdx);
              setFineAnchorIdx(lastIdx);
              fineLockRef.current = null;
            }}
            disabled={safeIdx === snapshots.length - 1 && followLive}
            title="Recording end"
          >
            ▶▶
          </button>
        </div>

        <div className="poly-controls poly-controls-fine">
          <span className="ob-fine-tag mono">Fine</span>
          <button
            type="button"
            className="ob-btn"
            disabled={fineDisabled || fineRel <= 0}
            onClick={() => {
              beginFineDrag();
              scrubFineRel(fineRel - 1);
              endFineDrag();
            }}
            title="Previous frame"
          >
            ‹
          </button>
          <input
            className="ob-slider ob-slider-fine"
            type="range"
            min={0}
            max={Math.max(1, fineSpan)}
            step={1}
            value={fineDisabled ? 0 : fineRel}
            disabled={fineDisabled}
            onPointerDown={beginFineDrag}
            onPointerUp={endFineDrag}
            onPointerCancel={endFineDrag}
            onChange={(e) => scrubFineRel(Number(e.target.value))}
            aria-label="Fine timeline around pinned window"
            title={
              fineDisabled
                ? "Not enough frames in this window — try ±5m"
                : `Fine scrub ${fineLabel} (${fineSpan + 1} frames)`
            }
          />
          <button
            type="button"
            className="ob-btn"
            disabled={fineDisabled || fineRel >= fineSpan}
            onClick={() => {
              beginFineDrag();
              scrubFineRel(fineRel + 1);
              endFineDrag();
            }}
            title="Next frame"
          >
            ›
          </button>
          <div className="ob-fine-windows" role="group" aria-label="Fine window size">
            {FINE_WINDOWS.map((w) => (
              <button
                key={w.id}
                type="button"
                className={`ob-btn ob-fine-win${fineHalfMs === w.halfMs ? " ob-fine-win-on" : ""}`}
                onClick={() => {
                  fineLockRef.current = null;
                  setFineHalfMs(w.halfMs);
                  setFineAnchorIdx(safeIdx);
                }}
              >
                {w.label}
              </button>
            ))}
          </div>
        </div>
        <div className="poly-fine-rail mono">
          <span>{timelineClock(snapshots[fineLo]!.capturedAt)}</span>
          <span>
            {fineLabel} · {fineSpan + 1} frames
          </span>
          <span>{timelineClock(snapshots[fineHi]!.capturedAt)}</span>
        </div>

        <div className="poly-time-grid mono">
          <div className="poly-time-block">
            <span className="poly-time-label">Match start</span>
            <span>{kickoff != null ? timelineDateTime(kickoff) : "—"}</span>
          </div>
          <div className="poly-time-block poly-time-block-center">
            <span className="poly-time-label">Frame</span>
            <span className="poly-time-current">{timelineDateTime(snap.capturedAt)}</span>
            <span className="poly-time-meta">
              +{elapsedLabel(elapsedMs)} · {elapsedLabel(spanMs)} recorded · {progressPct}%
              {avgGapS > 0 ? ` · ~${avgGapS.toFixed(1)}s/snap` : ""}
            </span>
          </div>
          <div className="poly-time-block poly-time-block-end">
            <span className="poly-time-label">Match end</span>
            <span>{matchEnd != null ? timelineDateTime(matchEnd) : "—"}</span>
          </div>
        </div>
        <div className="poly-time-rail mono">
          <span>Rec {timelineClock(recordStart)}</span>
          <span>Rec {timelineClock(recordEnd)}</span>
        </div>
      </div>

      <div className={`poly-book${bookQuery.isFetching && !bookQuery.data?.asks?.length ? " poly-book-loading" : ""}`}>
        <div className="poly-head">
          <span className="poly-trade-h">Trade {shortName}</span>
          <span>Price</span>
          <span>Shares</span>
          <span>Total</span>
        </div>

        <div className="poly-asks-wrap">
          <div className="poly-side-scroll poly-side-scroll-ask" ref={askScrollRef}>
            {askRows.length === 0 ? (
              <div className="ob-empty">No asks</div>
            ) : (
              askRows.map((row) => (
                <DepthRow
                  key={`a-${row.price}`}
                  side="ask"
                  price={row.price}
                  size={row.size}
                  total={row.total}
                  maxSize={maxSize}
                  highlight={displaySnap.bestAsk != null && Math.abs(row.price - displaySnap.bestAsk) < 1e-9}
                />
              ))
            )}
          </div>
          <span className="poly-side-pill poly-side-pill-ask">Asks</span>
        </div>

        <div className="poly-spread">
          <span>Last: {cents(last)}</span>
          <span>Spread: {spread == null ? "—" : cents(spread)}</span>
        </div>

        <div className="poly-bids-wrap">
          <span className="poly-side-pill poly-side-pill-bid">Bids</span>
          <div className="poly-side-scroll poly-side-scroll-bid" ref={bidScrollRef}>
            {bidRows.length === 0 ? (
              <div className="ob-empty">No bids</div>
            ) : (
              bidRows.map((row) => (
                <DepthRow
                  key={`b-${row.price}`}
                  side="bid"
                  price={row.price}
                  size={row.size}
                  total={row.total}
                  maxSize={maxSize}
                  highlight={displaySnap.bestBid != null && Math.abs(row.price - displaySnap.bestBid) < 1e-9}
                />
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

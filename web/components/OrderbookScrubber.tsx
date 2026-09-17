"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SnapshotRow } from "@/lib/db";
import { cls } from "@/lib/format";
import { elapsedLabel, timelineClock, timelineDateTime } from "@/lib/time";
import { cropScrubWindow, matchScrubWindow } from "@/lib/timeline";

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

function clamp(n: number, lo: number, hi: number) {
  return Math.min(Math.max(n, lo), hi);
}

const FINE_WINDOWS = [
  { id: "30s", label: "±30s", halfMs: 30_000 },
  { id: "2m", label: "±2m", halfMs: 2 * 60_000 },
  { id: "5m", label: "±5m", halfMs: 5 * 60_000 },
] as const;

/** Coarse slider resolution — time-based, identical across markets. */
const COARSE_STEPS = 1000;

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
  /** Preserve scrub position across market switches on the same match. */
  seekAt,
  onFrame,
  sport,
}: {
  snapshots: SnapshotRow[];
  outcomeLabel?: string;
  startAtBeginning?: boolean;
  matchStart?: string | null;
  matchEnd?: number | null;
  seekAt?: number;
  onFrame?: (payload: { clockAt: number; snap: SnapshotRow; idx: number }) => void;
  /** Required for per-sport DB lookup of full book frames. */
  sport?: string;
}) {
  const frames = useMemo(
    () => cropScrubWindow(snapshots, matchStart, matchEnd),
    [snapshots, matchStart, matchEnd]
  );

  // Shared match clock — same t0/t1 for moneyline, draw, O/U on this event.
  const window = useMemo(() => {
    // Prefer match start/end only so token frame arrays cannot move the bars.
    const fromMatch = matchScrubWindow(matchStart, matchEnd);
    if (fromMatch) return fromMatch;
    return matchScrubWindow(matchStart, matchEnd, frames);
  }, [matchStart, matchEnd, frames]);
  const t0 = window?.t0 ?? frames[0]?.capturedAt ?? 0;
  const t1 = window?.t1 ?? frames[frames.length - 1]?.capturedAt ?? 0;
  const spanMs = Math.max(0, t1 - t0);

  const [anchorAt, setAnchorAt] = useState<number | undefined>(seekAt);
  const [playing, setPlaying] = useState(false);
  const [followLive, setFollowLive] = useState(!startAtBeginning);
  const [fineHalfMs, setFineHalfMs] = useState<(typeof FINE_WINDOWS)[number]["halfMs"]>(2 * 60_000);
  /** Fine window center in wall-clock time (not a per-token frame index). */
  const [fineAnchorAt, setFineAnchorAt] = useState<number | undefined>(seekAt);
  const fineLockRef = useRef<{ lo: number; hi: number } | null>(null);
  const initedRef = useRef(false);
  const askScrollRef = useRef<HTMLDivElement>(null);
  const bidScrollRef = useRef<HTMLDivElement>(null);
  const onFrameRef = useRef(onFrame);
  onFrameRef.current = onFrame;
  const queryClient = useQueryClient();

  const clockAt = clamp(anchorAt ?? (startAtBeginning ? t0 : t1), t0, t1 || t0);
  // Last snap at or before the scrub time — same rule as sidebar/top-bar quote lookup.
  const safeIdx = frames.length ? upperBoundAt(frames, clockAt) : 0;
  const snap = frames[safeIdx];

  const commitTime = (at: number, reanchorFine = false) => {
    const next = clamp(at, t0, t1 || t0);
    setAnchorAt(next);
    // Push clock immediately so sidebar markets track the scrubber (don't wait for effect).
    const idx = frames.length ? upperBoundAt(frames, next) : 0;
    const frame = frames[idx];
    if (frame) onFrameRef.current?.({ clockAt: next, snap: frame, idx });
    if (reanchorFine) {
      fineLockRef.current = null;
      setFineAnchorAt(next);
    }
  };

  const bookQuery = useQuery({
    queryKey: ["snapshot-book", sport, snap?.day, snap?.id],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (sport) params.set("sport", sport);
      if (snap!.day) params.set("day", snap!.day);
      const q = params.size ? `?${params}` : "";
      const res = await fetch(`/api/snapshots/${snap!.id}${q}`);
      if (!res.ok) throw new Error("snapshot unavailable");
      return res.json() as Promise<SnapshotRow>;
    },
    enabled: Boolean(snap?.id),
    staleTime: Infinity,
    // Keep the previous ladder painted while the next frame's depth loads —
    // timeline rows only have best bid/ask (empty bids/asks), which looks "flat".
    placeholderData: keepPreviousData,
  });

  const displaySnap: SnapshotRow | undefined = bookQuery.data ?? snap ?? undefined;
  const ladderReady = Boolean(bookQuery.data && snap && bookQuery.data.id === snap.id);

  // First load only — never reset bars when the token series changes.
  useEffect(() => {
    if (!frames.length || !window || initedRef.current) return;
    initedRef.current = true;
    if (seekAt != null && Number.isFinite(seekAt)) {
      const at = clamp(seekAt, t0, t1);
      setAnchorAt(at);
      setFineAnchorAt(at);
      return;
    }
    const initIdx = pickInitialFrame(frames, startAtBeginning);
    const at = clamp(frames[initIdx]!.capturedAt, t0, t1);
    setAnchorAt(at);
    setFineAnchorAt(at);
    setFollowLive(!startAtBeginning);
  }, [frames, window, t0, t1, seekAt, startAtBeginning]);

  useEffect(() => {
    if (!Number.isFinite(clockAt) || !frames.length) return;
    // Shared scrub clock — parent maps all market prices from the dense quote series.
    onFrameRef.current?.({ clockAt, snap: displaySnap ?? snap!, idx: safeIdx });
  }, [clockAt, frames.length]);

  useEffect(() => {
    if (!frames.length) return;
    for (const j of [safeIdx - 1, safeIdx + 1, safeIdx - 2, safeIdx + 2]) {
      if (j < 0 || j >= frames.length) continue;
      const id = frames[j]!.id;
      const day = frames[j]!.day;
      void queryClient.prefetchQuery({
        queryKey: ["snapshot-book", sport, day, id],
        queryFn: async () => {
          const params = new URLSearchParams();
          if (sport) params.set("sport", sport);
          if (day) params.set("day", day);
          const q = params.size ? `?${params}` : "";
          const res = await fetch(`/api/snapshots/${id}${q}`);
          if (!res.ok) throw new Error("snapshot unavailable");
          return res.json() as Promise<SnapshotRow>;
        },
        staleTime: Infinity,
      });
    }
  }, [safeIdx, frames, queryClient, sport]);

  useEffect(() => {
    if (!playing || frames.length < 2) return;
    const timer = setInterval(() => {
      setAnchorAt((prev) => {
        const cur = prev ?? clockAt;
        const idx = upperBoundAt(frames, cur);
        if (idx >= frames.length - 1) {
          setPlaying(false);
          setFollowLive(true);
          return t1;
        }
        const nextAt = frames[idx + 1]!.capturedAt;
        return clamp(nextAt, t0, t1);
      });
    }, 700);
    return () => clearInterval(timer);
  }, [playing, frames, t0, t1, clockAt]);

  useEffect(() => {
    if (!followLive || spanMs <= 0) return;
    setAnchorAt(t1);
    setFineAnchorAt(t1);
    fineLockRef.current = null;
  }, [followLive, t1, spanMs]);

  // Keep fine window under the playhead when play walks out of it.
  useEffect(() => {
    if (!playing) return;
    const center = fineAnchorAt ?? clockAt;
    if (clockAt < center - fineHalfMs || clockAt > center + fineHalfMs) {
      setFineAnchorAt(clockAt);
      fineLockRef.current = null;
    }
  }, [playing, clockAt, fineAnchorAt, fineHalfMs]);

  const askRows = useMemo(() => {
    const asks = bookQuery.data?.asks?.length ? bookQuery.data.asks : displaySnap?.asks ?? [];
    return withTotals([...asks].sort((a, b) => a.price - b.price), "ask");
  }, [bookQuery.data, displaySnap]);
  const bidRows = useMemo(() => {
    const bids = bookQuery.data?.bids?.length ? bookQuery.data.bids : displaySnap?.bids ?? [];
    return withTotals([...bids].sort((a, b) => b.price - a.price), "bid");
  }, [bookQuery.data, displaySnap]);
  const maxSize = useMemo(() => {
    let m = 0;
    for (const l of [...(bookQuery.data?.asks ?? displaySnap?.asks ?? []), ...(bookQuery.data?.bids ?? displaySnap?.bids ?? [])]) {
      m = Math.max(m, l.size);
    }
    return m;
  }, [bookQuery.data, displaySnap]);

  useEffect(() => {
    const askRoot = askScrollRef.current;
    const bidRoot = bidScrollRef.current;
    if (!askRoot || !bidRoot) return;
    askRoot.scrollTop = askRoot.scrollHeight;
    bidRoot.scrollTop = 0;
  }, [safeIdx, displaySnap?.id, askRows.length, bidRows.length]);

  if (!frames.length || !snap || !displaySnap || !window) {
    return <div className="empty">No orderbook snapshots recorded yet.</div>;
  }

  const tob = ladderReady && bookQuery.data ? bookQuery.data : snap;
  const spread =
    tob.bestAsk != null && tob.bestBid != null ? Math.max(0, tob.bestAsk - tob.bestBid) : null;
  const last = tob.bestAsk ?? tob.bestBid ?? null;

  const coarseValue =
    spanMs > 0 ? Math.round(((clockAt - t0) / spanMs) * COARSE_STEPS) : 0;

  const scrubCoarseValue = (value: number, reanchor = true) => {
    const next = clamp(value, 0, COARSE_STEPS);
    const at = t0 + (next / COARSE_STEPS) * spanMs;
    setPlaying(false);
    setFollowLive(next >= COARSE_STEPS);
    commitTime(at, reanchor);
  };

  const stepMainByMinute = (dir: -1 | 1) => {
    const at = clamp(clockAt + dir * 60_000, t0, t1);
    setPlaying(false);
    setFollowLive(at >= t1 - 1);
    commitTime(at, true);
  };

  const fineCenter = fineAnchorAt ?? clockAt;
  const fineLoAt = fineLockRef.current?.lo ?? clamp(fineCenter - fineHalfMs, t0, t1);
  const fineHiAt = fineLockRef.current?.hi ?? clamp(fineCenter + fineHalfMs, t0, t1);
  const fineSpanMs = Math.max(0, fineHiAt - fineLoAt);
  const FINE_STEPS = 200;
  const fineValue =
    fineSpanMs > 0 ? Math.round(((clamp(clockAt, fineLoAt, fineHiAt) - fineLoAt) / fineSpanMs) * FINE_STEPS) : 0;
  const fineDisabled = fineSpanMs < 1000;

  const beginFineDrag = () => {
    const lo = clamp(fineCenter - fineHalfMs, t0, t1);
    const hi = clamp(fineCenter + fineHalfMs, t0, t1);
    if (clockAt < lo || clockAt > hi) {
      fineLockRef.current = {
        lo: clamp(clockAt - fineHalfMs, t0, t1),
        hi: clamp(clockAt + fineHalfMs, t0, t1),
      };
      setFineAnchorAt(clockAt);
      return;
    }
    fineLockRef.current = { lo, hi };
  };

  const endFineDrag = () => {
    fineLockRef.current = null;
  };

  const scrubFineValue = (value: number) => {
    const lo = fineLockRef.current?.lo ?? fineLoAt;
    const hi = fineLockRef.current?.hi ?? fineHiAt;
    const span = Math.max(1, hi - lo);
    const at = lo + (clamp(value, 0, FINE_STEPS) / FINE_STEPS) * span;
    setPlaying(false);
    setFollowLive(at >= t1 - 1);
    commitTime(at, false);
  };

  const pinFineToCurrent = () => {
    fineLockRef.current = null;
    setFineAnchorAt(clockAt);
  };

  const elapsedMs = Math.max(0, clockAt - t0);
  const progressPct = spanMs > 0 ? Math.round((elapsedMs / spanMs) * 100) : 0;
  const kickoff = parseIsoMs(matchStart);
  const avgGapS = frames.length > 1 ? spanMs / (frames.length - 1) / 1000 : 0;
  const fineLabel = FINE_WINDOWS.find((w) => w.halfMs === fineHalfMs)?.label ?? "±2m";
  const shortName = (outcomeLabel ?? "OUTCOME").split(/\s+/).slice(0, 2).join(" ").toUpperCase();

  return (
    <div className="poly-ob">
      <div className="poly-timeline">
        <div className="poly-controls">
          <button
            type="button"
            className="ob-btn"
            disabled={clockAt <= t0}
            onClick={() => stepMainByMinute(-1)}
            title="Back 1 minute"
          >
            ‹
          </button>
          <button type="button" className="ob-btn" onClick={() => setPlaying((p) => !p)} disabled={frames.length < 2}>
            {playing ? "‖" : "▶"}
          </button>
          <button
            type="button"
            className="ob-btn"
            disabled={clockAt >= t1}
            onClick={() => stepMainByMinute(1)}
            title="Forward 1 minute"
          >
            ›
          </button>
          <input
            className="ob-slider"
            type="range"
            min={0}
            max={COARSE_STEPS}
            value={coarseValue}
            onChange={(e) => scrubCoarseValue(Number(e.target.value), false)}
            onPointerUp={pinFineToCurrent}
            onKeyUp={pinFineToCurrent}
            aria-label="Match timeline"
            title="Match timeline — Fine window re-centers when you release"
          />
          <span className="ob-frame mono">
            {safeIdx + 1}/{frames.length}
          </span>
          <button
            type="button"
            className="ob-btn"
            onClick={() => scrubCoarseValue(0, true)}
            disabled={coarseValue === 0}
            title="Match window start"
          >
            ◀◀
          </button>
          <button
            type="button"
            className="ob-btn"
            onClick={() => {
              setFollowLive(true);
              commitTime(t1, true);
            }}
            disabled={coarseValue >= COARSE_STEPS && followLive}
            title="Match window end"
          >
            ▶▶
          </button>
        </div>

        <div className="poly-controls poly-controls-fine">
          <span className="ob-fine-tag mono">Fine</span>
          <button
            type="button"
            className="ob-btn"
            disabled={fineDisabled || fineValue <= 0}
            onClick={() => {
              beginFineDrag();
              scrubFineValue(fineValue - 1);
              endFineDrag();
            }}
            title="Nudge back"
          >
            ‹
          </button>
          <input
            className="ob-slider ob-slider-fine"
            type="range"
            min={0}
            max={FINE_STEPS}
            step={1}
            value={fineDisabled ? 0 : fineValue}
            disabled={fineDisabled}
            onPointerDown={beginFineDrag}
            onPointerUp={endFineDrag}
            onPointerCancel={endFineDrag}
            onChange={(e) => scrubFineValue(Number(e.target.value))}
            aria-label="Fine timeline around pinned window"
            title={fineDisabled ? "Window too small — try ±5m" : `Fine scrub ${fineLabel}`}
          />
          <button
            type="button"
            className="ob-btn"
            disabled={fineDisabled || fineValue >= FINE_STEPS}
            onClick={() => {
              beginFineDrag();
              scrubFineValue(fineValue + 1);
              endFineDrag();
            }}
            title="Nudge forward"
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
                  setFineAnchorAt(clockAt);
                }}
              >
                {w.label}
              </button>
            ))}
          </div>
        </div>
        <div className="poly-fine-rail mono">
          <span>{timelineClock(fineLoAt)}</span>
          <span>
            {fineLabel} · {elapsedLabel(fineSpanMs)}
          </span>
          <span>{timelineClock(fineHiAt)}</span>
        </div>

        <div className="poly-time-grid mono">
          <div className="poly-time-block">
            <span className="poly-time-label">Match start</span>
            <span>{kickoff != null ? timelineDateTime(kickoff) : "—"}</span>
          </div>
          <div className="poly-time-block poly-time-block-center">
            <span className="poly-time-label">Frame</span>
            <span className="poly-time-current">{timelineDateTime(clockAt)}</span>
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
          <span>Rec {timelineClock(t0)}</span>
          <span>Rec {timelineClock(t1)}</span>
        </div>
      </div>

      <div className={`poly-book${bookQuery.isFetching && !ladderReady ? " poly-book-loading" : ""}`}>
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

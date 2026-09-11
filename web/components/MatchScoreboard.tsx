"use client";

import { useMemo } from "react";
import type { GammaSportsEvent } from "@/lib/gamma";
import { parseScoreString, periodBadge, scoreAtTime, teamRows, type SetCell } from "@/lib/score";

function SetScoreCell({ cell, active }: { cell: SetCell; active?: boolean }) {
  return (
    <span className={`sb-set ${active ? "sb-set-active" : ""}`}>
      {cell.games}
      {cell.tiebreak != null ? <sup className="sb-tb">{cell.tiebreak}</sup> : null}
    </span>
  );
}

function TeamSide({ name, logo }: { name: string; logo?: string | null }) {
  return (
    <div className="sb-team">
      {logo ? <img className="sb-logo" src={logo} alt="" /> : <span className="sb-logo-ph" />}
      <span className="sb-name">{name}</span>
    </div>
  );
}

function ScoreTimeline({
  rows,
}: {
  rows: Array<{ capturedAt: number; score: string | null; period: string | null; elapsed: string | null }>;
}) {
  if (rows.length < 2) return null;
  const changes = rows.filter((row, i) => i === 0 || row.score !== rows[i - 1]?.score);
  if (changes.length < 2) return null;

  return (
    <div className="sb-timeline">
      {changes.map((row, i) => {
        const parsed = parseScoreString(row.score);
        const label =
          parsed?.mode === "sets"
            ? row.score
            : parsed
              ? `${parsed.homeTotal}–${parsed.awayTotal}`
              : row.score ?? "—";
        const when = new Date(row.capturedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
        const meta = [row.period, row.elapsed].filter(Boolean).join(" · ");
        return (
          <div key={`${row.capturedAt}-${i}`} className="sb-timeline-row">
            <span className="sb-timeline-time mono">{when}</span>
            <span className="sb-timeline-score">{label}</span>
            {meta ? <span className="sb-timeline-meta">{meta}</span> : null}
          </div>
        );
      })}
    </div>
  );
}

export function MatchScoreboard({
  sports,
  title,
  live,
  ended,
  closed,
  atMs,
  scoreHistory = [],
}: {
  sports: GammaSportsEvent | null | undefined;
  title: string;
  live: boolean;
  ended: boolean;
  closed: boolean;
  atMs?: number;
  scoreHistory?: Array<{ capturedAt: number; score: string | null; period: string | null; elapsed: string | null }>;
}) {
  const frame = atMs != null ? scoreAtTime(scoreHistory, atMs) : null;
  // Finished games: if scrubber hasn't reported yet, prefer last recorded score / Gamma final.
  const latestHistory = scoreHistory.length ? scoreHistory[scoreHistory.length - 1] : null;
  const scoreStr =
    frame?.score ??
    (ended || closed ? latestHistory?.score : null) ??
    sports?.score ??
    null;
  const period =
    frame?.period ??
    ((ended || closed) && !frame ? latestHistory?.period : null) ??
    sports?.period ??
    null;
  const elapsed = frame?.elapsed ?? sports?.elapsed ?? null;

  const parsed = useMemo(() => parseScoreString(scoreStr), [scoreStr]);
  const { home, away } = useMemo(() => teamRows(sports?.teams, title), [sports?.teams, title]);
  const badge = periodBadge({ period, elapsed, live, ended, closed });

  if (!parsed && !sports?.teams?.length) return null;

  const setCount = Math.max(parsed?.homeSets.length ?? 0, parsed?.awaySets.length ?? 0);
  const activeSetIdx = parsed?.mode === "sets" ? setCount - 1 : -1;

  if (parsed?.mode === "sets") {
    return (
      <section className="sb sb-sets">
        {badge ? <div className={`sb-badge-wrap ${live ? "sb-badge-live" : ""}`}>{badge}</div> : null}
        <div className="sb-set-grid">
          <TeamSide name={home.alias || home.name} logo={home.logo} />
          <div className="sb-set-row">
            {parsed.homeSets.map((cell, i) => (
              <SetScoreCell key={`h-${i}`} cell={cell} active={i === activeSetIdx && live} />
            ))}
          </div>
        </div>
        <div className="sb-set-grid">
          <TeamSide name={away.alias || away.name} logo={away.logo} />
          <div className="sb-set-row">
            {parsed.awaySets.map((cell, i) => (
              <SetScoreCell key={`a-${i}`} cell={cell} active={i === activeSetIdx && live} />
            ))}
          </div>
        </div>
        <ScoreTimeline rows={scoreHistory} />
      </section>
    );
  }

  return (
    <section className="sb sb-simple">
      <TeamSide name={home.alias || home.name} logo={home.logo} />
      <div className="sb-center">
        <div className="sb-main-score">
          <span>{parsed?.homeTotal ?? "—"}</span>
          <span className="sb-dash">–</span>
          <span>{parsed?.awayTotal ?? "—"}</span>
        </div>
        {badge ? <span className={`sb-badge ${live ? "sb-badge-live" : ""}`}>{badge}</span> : null}
      </div>
      <TeamSide name={away.alias || away.name} logo={away.logo} />
      <ScoreTimeline rows={scoreHistory} />
    </section>
  );
}

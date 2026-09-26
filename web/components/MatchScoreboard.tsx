"use client";

import { useMemo } from "react";
import type { GammaSportsEvent } from "@/lib/gamma";
import {
  inferGoalsFromHistory,
  parseScoreString,
  periodBadge,
  scoreAtTime,
  teamRows,
  type GoalEvent,
  type SetCell,
} from "@/lib/score";

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

function shortTeam(name: string) {
  const parts = name
    .replace(/\b(fc|cf|sc|afc|the)\b/gi, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return name.slice(0, 8);
  if (parts.length === 1) return parts[0]!.slice(0, 10);
  return parts
    .slice(0, 2)
    .map((p) => p.slice(0, 6))
    .join(" ");
}

function goalMinuteLabel(goal: GoalEvent) {
  if (goal.minute) return `${goal.minute}'`;
  if (goal.period && !/^(VFT|FT|FINAL|F)$/i.test(goal.period)) return goal.period;
  return new Date(goal.capturedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function GoalsStrip({
  goals,
  homeName,
  awayName,
  sparse,
}: {
  goals: GoalEvent[];
  homeName: string;
  awayName: string;
  sparse: boolean;
}) {
  if (!goals.length) {
    if (!sparse) return null;
    return (
      <div className="sb-goals sb-goals-empty" title="Polymarket only stored the final score for this match">
        No in-play goal times recorded
      </div>
    );
  }

  return (
    <div className="sb-goals" aria-label="Goal times">
      <span className="sb-goals-label">Goals</span>
      <div className="sb-goals-list">
        {goals.map((goal, i) => (
          <span
            key={`${goal.capturedAt}-${goal.side}-${goal.homeTotal}-${goal.awayTotal}-${i}`}
            className={`sb-goal sb-goal-${goal.side}`}
            title={`${goal.homeTotal}–${goal.awayTotal}${goal.period ? ` · ${goal.period}` : ""}`}
          >
            <span className="sb-goal-min mono">{goalMinuteLabel(goal)}</span>
            <span className="sb-goal-team">
              {shortTeam(goal.side === "home" ? homeName : awayName)}
            </span>
            <span className="sb-goal-score mono">
              {goal.homeTotal}–{goal.awayTotal}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}

export function MatchScoreboard({
  sports,
  title,
  live,
  ended,
  closed,
  sport,
  gameStatus,
  atMs,
  scoreHistory = [],
}: {
  sports: GammaSportsEvent | null | undefined;
  title: string;
  live: boolean;
  ended: boolean;
  closed: boolean;
  /** Soccer-only goals strip; other sports never show "goal times". */
  sport?: string | null;
  gameStatus?: string | null;
  atMs?: number;
  scoreHistory?: Array<{ capturedAt: number; score: string | null; period: string | null; elapsed: string | null }>;
}) {
  const frame = atMs != null ? scoreAtTime(scoreHistory, atMs) : null;
  const latestHistory = scoreHistory.length ? scoreHistory[scoreHistory.length - 1] : null;
  const preferFinal = ended || closed;
  // Finished: headline score matches the list (latest VFT/FT), not a mid-match scrub/SUS snap.
  // Live: follow the scrubber. Goals strip below still shows the full progression.
  const scoreStr = preferFinal
    ? (latestHistory?.score ?? sports?.score ?? frame?.score ?? null)
    : (frame?.score ?? sports?.score ?? null);
  const period = preferFinal
    ? (latestHistory?.period ?? sports?.period ?? frame?.period ?? null)
    : (frame?.period ?? sports?.period ?? null);
  const elapsed = preferFinal
    ? (latestHistory?.elapsed ?? sports?.elapsed ?? frame?.elapsed ?? null)
    : (frame?.elapsed ?? sports?.elapsed ?? null);

  const parsed = useMemo(() => parseScoreString(scoreStr), [scoreStr]);
  const { home, away } = useMemo(() => teamRows(sports?.teams, title), [sports?.teams, title]);
  const badge = periodBadge({ period, elapsed, live, ended, closed, gameStatus });
  const showGoals = sport === "soccer";
  const goals = useMemo(
    () => (showGoals ? inferGoalsFromHistory(scoreHistory) : []),
    [showGoals, scoreHistory]
  );
  const sparseHistory = scoreHistory.length > 0 && goals.length === 0
    ? false
    : scoreHistory.length <= 1 && (parsed?.homeTotal ?? 0) + (parsed?.awayTotal ?? 0) > 0;

  // Only-final VFT with goals inferred as a dump: treat as sparse if every goal shares one tick & no minute.
  const onlyFinalDump =
    goals.length > 0 &&
    goals.every((g) => g.capturedAt === goals[0]!.capturedAt) &&
    goals.every((g) => !g.minute);

  if (!parsed && !sports?.teams?.length) return null;

  const setCount = Math.max(parsed?.homeSets.length ?? 0, parsed?.awaySets.length ?? 0);
  const activeSetIdx = parsed?.mode === "sets" ? setCount - 1 : -1;
  const homeLabel = home.alias || home.name;
  const awayLabel = away.alias || away.name;
  const goalsUi = showGoals ? (
    <GoalsStrip
      goals={onlyFinalDump ? [] : goals}
      homeName={homeLabel}
      awayName={awayLabel}
      sparse={sparseHistory || onlyFinalDump}
    />
  ) : null;

  if (parsed?.mode === "sets") {
    return (
      <section className="sb sb-sets">
        {badge ? <div className={`sb-badge-wrap ${live ? "sb-badge-live" : ""}`}>{badge}</div> : null}
        <div className="sb-set-grid">
          <TeamSide name={homeLabel} logo={home.logo} />
          <div className="sb-set-row">
            {parsed.homeSets.map((cell, i) => (
              <SetScoreCell key={`h-${i}`} cell={cell} active={i === activeSetIdx && live} />
            ))}
          </div>
        </div>
        <div className="sb-set-grid">
          <TeamSide name={awayLabel} logo={away.logo} />
          <div className="sb-set-row">
            {parsed.awaySets.map((cell, i) => (
              <SetScoreCell key={`a-${i}`} cell={cell} active={i === activeSetIdx && live} />
            ))}
          </div>
        </div>
        {goalsUi}
      </section>
    );
  }

  return (
    <section className="sb sb-simple">
      <TeamSide name={homeLabel} logo={home.logo} />
      <div className="sb-center">
        <div className="sb-main-score">
          <span>{parsed?.homeTotal ?? "—"}</span>
          <span className="sb-dash">–</span>
          <span>{parsed?.awayTotal ?? "—"}</span>
        </div>
        {badge ? <span className={`sb-badge ${live ? "sb-badge-live" : ""}`}>{badge}</span> : null}
      </div>
      <TeamSide name={awayLabel} logo={away.logo} />
      {goalsUi}
    </section>
  );
}

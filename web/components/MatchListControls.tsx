"use client";

import type { MatchListFilters, MatchSort, VolumeFloor, DateFilter } from "@/lib/matchFilters";
import {
  DATE_OPTIONS,
  SORT_OPTIONS,
  VOLUME_OPTIONS,
} from "@/lib/matchFilters";

export function MatchListControls({
  filters,
  onChange,
  leagueOptions,
  compact = false,
}: {
  filters: MatchListFilters;
  onChange: (next: MatchListFilters) => void;
  leagueOptions: Array<{ code: string; label: string; count: number }>;
  compact?: boolean;
}) {
  return (
    <div className={`match-filters${compact ? " match-filters-compact" : ""}`}>
      <label className="match-filter">
        <span className="match-filter-label">Sort</span>
        <select
          value={filters.sort}
          onChange={(e) => onChange({ ...filters, sort: e.target.value as MatchSort })}
          aria-label="Sort matches"
        >
          {SORT_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </label>

      <label className="match-filter">
        <span className="match-filter-label">Vol</span>
        <select
          value={filters.volumeMin}
          onChange={(e) => onChange({ ...filters, volumeMin: Number(e.target.value) as VolumeFloor })}
          aria-label="Minimum volume"
        >
          {VOLUME_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </label>

      <label className="match-filter">
        <span className="match-filter-label">Group</span>
        <select
          value={filters.group}
          onChange={(e) => onChange({ ...filters, group: e.target.value })}
          aria-label="Filter by league"
        >
          <option value="">All leagues</option>
          {leagueOptions.map((opt) => (
            <option key={opt.code} value={opt.code}>
              {opt.label} ({opt.count})
            </option>
          ))}
        </select>
      </label>

      <label className="match-filter">
        <span className="match-filter-label">Date</span>
        <select
          value={filters.date}
          onChange={(e) => onChange({ ...filters, date: e.target.value as DateFilter })}
          aria-label="Filter by date"
        >
          {DATE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

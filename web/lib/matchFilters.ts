import type { EventRow } from "@/lib/db";
import { resolveLeague, type LeagueGroup } from "@/lib/league";

export type MatchSort = "volume_desc" | "volume_asc" | "date_desc" | "date_asc" | "title";
export type VolumeFloor = 0 | 10_000 | 50_000 | 100_000 | 500_000;
export type DateFilter = "all" | "today" | "3d" | "7d";

export type MatchListFilters = {
  sort: MatchSort;
  volumeMin: VolumeFloor;
  group: string; // "" = all, else league code
  date: DateFilter;
};

export const DEFAULT_MATCH_FILTERS: MatchListFilters = {
  sort: "volume_desc",
  volumeMin: 0,
  group: "",
  date: "all",
};

export const SORT_OPTIONS: Array<{ value: MatchSort; label: string }> = [
  { value: "volume_desc", label: "Vol ↓" },
  { value: "volume_asc", label: "Vol ↑" },
  { value: "date_desc", label: "Date ↓" },
  { value: "date_asc", label: "Date ↑" },
  { value: "title", label: "Name" },
];

export const VOLUME_OPTIONS: Array<{ value: VolumeFloor; label: string }> = [
  { value: 0, label: "Any $" },
  { value: 10_000, label: ">$10k" },
  { value: 50_000, label: ">$50k" },
  { value: 100_000, label: ">$100k" },
  { value: 500_000, label: ">$500k" },
];

export const DATE_OPTIONS: Array<{ value: DateFilter; label: string }> = [
  { value: "all", label: "All dates" },
  { value: "today", label: "Today" },
  { value: "3d", label: "3 days" },
  { value: "7d", label: "7 days" },
];

function pad(n: number) {
  return String(n).padStart(2, "0");
}

export function localDateKey(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function eventDateKey(event: Pick<EventRow, "eventDate" | "finishedAt" | "startTime">): string | null {
  if (event.eventDate && /^\d{4}-\d{2}-\d{2}/.test(event.eventDate)) {
    return event.eventDate.slice(0, 10);
  }
  if (event.startTime) {
    const t = Date.parse(event.startTime);
    if (Number.isFinite(t)) return localDateKey(new Date(t));
  }
  if (event.finishedAt != null && Number.isFinite(event.finishedAt)) {
    return localDateKey(new Date(event.finishedAt));
  }
  return null;
}

function daysAgoKey(days: number) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - days);
  return localDateKey(d);
}

function passesDate(event: EventRow, date: DateFilter) {
  if (date === "all") return true;
  const key = eventDateKey(event);
  if (!key) return false;
  if (date === "today") return key === localDateKey();
  if (date === "3d") return key >= daysAgoKey(2);
  if (date === "7d") return key >= daysAgoKey(6);
  return true;
}

function compareEvents(a: EventRow, b: EventRow, sort: MatchSort) {
  if (sort === "volume_desc") return (b.volume ?? 0) - (a.volume ?? 0);
  if (sort === "volume_asc") return (a.volume ?? 0) - (b.volume ?? 0);
  if (sort === "title") return a.title.localeCompare(b.title);
  const da = eventDateKey(a) ?? "";
  const db = eventDateKey(b) ?? "";
  if (sort === "date_asc") return da.localeCompare(db) || a.title.localeCompare(b.title);
  return db.localeCompare(da) || a.title.localeCompare(b.title);
}

export function listLeagueOptions(events: EventRow[]) {
  const map = new Map<string, { code: string; label: string; count: number }>();
  for (const event of events) {
    const { code, label } = resolveLeague(event);
    const prev = map.get(code);
    if (prev) prev.count += 1;
    else map.set(code, { code, label, count: 1 });
  }
  return [...map.values()].sort((a, b) => a.label.localeCompare(b.label));
}

export function filterAndSortEvents(events: EventRow[], filters: MatchListFilters): EventRow[] {
  const out = events.filter((event) => {
    if ((event.volume ?? 0) < filters.volumeMin) return false;
    if (filters.group) {
      if (resolveLeague(event).code !== filters.group) return false;
    }
    if (!passesDate(event, filters.date)) return false;
    return true;
  });
  out.sort((a, b) => compareEvents(a, b, filters.sort));
  return out;
}

/** Group already-sorted events; keep within-group order; order groups by sort. */
export function groupSortedEvents(events: EventRow[], sort: MatchSort): LeagueGroup<EventRow>[] {
  const map = new Map<string, LeagueGroup<EventRow>>();
  for (const event of events) {
    const { code, label } = resolveLeague(event);
    let group = map.get(code);
    if (!group) {
      group = { code, label, totalVolume: 0, events: [] };
      map.set(code, group);
    }
    group.events.push(event);
    group.totalVolume += event.volume ?? 0;
  }

  const groups = [...map.values()];
  groups.sort((a, b) => {
    if (sort === "volume_asc") return a.totalVolume - b.totalVolume || a.label.localeCompare(b.label);
    if (sort === "volume_desc") return b.totalVolume - a.totalVolume || a.label.localeCompare(b.label);
    if (sort === "title") return a.label.localeCompare(b.label);
    const aDate = a.events[0] ? eventDateKey(a.events[0]) ?? "" : "";
    const bDate = b.events[0] ? eventDateKey(b.events[0]) ?? "" : "";
    if (sort === "date_asc") return aDate.localeCompare(bDate) || a.label.localeCompare(b.label);
    return bDate.localeCompare(aDate) || a.label.localeCompare(b.label);
  });
  return groups;
}

export type ContextTag = "desk" | "home" | "phone" | "errand" | "other";

export type LifePillar = "spiritual" | "family" | "mil_career" | "civ_career" | "financial" | "physical" | "mental";

export type ItemKind = "Fixed Event" | "Habit" | "Task" | "Enroute";
export type CalendarRole = "fixed_source" | "display_only" | "schedule_target";

export interface CalendarConnection {
  id: string;
  name: string;
  calendar_id: string;
  role: CalendarRole;
  enabled: boolean;
  last_synced_at?: string | null;
  last_sync_error?: string | null;
}

export interface FixedEvent {
  id: string;
  name: string;
  start_time: string;
  end_time: string;
  blocks_schedule?: boolean;
  source_calendar_id?: string;
  is_all_day?: boolean;
  pillar?: LifePillar | null;
  recurrence_enabled?: boolean;
  recurrence_frequency?: "daily" | "weekly" | "monthly" | null;
  recurrence_interval?: number | null;
  recurrence_weekdays?: number[] | null;
  recurrence_monthly_mode?: "day_of_month" | "weekday_of_month" | null;
  recurrence_monthly_day?: number | null;
  recurrence_monthly_week_n?: number | null;
  recurrence_monthly_weekday?: number | null;
  recurrence_end_mode?: "never" | "on_date" | "after_count" | null;
  recurrence_end_date?: string | null;
  recurrence_count?: number | null;
}

export interface Habit {
  id: string;
  name: string;
  tier: number;
  duration_min: number;
  search_start: string;
  search_end: string;
  context: ContextTag;
  pillar?: LifePillar | null;
  recurrence_enabled?: boolean;
  recurrence_frequency?: "daily" | "weekly" | "monthly" | null;
  recurrence_interval?: number | null;
  recurrence_weekdays?: number[] | null;
  recurrence_monthly_mode?: "day_of_month" | "weekday_of_month" | null;
  recurrence_monthly_day?: number | null;
  recurrence_monthly_week_n?: number | null;
  recurrence_monthly_weekday?: number | null;
  recurrence_end_mode?: "never" | "on_date" | "after_count" | null;
  recurrence_end_date?: string | null;
  recurrence_count?: number | null;
}

export interface Task {
  id: string;
  name: string;
  tier: number;
  duration_min: number;
  search_start: string;
  deadline: string;
  context: ContextTag;
  pillar?: LifePillar | null;
  completed_at: string | null;
  recurrence_enabled?: boolean;
  recurrence_frequency?: "daily" | "weekly" | "monthly" | null;
  recurrence_interval?: number | null;
  recurrence_weekdays?: number[] | null;
  recurrence_monthly_mode?: "day_of_month" | "weekday_of_month" | null;
  recurrence_monthly_day?: number | null;
  recurrence_monthly_week_n?: number | null;
  recurrence_monthly_weekday?: number | null;
  recurrence_end_mode?: "never" | "on_date" | "after_count" | null;
  recurrence_end_date?: string | null;
  recurrence_count?: number | null;
}

export interface TaskOccurrence {
  id: string;
  task_id: string;
  occurrence_date: string;
  completed: boolean;
  completed_at: string | null;
  override_start: string | null;
  override_end: string | null;
  skipped: boolean;
}

export interface FixedEventOccurrence {
  id: string;
  item_id: string;
  occurrence_date: string;
  completed: boolean;
  completed_at: string | null;
  override_start: string | null;
  override_end: string | null;
  skipped: boolean;
}

export interface HabitOccurrence {
  id: string;
  item_id: string;
  occurrence_date: string;
  completed: boolean;
  completed_at: string | null;
  override_start: string | null;
  override_end: string | null;
  skipped: boolean;
}

export type AnyOccurrence = TaskOccurrence | FixedEventOccurrence | HabitOccurrence;

export type RecurrenceScope = "this" | "following" | "all";

export interface PlacedItem {
  id: string;
  name: string;
  kind: ItemKind;
  tier: number;
  context: ContextTag;
  start: Date;
  pillar: LifePillar | null;
  end: Date;
  room: number;
  isBatch: boolean;
  memberNames?: string[];
  memberIds?: string[];
  sourceCalendarId?: string;
  blocksSchedule?: boolean;
  googleEventId?: string;
  googleCalendarId?: string;
  googleCalendarRole?: string;
  isAllDay?: boolean;
  isRecurringOccurrence?: boolean;
  recurringItemId?: string;
  recurringItemKind?: ItemKind;
  occurrenceDate?: string;
  occurrenceCompleted?: boolean;
  recurrenceSummary?: string;
}

export interface UnscheduledItem {
  id: string;
  name: string;
  kind: ItemKind;
  tier: number;
  deadline: Date;
}

export const CONTEXT_COLORS: Record<ContextTag, { bg: string; border: string; text: string; dot: string; soft: string }> = {
  desk:   { bg: "bg-blue-500",   border: "border-blue-600",   text: "text-blue-100",   dot: "bg-blue-400",   soft: "bg-blue-500/15"  },
  home:   { bg: "bg-emerald-500", border: "border-emerald-600", text: "text-emerald-100", dot: "bg-emerald-400", soft: "bg-emerald-500/15" },
  phone:  { bg: "bg-amber-500",   border: "border-amber-600",   text: "text-amber-100",   dot: "bg-amber-400",   soft: "bg-amber-500/15"  },
  errand: { bg: "bg-rose-500",    border: "border-rose-600",    text: "text-rose-100",    dot: "bg-rose-400",    soft: "bg-rose-500/15"  },
  other:  { bg: "bg-slate-500",   border: "border-slate-600",   text: "text-slate-100",   dot: "bg-slate-400",   soft: "bg-slate-500/15" },
};

export const PILLARS: LifePillar[] = [
  "spiritual",
  "family",
  "mil_career",
  "civ_career",
  "financial",
  "physical",
  "mental",
];

export const PILLAR_LABELS: Record<LifePillar, string> = {
  spiritual: "Spiritual",
  family: "Family",
  mil_career: "Mil Career",
  civ_career: "Civ Career",
  financial: "Financial",
  physical: "Physical",
  mental: "Mental",
};

export const PILLAR_COLORS: Record<LifePillar, { bg: string; border: string; text: string; dot: string; soft: string }> = {
  spiritual:  { bg: "bg-[#ffff00]", border: "border-[#cccc00]", text: "text-black",  dot: "bg-[#ffff00]", soft: "bg-[#ffff00]/15" },
  family:     { bg: "bg-[#ff0000]", border: "border-[#cc0000]", text: "text-white",  dot: "bg-[#ff0000]", soft: "bg-[#ff0000]/15" },
  mil_career: { bg: "bg-[#008000]", border: "border-[#006600]", text: "text-white",  dot: "bg-[#008000]", soft: "bg-[#008000]/15" },
  civ_career: { bg: "bg-[#800080]", border: "border-[#660066]", text: "text-white",  dot: "bg-[#800080]", soft: "bg-[#800080]/15" },
  financial:  { bg: "bg-[#a52a2a]", border: "border-[#7a1f1f]", text: "text-white",  dot: "bg-[#a52a2a]", soft: "bg-[#a52a2a]/15" },
  physical:   { bg: "bg-[#0000ff]", border: "border-[#0000cc]", text: "text-white",  dot: "bg-[#0000ff]", soft: "bg-[#0000ff]/15" },
  mental:     { bg: "bg-[#808080]", border: "border-[#666666]", text: "text-white",  dot: "bg-[#808080]", soft: "bg-[#808080]/15" },
};

export const UNASSIGNED_PILLAR_COLOR = { bg: "bg-slate-500", border: "border-slate-600", text: "text-slate-100", dot: "bg-slate-400", soft: "bg-slate-500/15" };

export function getPillarColor(pillar: LifePillar | null | undefined): { bg: string; border: string; text: string; dot: string; soft: string } {
  if (!pillar) return UNASSIGNED_PILLAR_COLOR;
  return PILLAR_COLORS[pillar];
}

export const TIER_LABELS: Record<number, string> = {
  1: "P1 — Critical",
  2: "P2 — High",
  3: "P3 — Medium",
  4: "P4 — Low",
};

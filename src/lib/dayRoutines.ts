/**
 * Day routines: when goal sessions may be suggested, by kind of day.
 *
 * Each day of the week is typed from the calendar — UTA, Flying (flight legs
 * and layovers away from MIA), Reserve, Day off… — using the same title-word
 * matching as big life blocks (all-day or 8h+ events). The first routine in
 * order that matches wins; a day matching none uses the default routine. The
 * Weekly Review then only proposes sessions inside that routine's windows
 * (and never in quiet hours). A routine with no windows means no goal
 * sessions that day; the session moves to the nearest day that has room.
 */
import { supabase } from "./supabase";
import { appSettings } from "./appSettings";
import type { FixedEvent } from "./types";
import { blockRanges, type LifeBlock } from "./lifeBlocks";

export type RoutineKind = "keywords" | "trips" | "default";

export interface RoutineWindow {
  from: string; // "HH:MM"
  to: string; // "HH:MM"
}

export interface DayRoutine {
  id?: string;
  key: string;
  label: string;
  kind: RoutineKind;
  keywords: string;
  windows: RoutineWindow[];
  enabled: boolean;
  position: number;
}

/** Goal sessions are never suggested in quiet hours (21:00–09:00), the same rule as dragging. */
export const PLAN_DAY_START = appSettings.quietEndHour;
export const PLAN_DAY_END = appSettings.quietStartHour;
const hh = (h: number) => `${String(h).padStart(2, "0")}:00`;

const STARTER_ROUTINES: DayRoutine[] = [
  { key: "uta", label: "UTA", kind: "keywords", keywords: "uta, drill weekend", windows: [], enabled: true, position: 10 },
  { key: "flying", label: "Flying", kind: "trips", keywords: "", windows: [], enabled: true, position: 20 },
  { key: "reserve", label: "Reserve", kind: "keywords", keywords: "reserve", windows: [{ from: "09:00", to: "11:00" }], enabled: true, position: 30 },
  {
    key: "day_off",
    label: "Day off",
    kind: "keywords",
    keywords: "no flying, day off, off",
    windows: [
      { from: "09:00", to: "12:00" },
      { from: "19:00", to: "21:00" },
    ],
    enabled: true,
    position: 40,
  },
  { key: "normal", label: "Normal day", kind: "default", keywords: "", windows: [{ from: hh(PLAN_DAY_START), to: hh(PLAN_DAY_END) }], enabled: true, position: 100 },
];

/** The starter list, without the kinds of day this copy has switched off (drill, trips). */
export const DEFAULT_ROUTINES: DayRoutine[] = STARTER_ROUTINES.filter(
  (r) => !((r.key === "uta" && !appSettings.features.drill) || ((r.key === "flying" || r.key === "reserve") && !appSettings.features.trips))
);

const normalize = (r: DayRoutine): DayRoutine => ({
  ...r,
  windows: (Array.isArray(r.windows) ? r.windows : [])
    .filter((w) => /^\d{2}:\d{2}$/.test(w?.from ?? "") && /^\d{2}:\d{2}$/.test(w?.to ?? "") && w.from < w.to)
    .sort((a, b) => a.from.localeCompare(b.from)),
});

export async function loadDayRoutines(): Promise<DayRoutine[]> {
  const { data, error } = await supabase.from("day_routines").select("*").order("position").order("created_at");
  // Table not there yet: work from the starter list.
  if (error || !data?.length) return DEFAULT_ROUTINES;
  return (data as DayRoutine[]).map(normalize);
}

export async function saveDayRoutine(r: DayRoutine): Promise<DayRoutine> {
  const row = { key: r.key, label: r.label.trim(), kind: r.kind, keywords: r.keywords, windows: normalize(r).windows, enabled: r.enabled, position: r.position, updated_at: new Date().toISOString() };
  const q = r.id
    ? supabase.from("day_routines").update(row).eq("id", r.id).select("*").single()
    : supabase.from("day_routines").upsert(row, { onConflict: "key" }).select("*").single();
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return normalize(data as DayRoutine);
}

export async function deleteDayRoutine(r: DayRoutine): Promise<void> {
  if (!r.id) return;
  const { error } = await supabase.from("day_routines").delete().eq("id", r.id);
  if (error) throw new Error(error.message);
}

/** Which routine a day follows (day = local midnight). */
export function routineForDay(day: Date, routines: DayRoutine[], events: FixedEvent[]): DayRoutine {
  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate());
  const end = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
  const on = routines.filter((r) => r.enabled).sort((a, b) => a.position - b.position);
  for (const r of on) {
    if (r.kind === "default") continue;
    const asBlock: LifeBlock = { key: r.key, label: r.label, kind: r.kind, keywords: r.keywords, enabled: true, position: r.position };
    if (blockRanges([asBlock], events, start, end).length) return r;
  }
  return on.find((r) => r.kind === "default") ?? DEFAULT_ROUTINES[DEFAULT_ROUTINES.length - 1];
}

const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

/**
 * The stretches of `day` a goal session may be suggested in: the routine's
 * windows, inside the session's preferred time [fromH, toH), outside quiet hours.
 */
export function sessionWindows(day: Date, routine: DayRoutine, fromH: number, toH: number): { start: Date; end: Date }[] {
  const lo = Math.max(fromH, PLAN_DAY_START) * 60;
  const hi = Math.min(toH, PLAN_DAY_END) * 60;
  const out: { start: Date; end: Date }[] = [];
  for (const w of routine.windows) {
    const a = Math.max(minutesOf(w.from), lo);
    const b = Math.min(minutesOf(w.to), hi);
    if (b <= a) continue;
    out.push({
      start: new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(a / 60), a % 60),
      end: new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(b / 60), b % 60),
    });
  }
  return out;
}

export const windowsText = (r: DayRoutine) => (r.windows.length ? r.windows.map((w) => `${w.from}–${w.to}`).join(", ") : "no goal sessions");

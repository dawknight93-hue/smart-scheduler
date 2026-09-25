// Builds the complete set of events Google Calendar should show so it mirrors
// Smart Scheduler. The gcal-sync edge function's "mirror" action reconciles
// Google against this list: creating, updating, and deleting only events the
// app itself owns (tagged with a private extended property).
import type { FixedEvent, Habit, Task, LifePillar, PlacedItem } from "./types";
import { supabase } from "./supabase";
import { runEngine, getWeekStart, addDays, HOME_TIME_ZONE, homeWallParts, homeDate } from "./schedulingEngine";
import { parseRecurrenceFromItem, expandRecurrence, formatLocalDate, type RecurrenceRule } from "./recurrence";

export const MIRROR_WEEKS = 6;
const DAY_MS = 24 * 60 * 60 * 1000;

export type MirrorTarget = "personal" | "tasks" | "habits";

export interface MirrorException {
  /** Absolute original start (timed series) — used to find the Google instance. */
  originalStart?: string;
  /** Original date YYYY-MM-DD (all-day series). */
  originalDate?: string;
  skipped: boolean;
  completed: boolean;
  /** Local wall-clock times when this one occurrence was moved/resized. */
  overrideStart?: string;
  overrideEnd?: string;
}

export interface MirrorItem {
  key: string;
  target: MirrorTarget;
  summary: string;
  description: string;
  colorId?: string;
  allDay: boolean;
  /** Timed: local wall clock "YYYY-MM-DDTHH:MM:SS". All-day: "YYYY-MM-DD" (end exclusive). */
  start: string;
  end: string;
  timeZone: string;
  recurrence?: string[];
  exceptions?: MirrorException[];
  hash: string;
}

// Closest Google Calendar event colors to each pillar's app color.
const PILLAR_COLOR: Record<LifePillar, string> = {
  spiritual: "5", // Banana (yellow)
  family: "11", // Tomato (red)
  mil_career: "10", // Basil (green)
  civ_career: "3", // Grape (purple)
  financial: "6", // Tangerine — Google has no brown
  physical: "9", // Blueberry (blue)
  mental: "8", // Graphite (grey)
};

const PILLAR_LABEL: Record<LifePillar, string> = {
  spiritual: "Spiritual",
  family: "Family",
  mil_career: "Mil Career",
  civ_career: "Civ Career",
  financial: "Financial",
  physical: "Physical",
  mental: "Mental",
};

const BYDAY = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Wall-clock time of an instant in the home time zone, e.g. "2026-09-24T09:15:00". */
export function localWall(d: Date): string {
  const w = homeWallParts(d);
  return `${w.y}-${pad(w.mo)}-${pad(w.d)}T${pad(w.h)}:${pad(w.mi)}:${pad(w.s)}`;
}

/**
 * Re-express an instant as a device-local Date carrying the home time zone's
 * calendar date and clock time. Recurrence math runs on these, so repeat days
 * are the home-calendar days no matter what time zone the device is in.
 */
function toHomeCalendar(instant: Date): Date {
  const w = homeWallParts(instant);
  return new Date(w.y, w.mo - 1, w.d, w.h, w.mi, 0);
}

/** Home-time-zone instant for a home-calendar date (from toHomeCalendar/expandRecurrence) at h:m. */
function homeInstant(day: Date, h: number, m: number): Date {
  return homeDate(day.getFullYear(), day.getMonth(), day.getDate(), h, m);
}

function homeRule(rule: RecurrenceRule): RecurrenceRule {
  return rule.endDate ? { ...rule, endDate: toHomeCalendar(new Date(rule.endDate)).toISOString() } : rule;
}

function compactUtc(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function hashString(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

function withHash(item: Omit<MirrorItem, "hash">): MirrorItem {
  return { ...item, hash: hashString(JSON.stringify(item)) };
}

function describe(kind: string, pillar: LifePillar | null | undefined, extra?: string): string {
  const lines = [`${kind}${pillar ? ` · ${PILLAR_LABEL[pillar]}` : ""}`];
  if (extra) lines.push(extra);
  lines.push("Managed by Smart Scheduler — edit it there; changes made in Google are overwritten on the next sync.");
  return lines.join("\n");
}

function colorFor(pillar: LifePillar | null | undefined): string | undefined {
  return pillar ? PILLAR_COLOR[pillar] : undefined;
}

export function buildRRule(rule: RecurrenceRule, allDay: boolean, timeOfDay: { h: number; m: number }): string {
  const parts = [`FREQ=${rule.frequency.toUpperCase()}`, `INTERVAL=${Math.max(1, rule.interval || 1)}`];
  if (rule.frequency === "weekly") {
    parts.push("WKST=MO");
    if (rule.weekdays.length > 0) {
      parts.push(`BYDAY=${[...rule.weekdays].sort((a, b) => a - b).map((d) => BYDAY[d]).join(",")}`);
    }
  } else if (rule.frequency === "monthly") {
    if (rule.monthlyMode === "day_of_month") {
      parts.push(`BYMONTHDAY=${rule.monthlyDay}`);
    } else {
      parts.push(`BYDAY=${rule.monthlyWeekN}${BYDAY[rule.monthlyWeekday]}`);
    }
  }
  if (rule.endMode === "after_count" && rule.count) {
    parts.push(`COUNT=${rule.count}`);
  } else if (rule.endMode === "on_date" && rule.endDate) {
    // The app treats the end date as inclusive (local calendar day).
    const end = toHomeCalendar(new Date(rule.endDate));
    if (allDay) {
      parts.push(`UNTIL=${formatLocalDate(end).replace(/-/g, "")}`);
    } else {
      parts.push(`UNTIL=${compactUtc(homeInstant(end, timeOfDay.h, timeOfDay.m))}`);
    }
  }
  return `RRULE:${parts.join(";")}`;
}

interface OccurrenceRow {
  occurrence_date: string;
  completed: boolean;
  override_start: string | null;
  override_end: string | null;
  skipped: boolean;
}

interface SeriesInput {
  key: string;
  target: MirrorTarget;
  name: string;
  kind: string;
  pillar: LifePillar | null | undefined;
  source: FixedEvent | Habit | Task;
  anchor: Date; // start_time or search_start (date = recurrence start, time = time of day)
  durationMs: number;
  allDay: boolean;
  occurrences: OccurrenceRow[];
  timeZone: string;
}

function buildSeries(s: SeriesInput): MirrorItem | null {
  const rule = parseRecurrenceFromItem(s.source);
  if (!rule.enabled) return null;
  const anchor = toHomeCalendar(s.anchor);
  const anchorDay = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
  // Google counts the series from DTSTART, so start it on the app's actual first
  // occurrence (which may be after the anchor date, e.g. weekly on Mon/Wed
  // starting on a Saturday).
  const upcoming = expandRecurrence(homeRule(rule), anchor, anchorDay, addDays(anchorDay, 3 * 366));
  const first = upcoming[0];
  if (!first) return null;
  // A finite series whose every occurrence was deleted has nothing to show.
  // (Google drops a series once all of its instances are cancelled, so
  // pushing it would just recreate it on every sync.)
  if (rule.endMode !== "never") {
    const skipped = new Set(s.occurrences.filter((o) => o.skipped).map((o) => o.occurrence_date));
    if (upcoming.every((d) => skipped.has(formatLocalDate(d)))) return null;
  }
  const h = anchor.getHours();
  const m = anchor.getMinutes();
  let start: string;
  let end: string;
  if (s.allDay) {
    const days = Math.max(1, Math.round(s.durationMs / DAY_MS));
    start = formatLocalDate(first);
    end = formatLocalDate(addDays(first, days));
  } else {
    const st = homeInstant(first, h, m);
    start = localWall(st);
    end = localWall(new Date(st.getTime() + s.durationMs));
  }
  const exceptions: MirrorException[] = s.occurrences
    .filter((o) => o.skipped || o.completed || (o.override_start && o.override_end))
    .map((o) => {
      const [y, mo, d] = o.occurrence_date.split("-").map(Number);
      const ex: MirrorException = { skipped: o.skipped, completed: o.completed };
      if (s.allDay) ex.originalDate = o.occurrence_date;
      else ex.originalStart = homeDate(y, mo - 1, d, h, m).toISOString();
      if (!o.skipped && o.override_start && o.override_end) {
        ex.overrideStart = localWall(new Date(o.override_start));
        ex.overrideEnd = localWall(new Date(o.override_end));
      }
      return ex;
    })
    .sort((a, b) => (a.originalStart ?? a.originalDate ?? "").localeCompare(b.originalStart ?? b.originalDate ?? ""));
  return withHash({
    key: s.key,
    target: s.target,
    summary: s.name,
    description: describe(s.kind, s.pillar),
    colorId: colorFor(s.pillar),
    allDay: s.allDay,
    start,
    end,
    timeZone: s.timeZone,
    recurrence: [buildRRule(rule, s.allDay, { h, m })],
    exceptions,
  });
}

function isAllDayFixed(fe: FixedEvent): boolean {
  return !!fe.is_all_day || new Date(fe.end_time).getTime() - new Date(fe.start_time).getTime() >= DAY_MS;
}

/**
 * Expand app-owned recurring Fixed Events into concrete events for one range,
 * so the scheduling engine treats every occurrence as busy time.
 */
function fixedOccurrencesInRange(
  recurring: FixedEvent[],
  occByKey: Map<string, OccurrenceRow>,
  rangeStart: Date,
  rangeEnd: Date
): FixedEvent[] {
  const out: FixedEvent[] = [];
  for (const fe of recurring) {
    const rule = homeRule(parseRecurrenceFromItem(fe));
    const feStart = toHomeCalendar(new Date(fe.start_time));
    const durationMs = new Date(fe.end_time).getTime() - new Date(fe.start_time).getTime();
    for (const occ of expandRecurrence(rule, feStart, rangeStart, rangeEnd)) {
      const dateStr = formatLocalDate(occ);
      const ex = occByKey.get(`${fe.id}|${dateStr}`);
      if (ex?.skipped) continue;
      let s: Date;
      let e: Date;
      if (ex?.override_start && ex?.override_end) {
        s = new Date(ex.override_start);
        e = new Date(ex.override_end);
      } else {
        s = homeInstant(occ, feStart.getHours(), feStart.getMinutes());
        e = new Date(s.getTime() + durationMs);
      }
      out.push({ ...fe, id: `${fe.id}--${dateStr}`, start_time: s.toISOString(), end_time: e.toISOString(), recurrence_enabled: false });
    }
  }
  return out;
}

export async function buildMirrorItems(
  windowStart: Date,
  weeks: number = MIRROR_WEEKS
): Promise<{ items: MirrorItem[]; windowStart: Date; windowEnd: Date }> {
  const windowEnd = addDays(windowStart, weeks * 7);
  // Always describe events in the home time zone so every device produces the
  // same result (a device on another time zone won't rewrite Google Calendar).
  const timeZone = HOME_TIME_ZONE;

  const [feRes, habRes, taskRes, ebRes, mapRes, toRes, feoRes, hoRes] = await Promise.all([
    supabase.from("fixed_events").select("*"),
    supabase.from("habits").select("*"),
    supabase.from("tasks").select("*"),
    supabase.from("enroute_blocks").select("*").gte("end_time", windowStart.toISOString()),
    supabase.from("gcal_event_map").select("item_id, item_type, calendar_role").eq("item_type", "fixed_event"),
    supabase.from("task_occurrences").select("*"),
    supabase.from("fixed_event_occurrences").select("*"),
    supabase.from("habit_occurrences").select("*"),
  ]);
  for (const r of [feRes, habRes, taskRes, ebRes, mapRes, toRes, feoRes, hoRes]) {
    if (r.error) throw new Error(`Could not load data for Google sync: ${r.error.message}`);
  }

  const fixedEvents = (feRes.data as FixedEvent[]) ?? [];
  const habits = (habRes.data as Habit[]) ?? [];
  const tasks = (taskRes.data as Task[]) ?? [];
  const enroute = (ebRes.data as { id: string; name: string; start_time: string; end_time: string }[]) ?? [];
  // Fixed events that came FROM Google are already there — never push them back.
  const pulledIds = new Set(
    ((mapRes.data as { item_id: string | null; calendar_role: string }[]) ?? [])
      .filter((m) => m.item_id && m.calendar_role !== "schedule_target")
      .map((m) => m.item_id as string)
  );

  const taskOcc = new Map<string, OccurrenceRow[]>();
  for (const o of (toRes.data as (OccurrenceRow & { task_id: string })[]) ?? []) {
    taskOcc.set(o.task_id, [...(taskOcc.get(o.task_id) ?? []), o]);
  }
  const groupByItem = (rows: (OccurrenceRow & { item_id: string })[]) => {
    const m = new Map<string, OccurrenceRow[]>();
    for (const o of rows) m.set(o.item_id, [...(m.get(o.item_id) ?? []), o]);
    return m;
  };
  const feOcc = groupByItem((feoRes.data as (OccurrenceRow & { item_id: string })[]) ?? []);
  const habOcc = groupByItem((hoRes.data as (OccurrenceRow & { item_id: string })[]) ?? []);
  const feOccByKey = new Map<string, OccurrenceRow>();
  for (const [id, rows] of feOcc) for (const o of rows) feOccByKey.set(`${id}|${o.occurrence_date}`, o);

  const items: MirrorItem[] = [];

  // 1) Fixed Events created in the app → Personal / Family calendar.
  const appFixed = fixedEvents.filter((e) => !pulledIds.has(e.id));
  for (const fe of appFixed) {
    const allDay = isAllDayFixed(fe);
    const start = new Date(fe.start_time);
    const end = new Date(fe.end_time);
    if (fe.recurrence_enabled) {
      const series = buildSeries({
        key: `series:fixed:${fe.id}`,
        target: "personal",
        name: fe.name,
        kind: "Fixed Event",
        pillar: fe.pillar,
        source: fe,
        anchor: start,
        durationMs: end.getTime() - start.getTime(),
        allDay,
        occurrences: feOcc.get(fe.id) ?? [],
        timeZone,
      });
      if (series) items.push(series);
    } else if (end >= windowStart) {
      items.push(
        withHash({
          key: `fixed:${fe.id}`,
          target: "personal",
          summary: fe.name,
          description: describe("Fixed Event", fe.pillar),
          colorId: colorFor(fe.pillar),
          allDay,
          // Events marked all-day are stored at UTC midnight of their dates.
          start: fe.is_all_day ? fe.start_time.slice(0, 10) : allDay ? formatLocalDate(start) : localWall(start),
          end: fe.is_all_day
            ? new Date(end.getTime() <= start.getTime() ? start.getTime() + DAY_MS : end.getTime()).toISOString().slice(0, 10)
            : allDay ? formatLocalDate(addDays(start, Math.max(1, Math.round((end.getTime() - start.getTime()) / DAY_MS)))) : localWall(end),
          timeZone,
        })
      );
    }
  }

  // 2) Recurring Tasks and Habits → real repeating series at their set time.
  for (const t of tasks.filter((x) => x.recurrence_enabled)) {
    const series = buildSeries({
      key: `series:task:${t.id}`,
      target: "tasks",
      name: t.name,
      kind: "Task",
      pillar: t.pillar,
      source: t,
      anchor: new Date(t.search_start),
      durationMs: t.duration_min * 60 * 1000,
      allDay: false,
      occurrences: taskOcc.get(t.id) ?? [],
      timeZone,
    });
    if (series) items.push(series);
  }
  for (const hb of habits.filter((x) => x.recurrence_enabled)) {
    const series = buildSeries({
      key: `series:habit:${hb.id}`,
      target: "habits",
      name: hb.name,
      kind: "Habit",
      pillar: hb.pillar,
      source: hb,
      anchor: new Date(hb.search_start),
      durationMs: hb.duration_min * 60 * 1000,
      allDay: false,
      occurrences: habOcc.get(hb.id) ?? [],
      timeZone,
    });
    if (series) items.push(series);
  }

  // 3) Non-recurring Habits and Tasks, placed week by week by the same engine
  //    the Calendar view uses.
  const nonRecurringFixed = fixedEvents.filter((e) => !e.recurrence_enabled);
  const recurringAppFixed = appFixed.filter((e) => e.recurrence_enabled);
  const nonRecurringHabits = habits.filter((h) => !h.recurrence_enabled);
  const nonRecurringTasks = tasks.filter((t) => !t.recurrence_enabled);
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  for (let w = 0; w < weeks; w++) {
    const weekStart = addDays(windowStart, w * 7);
    const weekEnd = addDays(weekStart, 7);
    const busyFixed = [...nonRecurringFixed, ...fixedOccurrencesInRange(recurringAppFixed, feOccByKey, weekStart, weekEnd)];
    const { placed } = runEngine(weekStart, busyFixed, nonRecurringHabits, nonRecurringTasks);
    for (const p of placed as PlacedItem[]) {
      if (p.kind !== "Habit" && p.kind !== "Task") continue;
      const done = p.kind === "Task" && !p.isBatch && !!taskById.get(p.id)?.completed_at;
      items.push(
        withHash({
          key: `eng:${p.kind === "Habit" ? "habit" : "task"}:${p.id}:${formatLocalDate(weekStart)}`,
          target: p.kind === "Habit" ? "habits" : "tasks",
          summary: `${done ? "✓ " : ""}${p.name}`,
          description: describe(
            p.kind,
            p.pillar,
            p.isBatch && p.memberNames ? `Batched: ${p.memberNames.join(", ")}` : `Tier ${p.tier} · ${p.context}`
          ),
          colorId: colorFor(p.pillar),
          allDay: false,
          start: localWall(p.start),
          end: localWall(p.end),
          timeZone,
        })
      );
    }
  }

  // 4) Enroute drive-time blocks.
  for (const b of enroute) {
    items.push(
      withHash({
        key: `enroute:${b.id}`,
        target: "tasks",
        summary: `🚗 ${b.name}`,
        description: describe("Enroute", "civ_career"),
        colorId: PILLAR_COLOR.civ_career,
        allDay: false,
        start: localWall(new Date(b.start_time)),
        end: localWall(new Date(b.end_time)),
        timeZone,
      })
    );
  }

  return { items, windowStart, windowEnd };
}

/**
 * Names of the Google calendars the mirror writes to, by target. Must match
 * the calendar selection in the gcal-sync edge function's mirrorEvents().
 * Returns null when no enabled Write target calendar exists (nothing is mirrored).
 */
export function mirrorCalendarNames(
  connections: { name: string; calendar_id: string; role: string; enabled: boolean }[]
): Record<MirrorTarget, string> | null {
  const enabled = connections.filter((c) => c.enabled && c.calendar_id);
  const targets = enabled.filter((c) => c.role === "schedule_target");
  if (targets.length === 0) return null;
  const tasksCal = targets.find((c) => /task/i.test(c.name)) ?? targets[0];
  const habitsCal = targets.find((c) => /habit/i.test(c.name)) ?? targets[0];
  const personalCal =
    enabled.find((c) => c.role !== "schedule_target" && /personal|family/i.test(c.name)) ?? tasksCal;
  return { personal: personalCal.name, tasks: tasksCal.name, habits: habitsCal.name };
}

export function defaultMirrorWindowStart(): Date {
  return addDays(getWeekStart(new Date()), -7);
}

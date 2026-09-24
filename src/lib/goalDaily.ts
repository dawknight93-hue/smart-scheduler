/**
 * Daily level of the cascade (Yearly → Quarterly → Monthly → Weekly → Daily).
 *
 * Schedule-mode goals: every approved 🎯 session gets a daily item with a
 * short focus (what to do in that session) written from the goal's next
 * checkpoint. Count-mode goals (e.g. Runna): the session itself comes from
 * the other calendar, so a daily item row is only written once it's ticked.
 * Either way, "done" records what actually happened.
 */
import { supabase } from "./supabase";
import { addDays } from "./schedulingEngine";
import { formatLocalDate } from "./recurrence";
import type { CountedEvent, PlanGoal } from "./goalPlanning";

const RESEARCH_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/goal-research`;
const HEADERS = { Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`, "Content-Type": "application/json" };

export interface DailyItem {
  id: string;
  goal_id: string;
  week_start: string;
  day: string; // YYYY-MM-DD
  habit_id: string | null;
  source_item_id: string | null;
  start_at: string | null;
  minutes: number | null;
  focus: string;
  steps: string[];
  done: boolean;
  done_at: string | null;
}

/** A session that should carry a daily item. */
export interface DailySession {
  habitId: string;
  start: Date;
  end: Date;
}

export async function loadDailyItems(from: Date, to: Date): Promise<DailyItem[]> {
  const { data, error } = await supabase
    .from("goal_daily_items")
    .select("*")
    .gte("day", formatLocalDate(from))
    .lt("day", formatLocalDate(to))
    .order("day");
  if (error) throw new Error(error.message);
  return ((data as DailyItem[]) ?? []).map((d) => ({ ...d, steps: Array.isArray(d.steps) ? d.steps : [] }));
}

const dayText = (d: Date) =>
  `${d.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

async function askForFocus(goal: PlanGoal, sessions: DailySession[]): Promise<Map<string, { focus: string; steps: string[] }>> {
  const out = new Map<string, { focus: string; steps: string[] }>();
  try {
    const res = await fetch(RESEARCH_URL, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        action: "daily",
        goal_id: goal.id,
        sessions: sessions.map((s) => ({ ref: s.habitId, day: dayText(s.start), minutes: Math.round((s.end.getTime() - s.start.getTime()) / 60000) })),
      }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error ?? `status ${res.status}`);
    for (const i of data.items ?? []) out.set(i.ref, { focus: i.focus, steps: i.steps ?? [] });
  } catch (e) {
    // The session is still real without a written focus; fall back to the session name.
    console.warn("Daily focus unavailable:", e);
  }
  return out;
}

/**
 * Writes (or rewrites) the daily items for a goal's sessions. Sessions already
 * ticked done keep their focus.
 */
export async function writeDailyPlan(goal: PlanGoal, sessions: DailySession[], weekStart: Date, existing: DailyItem[] = []): Promise<void> {
  const doneHabits = new Set(existing.filter((d) => d.done && d.habit_id).map((d) => d.habit_id));
  const todo = sessions.filter((s) => !doneHabits.has(s.habitId)).sort((a, b) => a.start.getTime() - b.start.getTime());
  if (!todo.length) return;
  const focus = await askForFocus(goal, todo);
  const fallback = goal.weekly_target ?? "Goal session";
  const rows = todo.map((s) => ({
    goal_id: goal.id,
    week_start: formatLocalDate(weekStart),
    day: formatLocalDate(s.start),
    habit_id: s.habitId,
    start_at: s.start.toISOString(),
    minutes: Math.round((s.end.getTime() - s.start.getTime()) / 60000),
    focus: focus.get(s.habitId)?.focus ?? fallback,
    steps: focus.get(s.habitId)?.steps ?? [],
  }));
  const { error } = await supabase.from("goal_daily_items").upsert(rows, { onConflict: "habit_id" });
  if (error) throw new Error(error.message);
}

export async function setDailyDone(id: string, done: boolean): Promise<void> {
  const { error } = await supabase.from("goal_daily_items").update({ done, done_at: done ? new Date().toISOString() : null }).eq("id", id);
  if (error) throw new Error(error.message);
}

/** Ticks a scheduled 🎯 session done, creating its daily item if it predates the Daily level. */
export async function setSessionDone(goal: PlanGoal, entry: { item: DailyItem | null; habitId: string; start: Date; minutes: number | null }, weekStart: Date, done: boolean): Promise<void> {
  if (entry.item) return setDailyDone(entry.item.id, done);
  const { error } = await supabase.from("goal_daily_items").insert({
    goal_id: goal.id,
    week_start: formatLocalDate(weekStart),
    day: formatLocalDate(entry.start),
    habit_id: entry.habitId,
    start_at: entry.start.toISOString(),
    minutes: entry.minutes,
    focus: goal.weekly_target ?? "Goal session",
    done,
    done_at: done ? new Date().toISOString() : null,
  });
  if (error) throw new Error(error.message);
}

/** Ticks a counted session (e.g. a Runna workout) done or not done. */
export async function setCountedDone(goal: PlanGoal, ev: CountedEvent, weekStart: Date, done: boolean): Promise<DailyItem> {
  const { data, error } = await supabase
    .from("goal_daily_items")
    .upsert(
      {
        goal_id: goal.id,
        week_start: formatLocalDate(weekStart),
        day: formatLocalDate(ev.start),
        source_item_id: ev.id,
        start_at: ev.allDay ? null : ev.start.toISOString(),
        focus: ev.name,
        done,
        done_at: done ? new Date().toISOString() : null,
      },
      { onConflict: "goal_id,source_item_id" }
    )
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return data as DailyItem;
}

// ---------------------------------------------------------------------------
// One view of a goal's sessions for a week, whichever mode it's in.

export interface DayEntry {
  key: string;
  goalId: string;
  habitId: string | null;
  day: Date; // local midnight
  start: Date | null; // null = all day / time unknown
  minutes: number | null;
  title: string; // what shows on the calendar
  focus: string | null; // what to do in it (schedule mode)
  steps: string[];
  done: boolean;
  item: DailyItem | null;
  counted: CountedEvent | null;
}

const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

/**
 * Day-by-day entries for one goal. Times come from the live session (so a
 * session dragged in the calendar shows its new time); focus and done come
 * from the daily item.
 */
export function goalDayEntries(
  goal: PlanGoal,
  sessions: { id: string; start: Date; end: Date }[],
  counted: CountedEvent[],
  items: DailyItem[]
): DayEntry[] {
  const mine = items.filter((i) => i.goal_id === goal.id);
  if (goal.plan_mode === "count") {
    return counted.map((c) => {
      const it = mine.find((i) => i.source_item_id === c.id) ?? null;
      return { key: `c-${c.id}`, goalId: goal.id, habitId: null, day: midnight(c.start), start: c.allDay ? null : c.start, minutes: null, title: c.name, focus: null, steps: [], done: !!it?.done, item: it, counted: c };
    });
  }
  return sessions
    .map((s) => {
      const it = mine.find((i) => i.habit_id === s.id) ?? null;
      return {
        key: `h-${s.id}`,
        goalId: goal.id,
        habitId: s.id,
        day: midnight(s.start),
        start: s.start,
        minutes: Math.round((s.end.getTime() - s.start.getTime()) / 60000),
        title: `🎯 ${goal.weekly_target ?? "Goal session"}`,
        focus: it?.focus ?? null,
        steps: it?.steps ?? [],
        done: !!it?.done,
        item: it,
        counted: null,
      };
    })
    .sort((a, b) => (a.start?.getTime() ?? 0) - (b.start?.getTime() ?? 0));
}

export function weekRange(weekStart: Date): [Date, Date] {
  return [weekStart, addDays(weekStart, 7)];
}

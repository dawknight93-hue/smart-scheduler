/**
 * Goal planning: Cascade output shape, and the Weekly Review's two passes —
 * (1) propose/count each active goal's sessions for a week in pillar priority
 * order, (2) re-run the scheduler afterwards to confirm the sessions held.
 */
import { supabase } from "./supabase";
import { runEngine, addDays, getWeekStart, WORK_START_HOUR, WORK_END_HOUR } from "./schedulingEngine";
import { parseRecurrenceFromItem, expandRecurrence, formatLocalDate } from "./recurrence";
import type { ContextTag, FixedEvent, Habit, LifePillar, Task } from "./types";

/** Order goals compete for time in the Weekly Review (Flight Manual, Rev G). */
export const GOAL_PRIORITY: LifePillar[] = ["spiritual", "family", "physical", "civ_career", "mil_career", "mental", "financial"];

export type MilestoneLevel = "year" | "quarter" | "month" | "week";
export interface Milestone {
  id: string;
  level: MilestoneLevel;
  title: string;
  due: string; // YYYY-MM-DD
  metric: string | null;
  done: boolean;
}

export type PlanMode = "schedule" | "count";
export type PreferredTime = "any" | "morning" | "afternoon" | "evening";

export interface PlanGoal {
  id: string;
  pillar: LifePillar;
  specific: string | null;
  time_bound: string | null;
  status: string;
  approach: string | null;
  deadline: string | null;
  cadence_sessions_per_week: number | null;
  cadence_label: string | null;
  cadence_confirmed: boolean;
  milestones: Milestone[] | null;
  weekly_target: string | null;
  plan_mode: PlanMode | null;
  session_minutes: number | null;
  session_context: ContextTag | null;
  preferred_time: PreferredTime;
  count_calendar_id: string | null;
  count_keyword: string | null;
  cascade_generated_at: string | null;
}

export const PLAN_GOAL_COLUMNS =
  "id, pillar, specific, time_bound, status, approach, deadline, cadence_sessions_per_week, cadence_label, cadence_confirmed, milestones, weekly_target, plan_mode, session_minutes, session_context, preferred_time, count_calendar_id, count_keyword, cascade_generated_at";

export const PREFERRED_WINDOWS: Record<PreferredTime, [number, number]> = {
  any: [WORK_START_HOUR, WORK_END_HOUR],
  morning: [WORK_START_HOUR, 12],
  afternoon: [12, 17],
  evening: [17, WORK_END_HOUR],
};

export function goalShortName(g: Pick<PlanGoal, "specific" | "weekly_target">): string {
  return (g.specific ?? g.weekly_target ?? "Goal").replace(/\s+/g, " ").trim();
}

export function sortByPriority<T extends { pillar: LifePillar }>(goals: T[]): T[] {
  return [...goals].sort((a, b) => GOAL_PRIORITY.indexOf(a.pillar) - GOAL_PRIORITY.indexOf(b.pillar));
}

/** Monday 00:00 of the week to review: next week on Sat/Sun, otherwise this week. */
export function defaultReviewWeek(now = new Date()): Date {
  const wk = getWeekStart(now);
  const dow = now.getDay();
  return dow === 0 || dow === 6 ? addDays(wk, 7) : wk;
}

/** Sunday 21:30 or later, the next week's review is "due". */
export function reviewIsDue(now = new Date()): boolean {
  return now.getDay() === 0 && (now.getHours() > 21 || (now.getHours() === 21 && now.getMinutes() >= 30));
}

// ---------------------------------------------------------------------------
// Week data

interface OccRow {
  item_id?: string;
  task_id?: string;
  occurrence_date: string;
  skipped: boolean;
  completed?: boolean;
  override_start: string | null;
  override_end: string | null;
}

export interface MapRow {
  item_id: string | null;
  item_name: string;
  calendar_id: string;
  calendar_role: string;
  start_time: string;
}

export interface WeekData {
  weekStart: Date;
  weekEnd: Date;
  /** Everything that occupies time this week, as fixed events (incl. recurring occurrences). */
  busy: FixedEvent[];
  habits: Habit[]; // non-recurring
  tasks: Task[]; // non-recurring
  map: MapRow[];
  fixedById: Map<string, FixedEvent>;
}

function occurrenceEvents<T extends { id: string; name: string; pillar?: LifePillar | null }>(
  items: T[],
  occ: OccRow[],
  idKey: "item_id" | "task_id",
  timing: (it: T) => { start: Date; minutes: number },
  weekStart: Date,
  weekEnd: Date
): FixedEvent[] {
  const byKey = new Map(occ.map((o) => [`${o[idKey]}|${o.occurrence_date}`, o]));
  const out: FixedEvent[] = [];
  for (const it of items) {
    const { start, minutes } = timing(it);
    const rule = parseRecurrenceFromItem(it as never);
    for (const day of expandRecurrence(rule, start, weekStart, weekEnd)) {
      const date = formatLocalDate(day);
      const ex = byKey.get(`${it.id}|${date}`);
      if (ex?.skipped) continue;
      const s = ex?.override_start ? new Date(ex.override_start) : new Date(day.getFullYear(), day.getMonth(), day.getDate(), start.getHours(), start.getMinutes());
      const e = ex?.override_end ? new Date(ex.override_end) : new Date(s.getTime() + minutes * 60000);
      out.push({ id: `${it.id}--${date}`, name: it.name, start_time: s.toISOString(), end_time: e.toISOString(), pillar: it.pillar ?? null });
    }
  }
  return out;
}

export async function loadWeekData(weekStart: Date): Promise<WeekData> {
  const weekEnd = addDays(weekStart, 7);
  const [fe, hb, tk, mp, feo, ho, to] = await Promise.all([
    supabase.from("fixed_events").select("*").lt("start_time", weekEnd.toISOString()).gte("end_time", addDays(weekStart, -60).toISOString()),
    supabase.from("habits").select("*"),
    supabase.from("tasks").select("*"),
    supabase.from("gcal_event_map").select("item_id, item_name, calendar_id, calendar_role, start_time"),
    supabase.from("fixed_event_occurrences").select("*"),
    supabase.from("habit_occurrences").select("*"),
    supabase.from("task_occurrences").select("*"),
  ]);
  for (const r of [fe, hb, tk, mp, feo, ho, to]) if (r.error) throw new Error(r.error.message);

  const fixed = (fe.data as FixedEvent[]) ?? [];
  const habits = (hb.data as Habit[]) ?? [];
  const tasks = (tk.data as Task[]) ?? [];

  const inWeek = fixed.filter((e) => !e.recurrence_enabled && new Date(e.start_time) < weekEnd && new Date(e.end_time) > weekStart);
  const busy: FixedEvent[] = [
    ...inWeek,
    ...occurrenceEvents(
      fixed.filter((e) => e.recurrence_enabled),
      (feo.data as OccRow[]) ?? [],
      "item_id",
      (e) => ({ start: new Date(e.start_time), minutes: (new Date(e.end_time).getTime() - new Date(e.start_time).getTime()) / 60000 }),
      weekStart,
      weekEnd
    ),
    ...occurrenceEvents(
      habits.filter((h) => h.recurrence_enabled),
      (ho.data as OccRow[]) ?? [],
      "item_id",
      (h) => ({ start: new Date(h.search_start), minutes: h.duration_min }),
      weekStart,
      weekEnd
    ),
    ...occurrenceEvents(
      tasks.filter((t) => t.recurrence_enabled && !t.completed_at),
      (to.data as OccRow[]) ?? [],
      "task_id",
      (t) => ({ start: new Date(t.search_start), minutes: t.duration_min }),
      weekStart,
      weekEnd
    ),
  ];

  return {
    weekStart,
    weekEnd,
    busy,
    habits: habits.filter((h) => !h.recurrence_enabled),
    tasks: tasks.filter((t) => !t.recurrence_enabled && !t.completed_at),
    map: (mp.data as MapRow[]) ?? [],
    fixedById: new Map(fixed.map((f) => [f.id, f])),
  };
}

// ---------------------------------------------------------------------------
// Pass 1a — count mode: events already coming from a calendar

export interface CountedEvent {
  id: string;
  name: string;
  start: Date;
  allDay: boolean;
}

export function countGoalEvents(goal: PlanGoal, week: WeekData): CountedEvent[] {
  if (!goal.count_calendar_id) return [];
  const kw = goal.count_keyword?.trim().toLowerCase();
  const seen = new Set<string>();
  const out: CountedEvent[] = [];
  for (const m of week.map) {
    if (m.calendar_id !== goal.count_calendar_id || !m.item_id || seen.has(m.item_id)) continue;
    const fe = week.fixedById.get(m.item_id);
    const raw = new Date(fe?.start_time ?? m.start_time);
    // All-day events are stored at UTC midnight of their date — read that date, not the local instant.
    const allDay = !!fe?.is_all_day;
    const start = allDay ? new Date(raw.getUTCFullYear(), raw.getUTCMonth(), raw.getUTCDate()) : raw;
    if (start < week.weekStart || start >= week.weekEnd) continue;
    const name = fe?.name ?? m.item_name;
    if (kw && !name.toLowerCase().includes(kw)) continue;
    seen.add(m.item_id);
    out.push({ id: m.item_id, name, start, allDay });
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime());
}

// ---------------------------------------------------------------------------
// Pass 1b — schedule mode: propose sessions in free time

export interface ProposedSession {
  key: string;
  goalId: string;
  start: Date;
  end: Date;
}

export interface GoalWeekPlan {
  goal: PlanGoal;
  target: number;
  /** Sessions for this goal already on the calendar this week (schedule mode). */
  existing: Habit[];
  /** Events counted from the source calendar (count mode). */
  counted: CountedEvent[];
  proposed: ProposedSession[];
  /** How many sessions couldn't be placed anywhere this week. */
  unplaced: number;
}

function asBusy(id: string, name: string, start: Date, end: Date): FixedEvent {
  return { id, name, start_time: start.toISOString(), end_time: end.toISOString() };
}

/**
 * Proposes each goal's sessions for the week. Goals are handled in pillar
 * priority order, and every accepted proposal becomes busy time for the goals
 * after it — so Spiritual gets first pick, Financial last. Sessions are spread
 * across the week (one per day where possible) inside the goal's preferred
 * time of day, and never in the past.
 */
export function planWeek(goals: PlanGoal[], week: WeekData, now = new Date()): GoalWeekPlan[] {
  // Everything the scheduler already places this week counts as busy.
  const base = runEngine(week.weekStart, week.busy, week.habits, week.tasks);
  const busy: FixedEvent[] = [
    ...week.busy,
    ...base.placed.filter((p) => p.kind !== "Fixed Event" && !p.isAllDay).map((p) => asBusy(`placed-${p.id}-${p.start.getTime()}`, p.name, p.start, p.end)),
  ];

  const plans: GoalWeekPlan[] = [];
  for (const goal of sortByPriority(goals)) {
    const target = goal.cadence_sessions_per_week ?? 0;
    const existing = week.habits.filter(
      (h) => h.goal_id === goal.id && new Date(h.search_start) >= week.weekStart && new Date(h.search_start) < week.weekEnd
    );
    if (goal.plan_mode === "count") {
      plans.push({ goal, target, existing: [], counted: countGoalEvents(goal, week), proposed: [], unplaced: 0 });
      continue;
    }
    const need = Math.max(0, target - existing.length);
    const minutes = goal.session_minutes ?? 30;
    const [fromH, toH] = PREFERRED_WINDOWS[goal.preferred_time ?? "any"];
    const usedDays = new Set(existing.map((h) => new Date(h.search_start).getDay()));
    const proposed: ProposedSession[] = [];
    let unplaced = 0;

    for (let i = 0; i < need; i++) {
      const firstDay = Math.floor((i * 7) / Math.max(need, 1));
      let placed: ProposedSession | null = null;
      for (let step = 0; step < 7 && !placed; step++) {
        const dayIdx = (firstDay + step) % 7;
        const day = addDays(week.weekStart, dayIdx);
        if (need <= 7 && usedDays.has(day.getDay())) continue;
        const winStart = new Date(day.getFullYear(), day.getMonth(), day.getDate(), fromH, 0);
        const winEnd = new Date(day.getFullYear(), day.getMonth(), day.getDate(), toH, 0);
        const earliest = new Date(Math.max(winStart.getTime(), roundUp15(now).getTime()));
        if (winEnd.getTime() - earliest.getTime() < minutes * 60000) continue;
        const candidate: Habit = {
          id: `proposal-${goal.id}-${i}`,
          name: goal.weekly_target ?? "Session",
          tier: 1,
          duration_min: minutes,
          search_start: earliest.toISOString(),
          search_end: winEnd.toISOString(),
          context: goal.session_context ?? "other",
          pillar: goal.pillar,
        };
        const r = runEngine(week.weekStart, busy, [candidate], []);
        const p = r.placed.find((x) => x.id === candidate.id);
        if (p) placed = { key: candidate.id, goalId: goal.id, start: p.start, end: p.end };
      }
      if (placed) {
        proposed.push(placed);
        usedDays.add(placed.start.getDay());
        busy.push(asBusy(placed.key, goal.weekly_target ?? "Session", placed.start, placed.end));
      } else {
        unplaced++;
      }
    }
    plans.push({ goal, target, existing, counted: [], proposed, unplaced });
  }
  return plans;
}

function roundUp15(d: Date): Date {
  const x = new Date(d);
  x.setSeconds(0, 0);
  x.setMinutes(Math.ceil(x.getMinutes() / 15) * 15);
  return x;
}

// ---------------------------------------------------------------------------
// Approve / record

export function sessionName(goal: PlanGoal): string {
  return `🎯 ${goal.weekly_target ?? "Goal session"}`;
}

/** Adds the approved sessions as habits pinned to their proposed slots and records the review. */
export async function approveGoalWeek(plan: GoalWeekPlan, sessions: ProposedSession[], weekStart: Date): Promise<void> {
  const g = plan.goal;
  if (sessions.length) {
    const rows = sessions.map((s) => ({
      name: sessionName(g),
      tier: 2,
      duration_min: Math.round((s.end.getTime() - s.start.getTime()) / 60000),
      search_start: s.start.toISOString(),
      search_end: s.end.toISOString(),
      context: g.session_context ?? "other",
      pillar: g.pillar,
      goal_id: g.id,
    }));
    const { error } = await supabase.from("habits").insert(rows);
    if (error) throw new Error(error.message);
  }
  const scheduled = g.plan_mode === "count" ? plan.counted.length : plan.existing.length + sessions.length;
  await recordReview(g.id, weekStart, plan.target, scheduled, scheduled >= plan.target ? "approved" : "short");
}

export async function recordReview(goalId: string, weekStart: Date, target: number, scheduled: number, status: "approved" | "skipped" | "short", note?: string) {
  const { error } = await supabase.from("goal_week_reviews").upsert(
    { goal_id: goalId, week_start: formatLocalDate(weekStart), target_count: target, scheduled_count: scheduled, status, note: note ?? null, reviewed_at: new Date().toISOString() },
    { onConflict: "goal_id,week_start" }
  );
  if (error) throw new Error(error.message);
}

export interface WeekReviewRow {
  goal_id: string;
  week_start: string;
  target_count: number;
  scheduled_count: number;
  status: "approved" | "skipped" | "short";
}

export async function loadReviews(weekStart: Date): Promise<WeekReviewRow[]> {
  const { data, error } = await supabase.from("goal_week_reviews").select("*").eq("week_start", formatLocalDate(weekStart));
  if (error) throw new Error(error.message);
  return (data as WeekReviewRow[]) ?? [];
}

// ---------------------------------------------------------------------------
// Pass 2 — verify the placements held

export interface VerifyResult {
  goalId: string;
  target: number;
  held: number;
  offCalendar: number;
}

export function verifyWeek(goals: PlanGoal[], week: WeekData): VerifyResult[] {
  const r = runEngine(week.weekStart, week.busy, week.habits, week.tasks);
  const placedIds = new Set(r.placed.map((p) => p.id));
  return sortByPriority(goals).map((g) => {
    const target = g.cadence_sessions_per_week ?? 0;
    if (g.plan_mode === "count") {
      const n = countGoalEvents(g, week).length;
      return { goalId: g.id, target, held: n, offCalendar: 0 };
    }
    const mine = week.habits.filter(
      (h) => h.goal_id === g.id && new Date(h.search_start) >= week.weekStart && new Date(h.search_start) < week.weekEnd
    );
    const held = mine.filter((h) => placedIds.has(h.id)).length;
    return { goalId: g.id, target, held, offCalendar: mine.length - held };
  });
}

// ---------------------------------------------------------------------------
// Milestones helpers

export function milestonesDueSoon(goal: PlanGoal, weekStart: Date): Milestone[] {
  const ms = goal.milestones ?? [];
  const horizon = addDays(weekStart, 35);
  return ms.filter((m) => !m.done && new Date(`${m.due}T00:00:00`) < horizon);
}

export async function setMilestoneDone(goal: PlanGoal, milestoneId: string, done: boolean): Promise<Milestone[]> {
  const next = (goal.milestones ?? []).map((m) => (m.id === milestoneId ? { ...m, done } : m));
  const { error } = await supabase.from("goals").update({ milestones: next }).eq("id", goal.id);
  if (error) throw new Error(error.message);
  return next;
}

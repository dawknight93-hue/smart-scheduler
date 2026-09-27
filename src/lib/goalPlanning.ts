/**
 * Goal planning: Cascade output shape, and the Weekly Review's two passes —
 * (1) propose/count each active goal's sessions for a week in pillar priority
 * order, (2) re-run the scheduler afterwards to confirm the sessions held.
 */
import { supabase } from "./supabase";
import { runEngine, addDays, getWeekStart, enrouteAsBusy, WORK_START_HOUR, WORK_END_HOUR } from "./schedulingEngine";
import { parseRecurrenceFromItem, expandRecurrence, formatLocalDate } from "./recurrence";
import type { ContextTag, FixedEvent, Habit, LifePillar, Task } from "./types";
import { loadDailyItems, writeDailyPlan, type DailySession } from "./goalDaily";
import { ownsHabit, planKey, periodBounds, type Period } from "./measures";
import { blockedBusy, type BlockRange } from "./lifeBlocks";

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
  /** Set on a planning view built from one of the goal's effort measures (see measures.ts). */
  measure_id?: string;
  measure_label?: string;
  measure_effort?: "focus" | "routine" | "light" | null;
  /** What `cadence_sessions_per_week` counts per (effort measures; goals are weekly). */
  period?: Period;
  /** When the measure was added: a period it joins partway counts pro rata. */
  measure_created_at?: string;
  /** Weekdays this effort is scheduled on (0 = Sun … 6 = Sat); empty = any. */
  days?: number[] | null;
  /** Big life blocks this goal must avoid (see lifeBlocks.ts); empty = any. */
  blocked_blocks?: string[] | null;
  blocks_asked?: boolean;
}

export const PLAN_GOAL_COLUMNS =
  "id, pillar, specific, time_bound, status, approach, deadline, cadence_sessions_per_week, cadence_label, cadence_confirmed, milestones, weekly_target, plan_mode, session_minutes, session_context, preferred_time, count_calendar_id, count_keyword, cascade_generated_at, blocked_blocks, blocks_asked";

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

function occurrenceEvents<T extends { id: string; name: string; pillar?: LifePillar | null; blocks_schedule?: boolean }>(
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
      out.push({ id: `${it.id}--${date}`, name: it.name, start_time: s.toISOString(), end_time: e.toISOString(), pillar: it.pillar ?? null, blocks_schedule: it.blocks_schedule });
    }
  }
  return out;
}

export async function loadWeekData(weekStart: Date): Promise<WeekData> {
  const weekEnd = addDays(weekStart, 7);
  const [fe, hb, tk, mp, feo, ho, to, eb] = await Promise.all([
    supabase.from("fixed_events").select("*").lt("start_time", weekEnd.toISOString()).gte("end_time", addDays(weekStart, -60).toISOString()),
    supabase.from("habits").select("*"),
    supabase.from("tasks").select("*"),
    supabase.from("gcal_event_map").select("item_id, item_name, calendar_id, calendar_role, start_time"),
    supabase.from("fixed_event_occurrences").select("*"),
    supabase.from("habit_occurrences").select("*"),
    supabase.from("task_occurrences").select("*"),
    supabase.from("enroute_blocks").select("id, name, start_time, end_time").lt("start_time", weekEnd.toISOString()).gt("end_time", weekStart.toISOString()),
  ]);
  for (const r of [fe, hb, tk, mp, feo, ho, to, eb]) if (r.error) throw new Error(r.error.message);

  const fixed = (fe.data as FixedEvent[]) ?? [];
  const habits = (hb.data as Habit[]) ?? [];
  const tasks = (tk.data as Task[]) ?? [];

  const inWeek = fixed.filter((e) => !e.recurrence_enabled && new Date(e.start_time) < weekEnd && new Date(e.end_time) > weekStart);
  const busy: FixedEvent[] = [
    ...inWeek,
    ...enrouteAsBusy((eb.data as { id: string; name: string; start_time: string; end_time: string }[]) ?? []),
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
  return countGoalEventsIn(goal, week, week.weekStart, week.weekEnd);
}

/** Events counted from the goal's calendar between two dates (week data reaches back ~60 days). */
export function countGoalEventsIn(goal: PlanGoal, week: WeekData, from: Date, to: Date): CountedEvent[] {
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
    if (start < from || start >= to) continue;
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

/** How a monthly/quarterly/yearly (or daily) count turns into this week's target. */
export interface PeriodPace {
  period: Period;
  /** The count per period you set. */
  perPeriod: number;
  /** What this period owes (less than perPeriod when the measure joined partway). */
  quota: number;
  /** Sessions already on the calendar in this period before this week. */
  bookedBefore: number;
  label: string; // "October", "Q4 2026", "2026"
}

const PERIOD_LABEL = (period: Period, d: Date) =>
  period === "month" ? d.toLocaleDateString("en-US", { month: "long" }) : period === "quarter" ? `Q${Math.floor(d.getMonth() / 3) + 1} ${d.getFullYear()}` : String(d.getFullYear());

/**
 * This week's target for a planning view. Weekly counts are the count; a daily
 * count is 7× it. Monthly, quarterly and yearly counts are paced across the
 * period: by the end of this week, the share of the period gone by (rounded up)
 * should be booked — so "1 a month" lands in the first week that has room, and
 * "3 a quarter" spreads out instead of piling into week one. The period is the
 * one holding most of this week (its Thursday).
 */
export function weeklyTarget(goal: PlanGoal, week: WeekData): { target: number; pace?: PeriodPace; startsNext?: boolean } {
  const n = goal.cadence_sessions_per_week ?? 0;
  const period = goal.period ?? "week";
  if (period === "week" || period === "day") {
    const full = period === "day" ? n * 7 : n;
    // Added partway through the week: it owes only the days still ahead of it
    // (its chosen weekdays, if it has them), and none at all starts next week.
    // (Only for efforts the app schedules: counted ones arrive from their own calendar.)
    const created = goal.measure_created_at && goal.plan_mode === "schedule" ? new Date(goal.measure_created_at) : null;
    if (!created || created <= week.weekStart || created >= week.weekEnd) return { target: full };
    const firstDay = new Date(created.getFullYear(), created.getMonth(), created.getDate() + 1);
    const daysLeft: Date[] = [];
    for (let d = new Date(firstDay); d < week.weekEnd; d = addDays(d, 1)) daysLeft.push(d);
    const usable = goal.days?.length ? daysLeft.filter((d) => goal.days!.includes(d.getDay())) : daysLeft;
    const allowed = goal.days?.length ? goal.days.length : 7;
    const owed = Math.min(full, Math.round((full * usable.length) / allowed));
    return owed > 0 ? { target: owed } : { target: 0, startsNext: true };
  }
  const mid = addDays(week.weekStart, 3);
  const [ps, pe] = periodBounds(period, mid);
  const weekEnd = week.weekEnd < pe ? week.weekEnd : pe;
  // A measure added partway through a period owes only its share of that period
  // (a monthly date night added on the 27th owes nothing until next month).
  const created = goal.measure_created_at && goal.plan_mode === "schedule" ? new Date(goal.measure_created_at) : null;
  const from = created && created > ps && created < pe ? created : ps;
  const quota = from > ps ? Math.round((n * (pe.getTime() - from.getTime())) / (pe.getTime() - ps.getTime())) : n;
  const frac = Math.min(1, Math.max(0, (weekEnd.getTime() - from.getTime()) / Math.max(1, pe.getTime() - from.getTime())));
  const dueByWeekEnd = Math.min(quota, Math.ceil(quota * frac - 1e-9));
  const bookedBefore =
    goal.plan_mode === "count"
      ? countGoalEventsIn(goal, week, ps, week.weekStart).length
      : week.habits.filter((h) => ownsHabit(goal, h) && new Date(h.search_start) >= ps && new Date(h.search_start) < week.weekStart).length;
  return { target: Math.max(0, dueByWeekEnd - bookedBefore), pace: { period, perPeriod: n, quota, bookedBefore, label: PERIOD_LABEL(period, mid) } };
}

export interface GoalWeekPlan {
  goal: PlanGoal;
  target: number;
  /** The effort was added this week with no days left for it: it starts next week. */
  startsNext?: boolean;
  /** Set when the goal's count is per day/month/quarter/year. */
  pace?: PeriodPace;
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
export function planWeek(goals: PlanGoal[], week: WeekData, now = new Date(), blocks: BlockRange[] = []): GoalWeekPlan[] {
  // Everything the scheduler already places this week counts as busy.
  const base = runEngine(week.weekStart, week.busy, week.habits, week.tasks);
  const busy: FixedEvent[] = [
    ...week.busy,
    ...base.placed.filter((p) => p.kind !== "Fixed Event" && !p.isAllDay).map((p) => asBusy(`placed-${p.id}-${p.start.getTime()}`, p.name, p.start, p.end)),
  ];

  const plans: GoalWeekPlan[] = [];
  for (const goal of sortByPriority(goals)) {
    const wt = weeklyTarget(goal, week);
    const { pace } = wt;
    const existing = week.habits.filter(
      (h) => ownsHabit(goal, h) && new Date(h.search_start) >= week.weekStart && new Date(h.search_start) < week.weekEnd
    );
    // Already has sessions this week (you placed them anyway): it has started, count those.
    const startsNext = wt.startsNext && existing.length === 0;
    const target = wt.startsNext && existing.length ? existing.length : wt.target;
    if (goal.plan_mode === "count") {
      plans.push({ goal, target, pace, startsNext, existing: [], counted: countGoalEvents(goal, week), proposed: [], unplaced: 0 });
      continue;
    }
    // Big life blocks this goal stays out of count as busy for it alone.
    const avoid = blockedBusy(blocks, goal.blocked_blocks);
    const need = Math.max(0, target - existing.length);
    const minutes = goal.session_minutes ?? 30;
    const [fromH, toH] = PREFERRED_WINDOWS[goal.preferred_time ?? "any"];
    const usedDays = new Set(existing.map((h) => new Date(h.search_start).getDay()));
    const proposed: ProposedSession[] = [];
    let unplaced = 0;
    // Chosen weekdays (e.g. Tue & Thu) are the only days tried; otherwise spread across the week.
    const allowedIdx = goal.days?.length ? [0, 1, 2, 3, 4, 5, 6].filter((i) => goal.days!.includes(addDays(week.weekStart, i).getDay())) : [0, 1, 2, 3, 4, 5, 6];

    for (let i = 0; i < need; i++) {
      const firstDay = Math.floor((i * allowedIdx.length) / Math.max(need, 1));
      let placed: ProposedSession | null = null;
      for (let step = 0; step < allowedIdx.length && !placed; step++) {
        const dayIdx = allowedIdx[(firstDay + step) % allowedIdx.length];
        const day = addDays(week.weekStart, dayIdx);
        if (need <= allowedIdx.length && usedDays.has(day.getDay())) continue;
        const winStart = new Date(day.getFullYear(), day.getMonth(), day.getDate(), fromH, 0);
        const winEnd = new Date(day.getFullYear(), day.getMonth(), day.getDate(), toH, 0);
        const earliest = new Date(Math.max(winStart.getTime(), roundUp15(now).getTime()));
        if (winEnd.getTime() - earliest.getTime() < minutes * 60000) continue;
        const candidate: Habit = {
          id: `proposal-${planKey(goal)}-${i}`,
          name: goal.weekly_target ?? "Session",
          tier: 1,
          duration_min: minutes,
          search_start: earliest.toISOString(),
          search_end: winEnd.toISOString(),
          context: goal.session_context ?? "other",
          pillar: goal.pillar,
        };
        const r = runEngine(week.weekStart, avoid.length ? [...busy, ...avoid] : busy, [candidate], []);
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
    plans.push({ goal, target, pace, startsNext, existing, counted: [], proposed, unplaced });
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

/**
 * Adds the approved sessions as habits pinned to their proposed slots, records
 * the review, then writes the Daily level: a focus for every session this week
 * that doesn't have one yet (a failed focus request never undoes the approval).
 */
export async function approveGoalWeek(plan: GoalWeekPlan, sessions: ProposedSession[], weekStart: Date): Promise<void> {
  const g = plan.goal;
  const daily: DailySession[] = [];
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
      measure_id: g.measure_id ?? null,
      ...(g.measure_effort ? { effort: g.measure_effort, effort_auto: false } : {}),
    }));
    const { data, error } = await supabase.from("habits").insert(rows).select("id, search_start, search_end");
    if (error) throw new Error(error.message);
    for (const h of (data as Pick<Habit, "id" | "search_start" | "search_end">[]) ?? []) {
      daily.push({ habitId: h.id, start: new Date(h.search_start), end: new Date(h.search_end) });
    }
  }
  const scheduled = g.plan_mode === "count" ? plan.counted.length : plan.existing.length + sessions.length;
  await recordReview(g.id, weekStart, plan.target, scheduled, scheduled >= plan.target ? "approved" : "short", undefined, g.measure_id ?? "");

  if (g.plan_mode !== "count") {
    try {
      const items = await loadDailyItems(weekStart, addDays(weekStart, 7));
      const covered = new Set(items.map((i) => i.habit_id));
      for (const h of plan.existing) {
        if (!covered.has(h.id)) daily.push({ habitId: h.id, start: new Date(h.search_start), end: new Date(h.search_end) });
      }
      if (daily.length) await writeDailyPlan(g, daily, weekStart, items);
    } catch (e) {
      console.warn("Daily plan not written:", e);
    }
  }
}

export async function recordReview(
  goalId: string,
  weekStart: Date,
  target: number,
  scheduled: number,
  status: "approved" | "skipped" | "short",
  note?: string,
  measureKey = ""
) {
  const { error } = await supabase.from("goal_week_reviews").upsert(
    { goal_id: goalId, measure_key: measureKey, week_start: formatLocalDate(weekStart), target_count: target, scheduled_count: scheduled, status, note: note ?? null, reviewed_at: new Date().toISOString() },
    { onConflict: "goal_id,week_start,measure_key" }
  );
  if (error) throw new Error(error.message);
}

export interface WeekReviewRow {
  goal_id: string;
  /** The effort measure reviewed ('' for reviews from before measures). */
  measure_key?: string;
  week_start: string;
  target_count: number;
  scheduled_count: number;
  status: "approved" | "skipped" | "short";
}

/** The review row for a planning view ('' rows belong to a goal's first measure). */
export function reviewForPlan(reviews: WeekReviewRow[], g: Pick<PlanGoal, "id" | "measure_id">, firstMeasureId?: string): WeekReviewRow | undefined {
  const key = g.measure_id ?? "";
  return reviews.find((r) => r.goal_id === g.id && ((r.measure_key ?? "") === key || (!r.measure_key && (!g.measure_id || g.measure_id === firstMeasureId))));
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
  /** planKey of the planning view (measure id, or goal id). */
  key: string;
  target: number;
  held: number;
  offCalendar: number;
  /** Sessions ticked done so far (Daily level). */
  done: number;
}

export function verifyWeek(goals: PlanGoal[], week: WeekData, doneByGoal: Map<string, number> = new Map()): VerifyResult[] {
  const r = runEngine(week.weekStart, week.busy, week.habits, week.tasks);
  const placedIds = new Set(r.placed.map((p) => p.id));
  return sortByPriority(goals).map((g) => {
    const { target } = weeklyTarget(g, week);
    const key = planKey(g);
    const done = doneByGoal.get(key) ?? 0;
    if (g.plan_mode === "count") {
      const n = countGoalEvents(g, week).length;
      return { goalId: g.id, key, target, held: n, offCalendar: 0, done };
    }
    const mine = week.habits.filter(
      (h) => ownsHabit(g, h) && new Date(h.search_start) >= week.weekStart && new Date(h.search_start) < week.weekEnd
    );
    const held = mine.filter((h) => placedIds.has(h.id)).length;
    return { goalId: g.id, key, target, held, offCalendar: mine.length - held, done };
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

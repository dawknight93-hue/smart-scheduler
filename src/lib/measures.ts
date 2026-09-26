/**
 * Goal measures: how progress on a goal is measured.
 *
 *   effort  — something you do every week (sessions × minutes, or hours per
 *             week split into sessions). Reaches the calendar the same way a
 *             goal's weekly target always has: scheduled by the app in free
 *             time, or counted from a calendar that already carries it.
 *   outcome — a number you log on a rhythm (weight, open tasks, a score), with
 *             the direction that counts as progress and dated checkpoints.
 *
 * The planner suggests measures; you accept, edit or dismiss them. Everything
 * that plans a week (Weekly Review, Briefing) works per effort measure by
 * turning each one into a "goal view" that carries that measure's target.
 */
import { supabase } from "./supabase";
import type { ContextTag } from "./types";
import type { Effort } from "./effort";
import type { PlanGoal, PlanMode, PreferredTime } from "./goalPlanning";
import { formatLocalDate } from "./recurrence";

export type MeasureKind = "effort" | "outcome";
export type MeasureStatus = "active" | "suggested" | "archived";
export type Direction = "down" | "up";
export type LogEvery = "daily" | "weekly" | "monthly";

export interface Checkpoint {
  due: string; // YYYY-MM-DD
  target: number;
}

export interface GoalMeasure {
  id: string;
  goal_id: string;
  position: number;
  kind: MeasureKind;
  status: MeasureStatus;
  label: string;
  why: string | null;
  // effort
  plan_mode: PlanMode | null;
  sessions_per_week: number | null;
  session_minutes: number | null;
  hours_per_week: number | null;
  context: ContextTag | null;
  preferred_time: PreferredTime;
  effort: Effort | null;
  count_calendar_id: string | null;
  count_keyword: string | null;
  // outcome
  unit: string | null;
  direction: Direction | null;
  baseline: number | null;
  target: number | null;
  log_every: LogEvery | null;
  log_weekday: number | null;
  checkpoints: Checkpoint[];
  created_at: string;
}

export interface MeasureEntry {
  id: string;
  measure_id: string;
  goal_id: string;
  value: number;
  logged_on: string; // YYYY-MM-DD
  note: string | null;
  created_at: string;
}

export type NewMeasure = Omit<GoalMeasure, "id" | "created_at">;

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const num = (v: unknown): number | null => (v === null || v === undefined || v === "" || Number.isNaN(Number(v)) ? null : Number(v));

function normalize(m: GoalMeasure): GoalMeasure {
  return {
    ...m,
    sessions_per_week: num(m.sessions_per_week),
    session_minutes: num(m.session_minutes),
    hours_per_week: num(m.hours_per_week),
    baseline: num(m.baseline),
    target: num(m.target),
    log_weekday: num(m.log_weekday),
    preferred_time: m.preferred_time ?? "any",
    checkpoints: (Array.isArray(m.checkpoints) ? m.checkpoints : [])
      .map((c) => ({ due: String(c.due).slice(0, 10), target: Number(c.target) }))
      .filter((c) => /^\d{4}-\d{2}-\d{2}$/.test(c.due) && Number.isFinite(c.target))
      .sort((a, b) => a.due.localeCompare(b.due)),
  };
}

// ---------------------------------------------------------------------------
// Load / save

export async function loadMeasures(goalIds?: string[]): Promise<GoalMeasure[]> {
  let q = supabase.from("goal_measures").select("*").order("position").order("created_at");
  if (goalIds?.length) q = q.in("goal_id", goalIds);
  const { data, error } = await q;
  // Table not there yet: behave as if no goal has measures (legacy weekly target still works).
  if (error) return [];
  return ((data as GoalMeasure[]) ?? []).map(normalize);
}

export async function loadEntries(measureIds: string[], since?: string): Promise<MeasureEntry[]> {
  if (!measureIds.length) return [];
  let q = supabase.from("measure_entries").select("*").in("measure_id", measureIds).order("logged_on").order("created_at");
  if (since) q = q.gte("logged_on", since);
  const { data, error } = await q;
  if (error) return [];
  return ((data as MeasureEntry[]) ?? []).map((e) => ({ ...e, value: Number(e.value) }));
}

function measureRow(m: Partial<NewMeasure>) {
  const { ...rest } = m as Record<string, unknown>;
  delete rest.id;
  delete rest.created_at;
  return { ...rest, updated_at: new Date().toISOString() };
}

export async function saveMeasure(m: Partial<GoalMeasure> & { goal_id: string }): Promise<GoalMeasure> {
  const q = m.id
    ? supabase.from("goal_measures").update(measureRow(m)).eq("id", m.id).select("*").single()
    : supabase.from("goal_measures").insert(measureRow(m)).select("*").single();
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  await syncGoalFromMeasures(m.goal_id);
  return normalize(data as GoalMeasure);
}

export async function setMeasureStatus(m: GoalMeasure, status: MeasureStatus): Promise<void> {
  const { error } = await supabase.from("goal_measures").update({ status, updated_at: new Date().toISOString() }).eq("id", m.id);
  if (error) throw new Error(error.message);
  await syncGoalFromMeasures(m.goal_id);
}

export async function deleteMeasure(m: GoalMeasure): Promise<void> {
  const { error } = await supabase.from("goal_measures").delete().eq("id", m.id);
  if (error) throw new Error(error.message);
  await syncGoalFromMeasures(m.goal_id);
}

export async function addEntry(m: GoalMeasure, value: number, loggedOn: string, note?: string): Promise<MeasureEntry> {
  const { data, error } = await supabase
    .from("measure_entries")
    .insert({ measure_id: m.id, goal_id: m.goal_id, value, logged_on: loggedOn, note: note?.trim() || null })
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return { ...(data as MeasureEntry), value: Number((data as MeasureEntry).value) };
}

export async function deleteEntry(id: string): Promise<void> {
  const { error } = await supabase.from("measure_entries").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

/**
 * The goal row still carries a single weekly target (older screens read it).
 * Keep it equal to the goal's first active effort measure.
 */
async function syncGoalFromMeasures(goalId: string): Promise<void> {
  const { data } = await supabase
    .from("goal_measures")
    .select("*")
    .eq("goal_id", goalId)
    .eq("kind", "effort")
    .eq("status", "active")
    .order("position")
    .order("created_at")
    .limit(1);
  const m = (data as GoalMeasure[] | null)?.[0];
  if (!m) return;
  await supabase
    .from("goals")
    .update({
      plan_mode: m.plan_mode,
      cadence_sessions_per_week: m.sessions_per_week,
      weekly_target: m.label,
      session_minutes: m.session_minutes,
      session_context: m.context,
      preferred_time: m.preferred_time ?? "any",
      count_calendar_id: m.count_calendar_id,
      count_keyword: m.count_keyword,
    })
    .eq("id", goalId);
}

/** Replace a goal's pending suggestions with a fresh set from the planner. */
export async function saveSuggestions(goalId: string, proposals: Partial<NewMeasure>[], afterPosition: number): Promise<GoalMeasure[]> {
  await supabase.from("goal_measures").delete().eq("goal_id", goalId).eq("status", "suggested");
  if (!proposals.length) return [];
  const rows = proposals.map((p, i) => ({ ...measureRow(p), goal_id: goalId, status: "suggested", position: afterPosition + 1 + i }));
  const { data, error } = await supabase.from("goal_measures").insert(rows).select("*");
  if (error) throw new Error(error.message);
  return ((data as GoalMeasure[]) ?? []).map(normalize);
}

// ---------------------------------------------------------------------------
// Effort measures → goal views for weekly planning

/**
 * One planning view per active effort measure (in goal order, then measure
 * order). A goal with no measures at all keeps working from its own weekly
 * target, exactly as before.
 */
export function effortGoals(goals: PlanGoal[], measures: GoalMeasure[]): PlanGoal[] {
  const out: PlanGoal[] = [];
  for (const g of goals) {
    if (g.status !== "active") continue;
    const all = measures.filter((m) => m.goal_id === g.id);
    const efforts = all.filter((m) => m.kind === "effort" && m.status === "active" && m.plan_mode && (m.sessions_per_week ?? 0) > 0);
    if (!all.length) {
      if (g.plan_mode && (g.cadence_sessions_per_week ?? 0) > 0) out.push(g);
      continue;
    }
    for (const m of efforts) {
      out.push({
        ...g,
        measure_id: m.id,
        measure_label: m.label,
        measure_effort: m.effort,
        plan_mode: m.plan_mode,
        cadence_sessions_per_week: m.sessions_per_week,
        session_minutes: m.session_minutes,
        session_context: m.context,
        preferred_time: m.preferred_time ?? "any",
        count_calendar_id: m.count_calendar_id,
        count_keyword: m.count_keyword,
        weekly_target: m.label,
      });
    }
  }
  return out;
}

/** Stable key for a planning view (a measure, or a goal without measures). */
export const planKey = (g: Pick<PlanGoal, "id" | "measure_id">) => g.measure_id ?? g.id;

/** Whether a 🎯 session habit belongs to this planning view. */
export function ownsHabit(g: Pick<PlanGoal, "id" | "measure_id">, h: { goal_id?: string | null; measure_id?: string | null }): boolean {
  if (h.goal_id !== g.id) return false;
  return !g.measure_id || h.measure_id === g.measure_id;
}

/** Split hours per week into sessions of a sensible length (45–90 min). */
export function splitHours(hours: number, sessions?: number | null): { sessions: number; minutes: number } {
  const total = Math.max(15, Math.round(hours * 60));
  const n = sessions && sessions > 0 ? sessions : Math.max(1, Math.round(total / 75));
  return { sessions: n, minutes: Math.max(10, Math.round(total / n / 5) * 5) };
}

export function describeEffort(m: GoalMeasure, calendarName?: string): string {
  const n = m.sessions_per_week ?? 0;
  if (m.plan_mode === "count") return `${n}× a week · counted from ${calendarName ?? "a calendar"}${m.count_keyword ? ` (titles with “${m.count_keyword}”)` : ""}`;
  const mins = m.session_minutes ?? 30;
  const hours = (n * mins) / 60;
  return `${n} × ${mins} min a week (${Number.isInteger(hours) ? hours : hours.toFixed(1)} h) · scheduled by the app`;
}

export function describeOutcome(m: GoalMeasure): string {
  const unit = m.unit ? ` ${m.unit}` : "";
  const dir = m.direction === "down" ? "lower is better" : "higher is better";
  const rhythm = m.log_every === "weekly" ? `logged weekly${m.log_weekday !== null ? ` on ${WEEKDAYS[m.log_weekday]}s` : ""}` : m.log_every === "monthly" ? "logged monthly" : "logged daily";
  const range = m.baseline !== null && m.target !== null ? `${fmt(m.baseline)} → ${fmt(m.target)}${unit}` : m.target !== null ? `target ${fmt(m.target)}${unit}` : "";
  return [range, dir, rhythm].filter(Boolean).join(" · ");
}

export const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));

// ---------------------------------------------------------------------------
// Outcome status

const parseDay = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
};
const DAY = 86400000;

export interface CheckpointResult extends Checkpoint {
  /** Value logged on or before the due date (latest one). */
  value: number | null;
  met: boolean | null; // null = nothing logged by then
}

export interface OutcomeStatus {
  latest: MeasureEntry | null;
  /** Change since the baseline (or first entry). */
  change: number | null;
  next: Checkpoint | null;
  daysToNext: number | null;
  /** Where you'd be today on a straight line to the next checkpoint. */
  expected: number | null;
  onTrack: boolean | null;
  /** Share of the way from baseline to target (0–1+). */
  progress: number | null;
  past: CheckpointResult[];
  due: boolean;
  dueSince: string | null;
  entries: MeasureEntry[];
}

const better = (m: GoalMeasure, value: number, than: number) => (m.direction === "up" ? value >= than : value <= than);

/** First day of the logging period that contains `today` (YYYY-MM-DD). */
export function periodStart(m: GoalMeasure, today: Date): string {
  const d = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  if (m.log_every === "daily") return formatLocalDate(d);
  if (m.log_every === "monthly") return formatLocalDate(new Date(d.getFullYear(), d.getMonth(), 1));
  const wd = m.log_weekday ?? 1; // Monday
  const back = (d.getDay() - wd + 7) % 7;
  return formatLocalDate(new Date(d.getFullYear(), d.getMonth(), d.getDate() - back));
}

export function outcomeStatus(m: GoalMeasure, allEntries: MeasureEntry[], now = new Date()): OutcomeStatus {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayStr = formatLocalDate(today);
  const entries = allEntries.filter((e) => e.measure_id === m.id && e.logged_on <= todayStr).sort((a, b) => a.logged_on.localeCompare(b.logged_on) || a.created_at.localeCompare(b.created_at));
  const latest = entries[entries.length - 1] ?? null;
  const start = m.baseline ?? entries[0]?.value ?? null;
  const change = latest && start !== null ? latest.value - start : null;
  const cps = m.checkpoints;
  const next = cps.find((c) => c.due >= todayStr) ?? null;
  const prev = [...cps].reverse().find((c) => c.due < todayStr) ?? null;

  let expected: number | null = null;
  if (next) {
    const fromDate = prev ? parseDay(prev.due) : parseDay((entries[0]?.logged_on ?? m.created_at).slice(0, 10));
    const fromVal = prev ? prev.target : start;
    if (fromVal !== null) {
      const span = parseDay(next.due).getTime() - fromDate.getTime();
      const t = span > 0 ? Math.min(1, Math.max(0, (today.getTime() - fromDate.getTime()) / span)) : 1;
      expected = fromVal + (next.target - fromVal) * t;
    }
  }
  const onTrack = latest && next ? better(m, latest.value, next.target) || (expected !== null && better(m, latest.value, expected)) : null;
  const progress = latest && start !== null && m.target !== null && m.target !== start ? (latest.value - start) / (m.target - start) : null;

  const past: CheckpointResult[] = cps
    .filter((c) => c.due < todayStr)
    .map((c) => {
      const v = [...entries].reverse().find((e) => e.logged_on <= c.due) ?? null;
      return { ...c, value: v?.value ?? null, met: v ? better(m, v.value, c.target) : null };
    });

  const ps = m.log_every ? periodStart(m, today) : null;
  const due = !!ps && !entries.some((e) => e.logged_on >= ps);
  return {
    latest,
    change,
    next,
    daysToNext: next ? Math.round((parseDay(next.due).getTime() - today.getTime()) / DAY) : null,
    expected,
    onTrack,
    progress,
    past,
    due,
    dueSince: due ? ps : null,
    entries,
  };
}

/** One line for the Briefing facts and the Review ("Weight: 207.4 lb on Sep 27 …"). */
export function outcomeFact(m: GoalMeasure, s: OutcomeStatus, day: (iso: string) => string = (x) => x): string {
  const unit = m.unit ? ` ${m.unit}` : "";
  const cmp = m.direction === "up" ? "≥" : "≤";
  if (!s.latest) {
    return `${m.label}: nothing logged yet${s.next ? `; next checkpoint ${cmp} ${fmt(s.next.target)}${unit} by ${day(s.next.due)}` : ""}`;
  }
  const parts = [`${m.label}: latest logged ${fmt(s.latest.value)}${unit} on ${day(s.latest.logged_on)}`];
  if (s.change !== null && m.baseline !== null) parts.push(`${s.change >= 0 ? "+" : ""}${fmt(Math.round(s.change * 10) / 10)}${unit} since the ${fmt(m.baseline)}${unit} baseline`);
  if (s.next) parts.push(`next checkpoint ${cmp} ${fmt(s.next.target)}${unit} by ${day(s.next.due)} (${s.daysToNext} days): ${s.onTrack ? "on track" : "behind"}`);
  const lastPast = s.past[s.past.length - 1];
  if (lastPast) parts.push(`checkpoint ${cmp} ${fmt(lastPast.target)}${unit} on ${day(lastPast.due)} was ${lastPast.met === null ? "not logged" : lastPast.met ? "met" : "missed"}`);
  if (s.due) parts.push(`an entry is due (since ${day(s.dueSince!)})`);
  return parts.join("; ");
}

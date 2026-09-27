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
/** What an effort measure's count is per. `sessions_per_week` holds the count. */
export type Period = "day" | "week" | "month" | "quarter" | "year";
export const PERIODS: Period[] = ["day", "week", "month", "quarter", "year"];
export const PERIOD_WORD: Record<Period, string> = { day: "day", week: "week", month: "month", quarter: "quarter", year: "year" };

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
  /** The count per `period` (named for when every effort was weekly). */
  sessions_per_week: number | null;
  period: Period;
  /** Weekdays to schedule on (0 = Sun … 6 = Sat); null/empty = any day. */
  days: number[] | null;
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
    period: PERIODS.includes(m.period) ? m.period : "week",
    days: Array.isArray(m.days) && m.days.length ? [...new Set(m.days.map(Number).filter((d) => d >= 0 && d <= 6))].sort() : null,
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
  // One request inserts every row, so every row must carry the same columns:
  // a column one row leaves out would be sent as null for it (not its default),
  // e.g. an effort suggestion has no checkpoints and an outcome has no period.
  const rows = proposals.map((p, i) => ({
    ...measureRow(p),
    goal_id: goalId,
    status: "suggested",
    position: afterPosition + 1 + i,
    period: p.kind === "effort" && p.period && PERIODS.includes(p.period) ? p.period : "week",
    preferred_time: p.preferred_time ?? "any",
    checkpoints: Array.isArray(p.checkpoints) ? p.checkpoints : [],
    days: Array.isArray(p.days) && p.days.length ? p.days : null,
  }));
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
        period: m.period ?? "week",
        measure_created_at: m.created_at,
        days: m.days,
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

export const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** "Tue & Thu", "Mon, Wed & Fri" — Monday-first order. */
export function daysText(days: number[] | null | undefined): string {
  if (!days?.length) return "";
  const names = [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((d) => DAY_SHORT[d]);
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} & ${names[names.length - 1]}`;
}

export function describeEffort(m: GoalMeasure, calendarName?: string): string {
  const n = m.sessions_per_week ?? 0;
  const per = PERIOD_WORD[m.period ?? "week"];
  const on = m.days?.length ? ` · ${daysText(m.days)}` : "";
  if (m.plan_mode === "count") return `${n}× a ${per} · counted from ${calendarName ?? "a calendar"}${m.count_keyword ? ` (titles with “${m.count_keyword}”)` : ""}`;
  const mins = m.session_minutes ?? 30;
  const hours = (n * mins) / 60;
  return `${n} × ${mins} min a ${per} (${Number.isInteger(hours) ? hours : hours.toFixed(1)} h)${on} · scheduled by the app`;
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

// ---------------------------------------------------------------------------
// Pace ladder: what a number needs to do this week/month/quarter/year

export type PaceLevel = "week" | "month" | "quarter" | "year";

/** [start, end) of the calendar week (Mon), month, quarter or year containing d. */
export function periodBounds(level: PaceLevel | Period, d: Date): [Date, Date] {
  const y = d.getFullYear();
  const mo = d.getMonth();
  if (level === "day") {
    const s = new Date(y, mo, d.getDate());
    return [s, new Date(y, mo, d.getDate() + 1)];
  }
  if (level === "week") {
    const back = (d.getDay() + 6) % 7;
    const s = new Date(y, mo, d.getDate() - back);
    return [s, new Date(s.getFullYear(), s.getMonth(), s.getDate() + 7)];
  }
  if (level === "month") return [new Date(y, mo, 1), new Date(y, mo + 1, 1)];
  if (level === "quarter") {
    const q = Math.floor(mo / 3) * 3;
    return [new Date(y, q, 1), new Date(y, q + 3, 1)];
  }
  return [new Date(y, 0, 1), new Date(y + 1, 0, 1)];
}

export interface PaceRow {
  level: PaceLevel | "goal";
  label: string;
  /** Period end (or the deadline, if sooner). */
  end: Date;
  /** Where the number should be by `end` to stay on pace. */
  targetAtEnd: number;
  /** The number at the start of the period (last entry before it, or the start value). */
  startValue: number;
  /** Change this period needs. */
  needed: number;
  /** Change so far this period (null = nothing logged yet). */
  soFar: number | null;
  onTrack: boolean | null;
  /** Change needed per period of this length from here to the deadline, at an even pace. */
  rate: number | null;
  /** Short name of the current period ("Oct", "Q4", "2026"). */
  short: string;
}

const PERIOD_DAYS: Record<PaceLevel, number> = { week: 7, month: 30.44, quarter: 91.31, year: 365.25 };

/**
 * Splits the road from the start value to the target into the periods that
 * suit how far away the deadline is — weeks when it's close, months and
 * quarters inside two years, quarters and years beyond — so "save 6k by next
 * year" reads as "this month +$400, this quarter +$1,200, by the deadline 20k".
 * Checkpoints, when set, bend the line (pace follows them).
 */
export function paceLadder(m: GoalMeasure, allEntries: MeasureEntry[], deadline: string | null | undefined, now = new Date()): PaceRow[] {
  if (m.target === null) return [];
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const entries = allEntries
    .filter((e) => e.measure_id === m.id && e.logged_on <= formatLocalDate(today))
    .sort((a, b) => a.logged_on.localeCompare(b.logged_on) || a.created_at.localeCompare(b.created_at));
  const startValue = m.baseline ?? entries[0]?.value ?? null;
  if (startValue === null) return [];
  const startDate = parseDay((entries[0]?.logged_on && entries[0].logged_on < m.created_at.slice(0, 10) ? entries[0].logged_on : m.created_at).slice(0, 10));
  const endDate = deadline
    ? (() => {
        const d = new Date(deadline);
        return new Date(d.getFullYear(), d.getMonth(), d.getDate());
      })()
    : m.checkpoints.length
      ? parseDay(m.checkpoints[m.checkpoints.length - 1].due)
      : null;
  if (!endDate || endDate <= today) return [];

  // The line to follow: start → checkpoints → target on the deadline.
  const pts: { t: number; v: number }[] = [{ t: startDate.getTime(), v: startValue }];
  for (const c of m.checkpoints) {
    const t = parseDay(c.due).getTime();
    if (t > startDate.getTime() && t < endDate.getTime()) pts.push({ t, v: c.target });
  }
  pts.push({ t: endDate.getTime(), v: m.target });
  const at = (d: Date) => {
    const t = d.getTime();
    if (t <= pts[0].t) return pts[0].v;
    for (let i = 1; i < pts.length; i++) {
      if (t <= pts[i].t) {
        const a = pts[i - 1];
        const b = pts[i];
        return a.v + ((b.v - a.v) * (t - a.t)) / Math.max(1, b.t - a.t);
      }
    }
    return pts[pts.length - 1].v;
  };

  const latest = entries[entries.length - 1] ?? null;
  const daysLeft = (endDate.getTime() - today.getTime()) / DAY;
  const remaining = m.target - (latest?.value ?? startValue);
  const levels: PaceLevel[] = daysLeft <= 56 ? ["week"] : daysLeft <= 183 ? ["week", "month"] : daysLeft <= 730 ? ["month", "quarter", "year"] : ["quarter", "year"];
  const rows: PaceRow[] = [];
  const onPaceNow = at(today);
  for (const level of levels) {
    const [ps, pe] = periodBounds(level, today);
    const end = pe > endDate ? endDate : new Date(pe.getTime() - 1);
    const before = [...entries].reverse().find((e) => parseDay(e.logged_on) < ps);
    const sv = before ? before.value : startValue;
    const targetAtEnd = at(end);
    const label =
      level === "week"
        ? "This week"
        : level === "month"
          ? ps.toLocaleDateString("en-US", { month: "long" })
          : level === "quarter"
            ? `Q${Math.floor(ps.getMonth() / 3) + 1} ${ps.getFullYear()}`
            : String(ps.getFullYear());
    const short =
      level === "week" ? "This week" : level === "month" ? ps.toLocaleDateString("en-US", { month: "short" }) : level === "quarter" ? `Q${Math.floor(ps.getMonth() / 3) + 1}` : String(ps.getFullYear());
    rows.push({
      level,
      short,
      rate: remaining * Math.min(1, PERIOD_DAYS[level] / Math.max(1, daysLeft)),
      label: pe > endDate ? `${label} (to deadline)` : label,
      end,
      targetAtEnd,
      startValue: sv,
      needed: targetAtEnd - sv,
      soFar: latest ? latest.value - sv : null,
      onTrack: latest ? better(m, latest.value, onPaceNow) : null,
    });
  }
  const from = latest?.value ?? startValue;
  rows.push({
    level: "goal",
    short: "Goal",
    rate: null,
    label: `By ${endDate.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`,
    end: endDate,
    targetAtEnd: m.target,
    startValue: startValue,
    needed: m.target - from,
    soFar: latest ? latest.value - startValue : null,
    onTrack: latest ? better(m, latest.value, onPaceNow) : null,
  });
  return rows;
}

/** A value with its unit — money units read "$14,500", others "207.4 lb". */
export function withUnit(v: number, unit: string | null | undefined): string {
  const u = (unit ?? "").trim();
  const big = Math.abs(v) >= 1000;
  const num = big ? Math.round(v).toLocaleString("en-US") : fmt(Math.round(v * 10) / 10);
  if (/^(\$|usd|dollars?)$/i.test(u)) {
    const a = Math.abs(v);
    return `${v < 0 ? "-" : ""}$${a >= 100 ? Math.round(a).toLocaleString("en-US") : a.toFixed(a % 1 ? 2 : 0)}`;
  }
  return u ? `${num} ${u}` : num;
}

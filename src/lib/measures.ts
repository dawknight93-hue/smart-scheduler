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
  /** Outcome: a checkpoint missed by no more than this reads "close" (e.g. 1 lb). */
  tolerance: number | null;
  /** Weekly effort: sessions beyond last week's target (up to a week's worth) count toward this week. */
  bankable: boolean;
  /** Outcome: its value is the number of ticked sessions of this effort (no manual logging). */
  counts_measure_id: string | null;
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
    tolerance: num(m.tolerance),
    bankable: !!m.bankable,
    counts_measure_id: m.counts_measure_id ?? null,
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
  const ms = ((data as GoalMeasure[]) ?? []).map(normalize);
  return applyMeasureDefaults(ms);
}

// ---------------------------------------------------------------------------
// Rules every goal gets (old ones and new ones), applied whenever measures load,
// so a fix made for one goal reaches every goal of the same kind.

const STOP = new Set(["weekly", "monthly", "daily", "quarterly", "yearly", "session", "completed", "complete", "tally", "count", "total", "number", "of", "the", "a", "per", "done"]);
/** "Check-ins Completed" → ["checkin"]; "Monthly Date Night" → ["date", "night"]. */
export function labelWords(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/-/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w))
    .filter((w) => !STOP.has(w));
}

/**
 * A counting number ("Check-ins Completed", "Date Nights Tally": higher is better,
 * starting from 0) whose name matches exactly one effort on the same goal counts
 * that effort's ticked sessions instead of being logged by hand.
 */
export function countLinkFor(m: GoalMeasure, all: GoalMeasure[]): string | null {
  if (m.kind !== "outcome" || m.direction !== "up" || (m.baseline ?? 0) !== 0) return null;
  const mine = new Set([...labelWords(m.label), ...labelWords(m.unit ?? "")]);
  const hits = all.filter((e) => {
    if (e.goal_id !== m.goal_id || e.kind !== "effort" || e.status === "archived") return false;
    const w = labelWords(e.label);
    return w.length > 0 && w.every((x) => mine.has(x));
  });
  return hits.length === 1 ? hits[0].id : null;
}

/**
 * Default close band for a logged number nobody set one for: 5% of the distance
 * from start to target (whole units for whole-number measures). 210 → 190 lb gets
 * ±1 lb; a 0 → 13 count gets ±1; a counted (auto) number gets none.
 */
export function defaultTolerance(m: GoalMeasure): number | null {
  if (m.kind !== "outcome" || m.baseline === null || m.target === null) return null;
  if (m.counts_measure_id) return 0;
  const span = Math.abs(m.target - m.baseline);
  const integral = [m.baseline, m.target, ...m.checkpoints.map((c) => c.target)].every((v) => Number.isInteger(v));
  const raw = span * 0.05;
  return integral ? Math.max(0, Math.round(raw)) : Math.round(raw * 10) / 10;
}

function applyMeasureDefaults(ms: GoalMeasure[]): GoalMeasure[] {
  const patches: { id: string; patch: Partial<GoalMeasure> }[] = [];
  const out = ms.map((m) => {
    if (m.kind !== "outcome") return m;
    const patch: Partial<GoalMeasure> = {};
    if (!m.counts_measure_id) {
      const link = countLinkFor(m, ms);
      if (link) patch.counts_measure_id = link;
    }
    const next = { ...m, ...patch };
    if (next.tolerance === null) {
      const t = defaultTolerance(next);
      if (t !== null) patch.tolerance = t;
    }
    if (!Object.keys(patch).length) return m;
    patches.push({ id: m.id, patch });
    return { ...m, ...patch };
  });
  // (A Supabase query only runs once it is awaited or then-ed.)
  for (const p of patches) void supabase.from("goal_measures").update(p.patch).eq("id", p.id).then(() => undefined);
  return out;
}

export async function loadEntries(measureIds: string[], since?: string): Promise<MeasureEntry[]> {
  if (!measureIds.length) return [];
  let q = supabase.from("measure_entries").select("*").in("measure_id", measureIds).order("logged_on").order("created_at");
  if (since) q = q.gte("logged_on", since);
  const [{ data, error }, counted] = await Promise.all([q, countedEntries(measureIds).catch(() => ({ ids: new Set<string>(), entries: [] as MeasureEntry[] }))]);
  const logged = error ? [] : ((data as MeasureEntry[]) ?? []).map((e) => ({ ...e, value: Number(e.value) }));
  // A counted number's value comes only from ticks (anything typed in by hand before is ignored).
  const all = [...logged.filter((e) => !counted.ids.has(e.measure_id)), ...counted.entries];
  return since ? all.filter((e) => e.logged_on >= since) : all;
}

/**
 * Entries for numbers that count an effort's ticks: one per ticked session, the
 * running total on that day (e.g. Oct 4 → 1, Oct 11 → 2).
 */
async function countedEntries(measureIds: string[]): Promise<{ ids: Set<string>; entries: MeasureEntry[] }> {
  const { data } = await supabase.from("goal_measures").select("id, goal_id, baseline, counts_measure_id").in("id", measureIds).not("counts_measure_id", "is", null);
  const links = (data as { id: string; goal_id: string; baseline: number | null; counts_measure_id: string }[]) ?? [];
  if (!links.length) return { ids: new Set(), entries: [] };
  const effortIds = [...new Set(links.map((l) => l.counts_measure_id))];
  const [hb, ef, gd] = await Promise.all([
    supabase.from("habits").select("id, measure_id").in("measure_id", effortIds),
    supabase.from("goal_measures").select("id, plan_mode, count_calendar_id, count_keyword").in("id", effortIds),
    supabase.from("goal_daily_items").select("id, goal_id, day, habit_id, source_item_id, done_at").in("goal_id", [...new Set(links.map((l) => l.goal_id))]).eq("done", true).order("day"),
  ]);
  const habitEffort = new Map(((hb.data as { id: string; measure_id: string }[]) ?? []).map((h) => [h.id, h.measure_id]));
  const efforts = (ef.data as { id: string; plan_mode: string | null; count_calendar_id: string | null; count_keyword: string | null }[]) ?? [];
  const countMode = new Set(efforts.filter((e) => e.plan_mode === "count").map((e) => e.id));
  type Item = { id: string; goal_id: string; day: string; habit_id: string | null; source_item_id: string | null; done_at: string | null };
  const items = (gd.data as Item[]) ?? [];
  // Counted efforts (e.g. runs from Runna): an event its calendar marks finished counts as ticked too.
  const finished = new Map<string, Item[]>();
  for (const e of efforts.filter((x) => x.plan_mode === "count" && x.count_calendar_id)) {
    const { data: mp } = await supabase.from("gcal_event_map").select("item_id").eq("calendar_id", e.count_calendar_id!);
    const ids = ((mp as { item_id: string | null }[]) ?? []).map((r) => r.item_id).filter((x): x is string => !!x);
    if (!ids.length) continue;
    const { data: fe } = await supabase.from("fixed_events").select("id, name, start_time").in("id", ids).eq("source_done", true);
    const kw = e.count_keyword?.trim().toLowerCase();
    const goalId = links.find((l) => l.counts_measure_id === e.id)!.goal_id;
    finished.set(
      e.id,
      ((fe as { id: string; name: string; start_time: string }[]) ?? [])
        .filter((f) => !kw || f.name.toLowerCase().includes(kw))
        .map((f) => {
          const d = new Date(f.start_time);
          const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
          return { id: `src-${f.id}`, goal_id: goalId, day, habit_id: null, source_item_id: f.id, done_at: f.start_time };
        })
    );
  }
  const unticked = new Set<string>();
  if (finished.size) {
    const { data: off } = await supabase.from("goal_daily_items").select("source_item_id").in("goal_id", [...new Set(links.map((l) => l.goal_id))]).eq("done", false).not("source_item_id", "is", null);
    for (const r of (off as { source_item_id: string }[]) ?? []) unticked.add(r.source_item_id);
  }
  const entries: MeasureEntry[] = [];
  for (const l of links) {
    const ticked = items.filter(
      (i) => i.goal_id === l.goal_id && ((i.habit_id && habitEffort.get(i.habit_id) === l.counts_measure_id) || (!i.habit_id && i.source_item_id && countMode.has(l.counts_measure_id)))
    );
    const seen = new Set(ticked.map((i) => i.source_item_id).filter(Boolean));
    const auto = (finished.get(l.counts_measure_id) ?? []).filter((f) => !seen.has(f.source_item_id) && !unticked.has(f.source_item_id!));
    const mine = [...ticked, ...auto].sort((a, b) => a.day.localeCompare(b.day));
    let n = Number(l.baseline ?? 0);
    for (const i of mine) {
      n += 1;
      entries.push({ id: `auto-${i.id}`, measure_id: l.id, goal_id: l.goal_id, value: n, logged_on: i.day, note: "counted from a ticked session", created_at: i.done_at ?? i.day });
    }
  }
  return { ids: new Set(links.map((l) => l.id)), entries };
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
    tolerance: p.tolerance ?? null,
    bankable: !!p.bankable,
    counts_measure_id: p.counts_measure_id ?? null,
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
        bankable: m.bankable,
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
  /** Missed, but by no more than the measure's close band. */
  close: boolean;
}

/** A checkpoint as it stands now: re-spread after an earlier one was missed. */
export interface PlannedCheckpoint extends Checkpoint {
  /** What you originally set. */
  original: number;
}

/**
 * The checkpoints as they stand. When one passes missed (or only close), the
 * later ones are re-spread from where you actually were, in the same shape as
 * before, so the gap is shared across the time left instead of landing on the
 * next checkpoint. The final target never moves. Beating one changes nothing.
 */
export function planCheckpoints(m: GoalMeasure, entries: MeasureEntry[], todayStr: string): { checkpoints: PlannedCheckpoint[]; past: CheckpointResult[]; anchor: { due: string; value: number } | null } {
  const cps: PlannedCheckpoint[] = m.checkpoints.map((c) => ({ ...c, original: c.target }));
  const final = m.target ?? cps[cps.length - 1]?.target ?? null;
  const tol = m.tolerance && m.tolerance > 0 ? m.tolerance : 0;
  const past: CheckpointResult[] = [];
  let anchor: { due: string; value: number } | null = null;
  for (let i = 0; i < cps.length; i++) {
    const c = cps[i];
    if (c.due >= todayStr) break;
    const v = [...entries].reverse().find((e) => e.logged_on <= c.due) ?? null;
    const met = v ? better(m, v.value, c.target) : null;
    const close = met === false && tol > 0 && Math.abs(v!.value - c.target) <= tol + 1e-9;
    past.push({ due: c.due, target: c.target, value: v?.value ?? null, met, close });
    if (v && met === false && final !== null) {
      const t0 = c.target;
      const a = v.value;
      for (let j = i + 1; j < cps.length; j++) {
        const f = final !== t0 ? (cps[j].target - t0) / (final - t0) : 1;
        cps[j] = { ...cps[j], target: Math.round((a + f * (final - a)) * 10) / 10 };
      }
      anchor = { due: c.due, value: a };
    }
  }
  return { checkpoints: cps, past, anchor };
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
  /** Behind, but within the close band of where you should be. */
  close: boolean;
  /** Later checkpoints re-spread after a missed one: { due, was, now }. */
  replanned: { due: string; was: number; now: number }[];
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
  const plan = planCheckpoints(m, entries, todayStr);
  const cps = plan.checkpoints;
  const next = cps.find((c) => c.due >= todayStr) ?? null;
  const prev = [...cps].reverse().find((c) => c.due < todayStr) ?? null;

  let expected: number | null = null;
  if (next) {
    const fromDate = prev ? parseDay(prev.due) : parseDay((entries[0]?.logged_on ?? m.created_at).slice(0, 10));
    // After a missed checkpoint the line starts from where you actually were.
    const fromVal = prev ? (plan.anchor && plan.anchor.due === prev.due ? plan.anchor.value : prev.target) : start;
    if (fromVal !== null) {
      const span = parseDay(next.due).getTime() - fromDate.getTime();
      const t = span > 0 ? Math.min(1, Math.max(0, (today.getTime() - fromDate.getTime()) / span)) : 1;
      expected = fromVal + (next.target - fromVal) * t;
    }
  }
  const onTrack = latest && next ? better(m, latest.value, next.target) || (expected !== null && better(m, latest.value, expected)) : null;
  const tol = m.tolerance && m.tolerance > 0 ? m.tolerance : 0;
  const close = onTrack === false && expected !== null && tol > 0 && Math.abs(latest!.value - expected) <= tol + 1e-9;
  const replanned = cps.filter((c) => c.due >= todayStr && c.target !== c.original).map((c) => ({ due: c.due, was: c.original, now: c.target }));
  const progress = latest && start !== null && m.target !== null && m.target !== start ? (latest.value - start) / (m.target - start) : null;

  const past = plan.past;

  const ps = m.log_every ? periodStart(m, today) : null;
  // A counted number fills itself in from ticks: nothing to log.
  const due = !m.counts_measure_id && !!ps && !entries.some((e) => e.logged_on >= ps);
  return {
    latest,
    change,
    next,
    daysToNext: next ? Math.round((parseDay(next.due).getTime() - today.getTime()) / DAY) : null,
    expected,
    onTrack,
    close,
    replanned,
    progress,
    past,
    due,
    dueSince: due ? ps : null,
    entries,
  };
}

export const checkpointWord = (c: CheckpointResult) => (c.met === null ? "not logged" : c.met ? "met" : c.close ? "close" : "missed");

/** One line for the Briefing facts and the Review ("Weight: 207.4 lb on Sep 27 …"). */
export function outcomeFact(m: GoalMeasure, s: OutcomeStatus, day: (iso: string) => string = (x) => x): string {
  const unit = m.unit ? ` ${m.unit}` : "";
  const cmp = m.direction === "up" ? "≥" : "≤";
  if (!s.latest) {
    return `${m.label}: nothing logged yet${s.next ? `; next checkpoint ${cmp} ${fmt(s.next.target)}${unit} by ${day(s.next.due)}` : ""}`;
  }
  const parts = [`${m.label}: latest logged ${fmt(s.latest.value)}${unit} on ${day(s.latest.logged_on)}`];
  if (s.change !== null && m.baseline !== null) parts.push(`${s.change >= 0 ? "+" : ""}${fmt(Math.round(s.change * 10) / 10)}${unit} since the ${fmt(m.baseline)}${unit} baseline`);
  if (s.next) parts.push(`next checkpoint ${cmp} ${fmt(s.next.target)}${unit} by ${day(s.next.due)} (${s.daysToNext} days): ${s.onTrack ? "on track" : s.close ? "close" : "behind"}`);
  const lastPast = s.past[s.past.length - 1];
  if (lastPast) parts.push(`checkpoint ${cmp} ${fmt(lastPast.target)}${unit} on ${day(lastPast.due)} was ${checkpointWord(lastPast)}`);
  if (s.replanned.length) parts.push(`later checkpoints re-planned from the actual number (${s.replanned.map((r) => `${day(r.due)} now ${cmp} ${fmt(r.now)}${unit}, was ${fmt(r.was)}${unit}`).join("; ")})`);
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

  // The line to follow: start → checkpoints → target on the deadline. After a
  // missed checkpoint it restarts from the number you actually logged there.
  const plan = planCheckpoints(m, entries, formatLocalDate(today));
  const lineStart = plan.anchor ? { t: parseDay(plan.anchor.due).getTime(), v: plan.anchor.value } : { t: startDate.getTime(), v: startValue };
  const pts: { t: number; v: number }[] = [lineStart];
  for (const c of plan.checkpoints) {
    const t = parseDay(c.due).getTime();
    if (t > lineStart.t && t < endDate.getTime()) pts.push({ t, v: c.target });
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

// ---------------------------------------------------------------------------
// Goal checkpoints that track a logged number close themselves once their date passes.

/** The outcome measure (and its checkpoint) a goal checkpoint on this date tracks, if any. */
export function measuredCheckpoint(outcomes: GoalMeasure[], due: string): GoalMeasure | null {
  return outcomes.find((m) => m.kind === "outcome" && m.checkpoints.some((c) => c.due === due)) ?? null;
}

/**
 * Past-due goal checkpoints that match a logged number's checkpoint (same date)
 * are marked done with how they went (met / close / missed, and the number), so
 * a missed one leaves "coming up" instead of lingering. Returns the updated list,
 * or null when nothing changed. Checkpoints with no number logged by their date
 * stay open.
 */
export function resolveMilestones<T extends { id: string; due: string; done: boolean; result?: "met" | "close" | "missed" | null; value?: number | null }>(
  milestones: T[],
  outcomes: GoalMeasure[],
  entries: MeasureEntry[],
  now = new Date()
): T[] | null {
  const todayStr = formatLocalDate(new Date(now.getFullYear(), now.getMonth(), now.getDate()));
  let changed = false;
  const next = milestones.map((ms) => {
    if (ms.done || ms.due >= todayStr) return ms;
    const m = measuredCheckpoint(outcomes, ms.due);
    if (!m) return ms;
    const mine = entries.filter((e) => e.measure_id === m.id).sort((a, b) => a.logged_on.localeCompare(b.logged_on) || a.created_at.localeCompare(b.created_at));
    const r = planCheckpoints(m, mine, todayStr).past.find((c) => c.due === ms.due);
    if (!r || r.met === null) return ms;
    changed = true;
    return { ...ms, done: true, result: r.met ? "met" : r.close ? "close" : "missed", value: r.value };
  });
  return changed ? next : null;
}

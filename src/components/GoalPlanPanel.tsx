import { useCallback, useEffect, useState } from "react";
import { Activity, Archive, Check, Loader2, Pencil, Plus, Sparkles, Target, X } from "lucide-react";
import { supabase } from "@/lib/supabase";
import type { ContextTag } from "@/lib/types";
import { EFFORTS, EFFORT_LABELS, type Effort } from "@/lib/effort";
import {
  PLAN_GOAL_COLUMNS,
  setMilestoneDone,
  type Milestone,
  type MilestoneLevel,
  type PlanGoal,
  type PlanMode,
  type PreferredTime,
} from "@/lib/goalPlanning";
import {
  WEEKDAYS,
  describeEffort,
  describeOutcome,
  loadEntries,
  loadMeasures,
  saveMeasure,
  saveSuggestions,
  setMeasureStatus,
  splitHours,
  type Checkpoint,
  type GoalMeasure,
  type MeasureEntry,
  type NewMeasure,
} from "@/lib/measures";
import { OutcomeTracker } from "@/components/MeasureWidgets";

const RESEARCH_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/goal-research`;
const HEADERS = {
  Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
  "Content-Type": "application/json",
};

const LEVEL_LABEL: Record<MilestoneLevel, string> = { year: "Yearly", quarter: "Quarterly", month: "Monthly", week: "Weekly" };
const CONTEXTS: ContextTag[] = ["desk", "home", "phone", "errand", "other"];
const TIMES: { v: PreferredTime; l: string }[] = [
  { v: "any", l: "Any time" },
  { v: "morning", l: "Morning (06–12)" },
  { v: "afternoon", l: "Afternoon (12–17)" },
  { v: "evening", l: "Evening (17–22)" },
];

interface CalendarOption {
  calendar_id: string;
  name: string;
}

async function callResearch<T>(body: Record<string, unknown>): Promise<T> {
  const res = await fetch(RESEARCH_URL, { method: "POST", headers: HEADERS, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error || `Request failed (${res.status})`);
  return data as T;
}

function blankMeasure(goalId: string, kind: "effort" | "outcome", position: number): Partial<GoalMeasure> & { goal_id: string } {
  return {
    goal_id: goalId,
    kind,
    status: "active",
    position,
    label: "",
    why: null,
    plan_mode: kind === "effort" ? "schedule" : null,
    sessions_per_week: kind === "effort" ? 3 : null,
    session_minutes: kind === "effort" ? 60 : null,
    hours_per_week: null,
    context: kind === "effort" ? "desk" : null,
    preferred_time: "any",
    effort: null,
    count_calendar_id: null,
    count_keyword: null,
    unit: null,
    direction: kind === "outcome" ? "down" : null,
    baseline: null,
    target: null,
    log_every: kind === "outcome" ? "weekly" : null,
    log_weekday: kind === "outcome" ? 0 : null,
    checkpoints: [],
  };
}

/**
 * Cascade for one active goal: checkpoints, and the measures that show whether
 * it's working — effort you put in each week (scheduled or counted) and
 * numbers you log (outcomes). The planner suggests them; you decide.
 */
export function GoalPlanPanel({ goalId }: { goalId: string }) {
  const [goal, setGoal] = useState<PlanGoal | null>(null);
  const [calendars, setCalendars] = useState<CalendarOption[]>([]);
  const [measures, setMeasures] = useState<GoalMeasure[]>([]);
  const [entries, setEntries] = useState<MeasureEntry[]>([]);
  const [generating, setGenerating] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [planModel, setPlanModel] = useState<string | null>(null);
  const [editing, setEditing] = useState<(Partial<GoalMeasure> & { goal_id: string }) | null>(null);

  const reload = useCallback(async () => {
    const [g, c, ms] = await Promise.all([
      supabase.from("goals").select(PLAN_GOAL_COLUMNS).eq("id", goalId).maybeSingle(),
      supabase.from("calendar_connections").select("calendar_id, name, role, enabled"),
      loadMeasures([goalId]),
    ]);
    if (g.data) setGoal(g.data as PlanGoal);
    const seen = new Set<string>();
    setCalendars(
      ((c.data as (CalendarOption & { role: string; enabled: boolean })[]) ?? []).filter(
        (x) => x.enabled && x.role !== "schedule_target" && !seen.has(x.calendar_id) && seen.add(x.calendar_id)
      )
    );
    setMeasures(ms);
    setEntries(await loadEntries(ms.filter((m) => m.kind === "outcome").map((m) => m.id)));
  }, [goalId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function suggest() {
    setSuggesting(true);
    setError(null);
    try {
      const data = await callResearch<{ measures: Partial<NewMeasure>[]; model?: string }>({
        action: "measures",
        goal_id: goalId,
        calendars: calendars.map((c) => ({ id: c.calendar_id, name: c.name })),
      });
      if (data.model) setPlanModel(data.model);
      const maxPos = measures.reduce((a, m) => Math.max(a, m.position), 0);
      await saveSuggestions(goalId, data.measures ?? [], maxPos);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't suggest measures");
    } finally {
      setSuggesting(false);
    }
  }

  async function generate() {
    setGenerating(true);
    setError(null);
    try {
      const data = await callResearch<{ model?: string }>({ action: "cascade", goal_id: goalId });
      setPlanModel(typeof data.model === "string" ? data.model : null);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't generate the plan");
      setGenerating(false);
      return;
    }
    setGenerating(false);
    // A new plan comes with fresh measure suggestions.
    await suggest();
  }

  async function setStatus(m: GoalMeasure, status: GoalMeasure["status"]) {
    setError(null);
    try {
      await setMeasureStatus(m, status);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save");
    }
  }

  async function toggle(m: Milestone) {
    if (!goal) return;
    const next = await setMilestoneDone(goal, m.id, !m.done);
    setGoal({ ...goal, milestones: next });
  }

  if (!goal) return null;
  const hasPlan = !!goal.cascade_generated_at;
  const milestones = goal.milestones ?? [];
  const active = measures.filter((m) => m.status === "active");
  const suggested = measures.filter((m) => m.status === "suggested");
  const calName = (id: string | null) => calendars.find((c) => c.calendar_id === id)?.name;
  const nextPos = measures.reduce((a, m) => Math.max(a, m.position), 0) + 1;

  return (
    <div className="mt-4 rounded-xl border border-slate-700 bg-slate-900/60 p-4">
      <div className="flex items-center justify-between gap-2 mb-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-100">Plan</h2>
          <p className="text-xs text-slate-400">
            {hasPlan ? "Checkpoints stay in the app; the weekly effort reaches your calendar." : "Break this goal into checkpoints and ways to measure progress."}
          </p>
        </div>
        <button
          onClick={generate}
          disabled={generating || suggesting}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 text-white text-sm hover:bg-blue-500 disabled:opacity-50 whitespace-nowrap"
        >
          {generating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
          {hasPlan ? "Regenerate" : "Generate plan"}
        </button>
      </div>

      {error && <p className="text-sm text-rose-300 mb-2">{error}</p>}
      {planModel && <p className="text-[11px] text-slate-500 mb-2">Written by {planModel}</p>}

      {hasPlan && (
        <>
          {goal.deadline && (
            <p className="text-xs text-slate-400 mb-2">
              Deadline {new Date(goal.deadline).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" })}
            </p>
          )}
          <div className="space-y-1 mb-4">
            {milestones.map((m) => (
              <label key={m.id} className="flex items-start gap-2 text-sm py-0.5 cursor-pointer">
                <input type="checkbox" checked={m.done} onChange={() => toggle(m)} className="mt-1 accent-blue-600" />
                <span className="w-16 shrink-0 text-[11px] uppercase tracking-wide text-slate-500 pt-0.5">{LEVEL_LABEL[m.level]}</span>
                <span className="w-14 shrink-0 tabular-nums text-xs text-slate-400 pt-0.5">{m.due.slice(5)}</span>
                <span className={m.done ? "text-slate-500 line-through" : "text-slate-200"}>{m.title}</span>
              </label>
            ))}
          </div>
        </>
      )}

      {/* Measures */}
      <div className="border-t border-slate-800 pt-3">
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <div className="mr-auto">
            <div className="text-sm font-semibold text-slate-100">How progress is measured</div>
            <div className="text-[11px] text-slate-400">Effort you put in each week, and numbers you log to see if it's working.</div>
          </div>
          <button onClick={suggest} disabled={suggesting || generating} className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-slate-800 text-xs text-slate-200 hover:bg-slate-700 disabled:opacity-50">
            {suggesting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />} Suggest measures
          </button>
          <button onClick={() => setEditing(blankMeasure(goalId, "effort", nextPos))} className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-slate-800 text-xs text-slate-200 hover:bg-slate-700">
            <Plus className="w-3.5 h-3.5" /> Effort
          </button>
          <button onClick={() => setEditing(blankMeasure(goalId, "outcome", nextPos))} className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-slate-800 text-xs text-slate-200 hover:bg-slate-700">
            <Plus className="w-3.5 h-3.5" /> Number to log
          </button>
        </div>

        {editing && (
          <MeasureEditor
            draft={editing}
            calendars={calendars}
            onCancel={() => setEditing(null)}
            onSaved={async () => {
              setEditing(null);
              await reload();
            }}
          />
        )}

        {suggested.length > 0 && (
          <div className="mb-3 space-y-2">
            <p className="text-[11px] uppercase tracking-wide text-slate-500">Suggested — accept, edit or dismiss</p>
            {suggested.map((m) => (
              <div key={m.id} className="rounded-lg border border-dashed border-blue-500/40 bg-blue-500/5 p-3">
                <div className="flex items-start gap-2">
                  {m.kind === "effort" ? <Activity className="w-4 h-4 mt-0.5 text-blue-300 shrink-0" /> : <Target className="w-4 h-4 mt-0.5 text-blue-300 shrink-0" />}
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-slate-100">
                      <span className="font-medium">{m.label}</span>{" "}
                      <span className="text-xs text-slate-400">· {m.kind === "effort" ? "effort" : "number to log"}</span>
                    </div>
                    <div className="text-xs text-slate-300 mt-0.5">{m.kind === "effort" ? describeEffort(m, calName(m.count_calendar_id)) : describeOutcome(m)}</div>
                    {m.kind === "outcome" && m.checkpoints.length > 0 && (
                      <div className="text-[11px] text-slate-400 mt-0.5">
                        Checkpoints: {m.checkpoints.map((c) => `${c.due.slice(5)} ${m.direction === "up" ? "≥" : "≤"} ${c.target}${m.unit ? ` ${m.unit}` : ""}`).join(" · ")}
                      </div>
                    )}
                    {m.why && <div className="text-[11px] text-slate-500 mt-1">{m.why}</div>}
                  </div>
                </div>
                <div className="mt-2 flex gap-2">
                  <button onClick={() => setStatus(m, "active")} className="flex items-center gap-1 rounded-lg bg-blue-600 px-2.5 py-1 text-xs text-white hover:bg-blue-500">
                    <Check className="w-3.5 h-3.5" /> Accept
                  </button>
                  <button onClick={() => setEditing(m)} className="flex items-center gap-1 rounded-lg bg-slate-800 px-2.5 py-1 text-xs text-slate-200 hover:bg-slate-700">
                    <Pencil className="w-3.5 h-3.5" /> Edit
                  </button>
                  <button onClick={() => setStatus(m, "archived")} className="flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs text-slate-400 hover:bg-slate-800">
                    <X className="w-3.5 h-3.5" /> Dismiss
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {active.length === 0 && suggested.length === 0 && !editing && (
          <p className="text-xs text-slate-500">No measures yet. Tap Suggest measures, or add one yourself.</p>
        )}

        <div className="space-y-2">
          {active.map((m) =>
            m.kind === "effort" ? (
              <div key={m.id} className="rounded-lg border border-slate-700 bg-slate-800/50 p-3">
                <div className="flex items-start gap-2">
                  <Activity className="w-4 h-4 mt-0.5 text-blue-300 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-slate-100">{m.label}</div>
                    <div className="text-xs text-slate-300 mt-0.5">{describeEffort(m, calName(m.count_calendar_id))}</div>
                    <div className="text-[11px] text-slate-500 mt-0.5">
                      {m.plan_mode === "schedule"
                        ? `${m.context ? m.context[0].toUpperCase() + m.context.slice(1) : "Other"} · ${TIMES.find((t) => t.v === m.preferred_time)?.l ?? "Any time"}${m.effort ? ` · ${EFFORT_LABELS[m.effort]}` : ""}`
                        : "Counts events already on that calendar each week"}
                    </div>
                  </div>
                  <MeasureActions onEdit={() => setEditing(m)} onArchive={() => setStatus(m, "archived")} />
                </div>
              </div>
            ) : (
              <div key={m.id} className="relative">
                <OutcomeTracker measure={m} entries={entries} onChange={setEntries} showHistory />
                <div className="absolute top-2 right-2">
                  <MeasureActions onEdit={() => setEditing(m)} onArchive={() => setStatus(m, "archived")} small />
                </div>
              </div>
            )
          )}
        </div>
      </div>
    </div>
  );
}

function MeasureActions({ onEdit, onArchive, small }: { onEdit: () => void; onArchive: () => void; small?: boolean }) {
  const [confirm, setConfirm] = useState(false);
  return (
    <div className={`flex items-center gap-0.5 ${small ? "bg-slate-800/90 rounded-md" : ""}`}>
      <button onClick={onEdit} className="p-1 rounded hover:bg-slate-700" aria-label="Edit measure" title="Edit">
        <Pencil className="w-3.5 h-3.5 text-slate-400" />
      </button>
      {confirm ? (
        <button onClick={onArchive} className="rounded bg-rose-600 px-1.5 py-0.5 text-[11px] text-white">Remove</button>
      ) : (
        <button onClick={() => setConfirm(true)} className="p-1 rounded hover:bg-slate-700" aria-label="Remove measure" title="Remove (history is kept)">
          <Archive className="w-3.5 h-3.5 text-slate-400" />
        </button>
      )}
    </div>
  );
}

function MeasureEditor({
  draft: initial,
  calendars,
  onCancel,
  onSaved,
}: {
  draft: Partial<GoalMeasure> & { goal_id: string };
  calendars: CalendarOption[];
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [d, setD] = useState(initial);
  const [hours, setHours] = useState<string>(initial.hours_per_week ? String(initial.hours_per_week) : "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<GoalMeasure>) => setD((x) => ({ ...x, ...patch }));
  const isEffort = d.kind === "effort";
  const field = "w-full rounded-lg bg-slate-950 border border-slate-700 px-2 py-1.5 text-sm text-slate-100";
  const numOrNull = (v: string) => (v.trim() === "" || Number.isNaN(Number(v)) ? null : Number(v));

  function applyHours(h: string) {
    setHours(h);
    const n = numOrNull(h);
    if (n && n > 0) {
      const split = splitHours(n, d.sessions_per_week);
      set({ hours_per_week: n, sessions_per_week: split.sessions, session_minutes: split.minutes });
    } else set({ hours_per_week: null });
  }

  async function save() {
    setError(null);
    if (!d.label?.trim()) return setError("Give it a name.");
    if (isEffort && !(d.sessions_per_week && d.sessions_per_week > 0)) return setError("How many times a week?");
    if (isEffort && d.plan_mode === "count" && !d.count_calendar_id) return setError("Pick the calendar to count from.");
    if (!isEffort && d.target === null && !(d.checkpoints ?? []).length) return setError("Set a target or at least one checkpoint.");
    setSaving(true);
    try {
      await saveMeasure({ ...d, label: d.label.trim(), status: d.status === "suggested" || !d.status ? "active" : d.status });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save");
    } finally {
      setSaving(false);
    }
  }

  const cps: Checkpoint[] = d.checkpoints ?? [];

  return (
    <div className="mb-3 rounded-lg border border-blue-500/40 bg-slate-950/60 p-3 space-y-3">
      <div className="text-xs font-semibold text-slate-300">{isEffort ? "Effort — something you do each week" : "Number to log — shows whether it's working"}</div>
      <label className="block text-xs text-slate-400">
        Name
        <input className={`${field} mt-1`} value={d.label ?? ""} placeholder={isEffort ? "e.g. Task block, Email check, Run" : "e.g. Weight, Open tasks, Inbox count"} onChange={(e) => set({ label: e.target.value })} />
      </label>

      {isEffort ? (
        <>
          <div className="grid grid-cols-2 gap-2">
            {(["schedule", "count"] as PlanMode[]).map((mode) => (
              <button
                key={mode}
                onClick={() => set({ plan_mode: mode })}
                className={`rounded-lg border px-3 py-2 text-left text-xs ${d.plan_mode === mode ? "border-blue-500 bg-blue-500/10 text-blue-200" : "border-slate-700 bg-slate-800 text-slate-300 hover:border-slate-600"}`}
              >
                <div className="font-semibold">{mode === "schedule" ? "App schedules them" : "Count from a calendar"}</div>
                <div className="text-[11px] text-slate-400 mt-0.5">{mode === "schedule" ? "Finds free time for each session." : "Sessions already arrive (e.g. Runna)."}</div>
              </button>
            ))}
          </div>
          {d.plan_mode === "schedule" ? (
            <>
              <div className="grid grid-cols-3 gap-2">
                <label className="text-xs text-slate-400">
                  Hours / week
                  <input className={`${field} mt-1`} type="number" min={0} step={0.5} value={hours} placeholder="e.g. 4" onChange={(e) => applyHours(e.target.value)} />
                </label>
                <label className="text-xs text-slate-400">
                  Sessions / week
                  <input
                    className={`${field} mt-1`}
                    type="number"
                    min={1}
                    max={14}
                    value={d.sessions_per_week ?? ""}
                    onChange={(e) => {
                      const n = numOrNull(e.target.value);
                      const h = numOrNull(hours);
                      if (n && h) set({ sessions_per_week: n, session_minutes: splitHours(h, n).minutes });
                      else set({ sessions_per_week: n });
                    }}
                  />
                </label>
                <label className="text-xs text-slate-400">
                  Minutes each
                  <input className={`${field} mt-1`} type="number" min={5} step={5} value={d.session_minutes ?? ""} onChange={(e) => { setHours(""); set({ session_minutes: numOrNull(e.target.value), hours_per_week: null }); }} />
                </label>
              </div>
              {d.sessions_per_week && d.session_minutes ? (
                <p className="text-[11px] text-slate-500">
                  {d.sessions_per_week} × {d.session_minutes} min = {Math.round(((d.sessions_per_week * d.session_minutes) / 60) * 10) / 10} h a week
                </p>
              ) : null}
              <div className="grid grid-cols-3 gap-2">
                <label className="text-xs text-slate-400">
                  Where
                  <select className={`${field} mt-1`} value={d.context ?? "other"} onChange={(e) => set({ context: e.target.value as ContextTag })}>
                    {CONTEXTS.map((c) => (
                      <option key={c} value={c}>{c[0].toUpperCase() + c.slice(1)}</option>
                    ))}
                  </select>
                </label>
                <label className="text-xs text-slate-400">
                  Time of day
                  <select className={`${field} mt-1`} value={d.preferred_time ?? "any"} onChange={(e) => set({ preferred_time: e.target.value as PreferredTime })}>
                    {TIMES.map((t) => (
                      <option key={t.v} value={t.v}>{t.l}</option>
                    ))}
                  </select>
                </label>
                <label className="text-xs text-slate-400">
                  Effort
                  <select className={`${field} mt-1`} value={d.effort ?? ""} onChange={(e) => set({ effort: (e.target.value || null) as Effort | null })}>
                    <option value="">Guess</option>
                    {EFFORTS.map((x) => (
                      <option key={x} value={x}>{EFFORT_LABELS[x]}</option>
                    ))}
                  </select>
                </label>
              </div>
            </>
          ) : (
            <div className="grid grid-cols-3 gap-2">
              <label className="text-xs text-slate-400">
                Times / week
                <input className={`${field} mt-1`} type="number" min={1} max={14} value={d.sessions_per_week ?? ""} onChange={(e) => set({ sessions_per_week: numOrNull(e.target.value) })} />
              </label>
              <label className="text-xs text-slate-400">
                Calendar
                <select className={`${field} mt-1`} value={d.count_calendar_id ?? ""} onChange={(e) => set({ count_calendar_id: e.target.value || null })}>
                  <option value="">Choose…</option>
                  {calendars.map((c) => (
                    <option key={c.calendar_id} value={c.calendar_id}>{c.name}</option>
                  ))}
                </select>
              </label>
              <label className="text-xs text-slate-400">
                Titles containing
                <input className={`${field} mt-1`} placeholder="optional" value={d.count_keyword ?? ""} onChange={(e) => set({ count_keyword: e.target.value || null })} />
              </label>
            </div>
          )}
        </>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2">
            <label className="text-xs text-slate-400">
              Unit
              <input className={`${field} mt-1`} placeholder="lb, tasks, %" value={d.unit ?? ""} onChange={(e) => set({ unit: e.target.value || null })} />
            </label>
            <label className="text-xs text-slate-400">
              Starting value
              <input className={`${field} mt-1`} type="number" step="any" value={d.baseline ?? ""} onChange={(e) => set({ baseline: numOrNull(e.target.value) })} />
            </label>
            <label className="text-xs text-slate-400">
              Target
              <input className={`${field} mt-1`} type="number" step="any" value={d.target ?? ""} onChange={(e) => set({ target: numOrNull(e.target.value) })} />
            </label>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <label className="text-xs text-slate-400">
              Better is
              <select className={`${field} mt-1`} value={d.direction ?? "down"} onChange={(e) => set({ direction: e.target.value as "down" | "up" })}>
                <option value="down">Lower</option>
                <option value="up">Higher</option>
              </select>
            </label>
            <label className="text-xs text-slate-400">
              Log it
              <select className={`${field} mt-1`} value={d.log_every ?? "weekly"} onChange={(e) => set({ log_every: e.target.value as "daily" | "weekly" | "monthly" })}>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
              </select>
            </label>
            {d.log_every === "weekly" && (
              <label className="text-xs text-slate-400">
                On
                <select className={`${field} mt-1`} value={d.log_weekday ?? 0} onChange={(e) => set({ log_weekday: Number(e.target.value) })}>
                  {WEEKDAYS.map((w, i) => (
                    <option key={w} value={i}>{w}</option>
                  ))}
                </select>
              </label>
            )}
          </div>
          <div>
            <div className="text-xs text-slate-400 mb-1">Checkpoints</div>
            <div className="space-y-1.5">
              {cps.map((c, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input type="date" className={`${field} w-40`} value={c.due} onChange={(e) => set({ checkpoints: cps.map((x, j) => (j === i ? { ...x, due: e.target.value } : x)) })} />
                  <span className="text-xs text-slate-500">{d.direction === "up" ? "≥" : "≤"}</span>
                  <input type="number" step="any" className={`${field} w-28`} value={Number.isFinite(c.target) ? c.target : ""} onChange={(e) => set({ checkpoints: cps.map((x, j) => (j === i ? { ...x, target: Number(e.target.value) } : x)) })} />
                  <span className="text-xs text-slate-500">{d.unit ?? ""}</span>
                  <button onClick={() => set({ checkpoints: cps.filter((_, j) => j !== i) })} className="p-1 rounded hover:bg-slate-800" aria-label="Remove checkpoint">
                    <X className="w-3.5 h-3.5 text-slate-500" />
                  </button>
                </div>
              ))}
              <button onClick={() => set({ checkpoints: [...cps, { due: "", target: d.target ?? 0 }] })} className="text-xs text-blue-400 hover:underline">
                + Add checkpoint
              </button>
            </div>
          </div>
        </>
      )}

      {error && <p className="text-xs text-rose-300">{error}</p>}
      <div className="flex justify-end gap-2">
        <button onClick={onCancel} className="px-3 py-1.5 rounded-lg text-sm text-slate-300 hover:bg-slate-800">Cancel</button>
        <button onClick={() => void save()} disabled={saving} className="px-3 py-1.5 rounded-lg bg-blue-600 text-sm text-white hover:bg-blue-500 disabled:opacity-50">
          {saving ? "Saving…" : initial.status === "suggested" ? "Save & accept" : "Save"}
        </button>
      </div>
    </div>
  );
}
